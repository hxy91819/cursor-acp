import { fork } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteLocalAgentStore } from "@cursor/sdk/sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SdkRunOwnership } from "../cursor-sdk-run-ownership.js";

const agentId = "agent-ownership-test";
const runId = "run-ownership-test";
let workspace: string;
let storage: SqliteLocalAgentStore;
const owners: SdkRunOwnership[] = [];
async function open() {
	const owner = await SdkRunOwnership.open(workspace);
	owners.push(owner);
	return owner;
}
async function seed(owner: SdkRunOwnership) {
	await owner.store.agents.create({
		agent: {
			agentId,
			cwd: workspace,
			status: "running",
			activeRunId: runId,
			createdAt: 1,
			updatedAt: 1,
			latestCheckpoint: { schemaVersion: 1, rootBlobId: "checkpoint" },
		},
	});
	await owner.store.runs.create({
		run: {
			agentId,
			runId,
			status: "running",
			turnNumber: 1,
			createdAt: 1,
			updatedAt: 1,
		},
	});
	await owner.store.checkpoints.create({
		agentId,
		blobId: "checkpoint",
		data: new Uint8Array([1, 2, 3]),
	});
	await owner.store.runEvents.append({
		runId,
		eventType: "assistant",
		payload: { text: "remembered history" },
	});
}
function ownerDirectory() {
	return join(
		storage.stateRoot,
		"acp-run-owners",
		createHash("sha256").update(agentId).digest("hex"),
	);
}

beforeEach(async () => {
	workspace = mkdtempSync(join(tmpdir(), "cursor-sdk-owner-"));
	storage = await SqliteLocalAgentStore.open({ workspaceRef: workspace });
});
afterEach(async () => {
	for (const owner of owners.splice(0)) {
		owner.release();
		owner.close();
	}
	await storage.dispose();
	rmSync(storage.stateRoot, { recursive: true, force: true });
	rmSync(workspace, { recursive: true, force: true });
});

describe("SDK run ownership", () => {
	it("keeps a live prompt exclusive, including another owner in the same process", async () => {
		const first = await open();
		await seed(first);
		await first.acquire(agentId);
		const second = await open();
		await expect(first.acquire(agentId)).rejects.toThrow("active ACP prompt");
		await expect(second.acquire(agentId)).rejects.toThrow("active ACP prompt");
		expect((await storage.runs.get({ agentId, runId }))?.status).toBe("running");
		await storage.runs.update({
			run: { ...(await storage.runs.get({ agentId, runId }))!, status: "finished" },
		});
		await storage.agents.update({
			agent: {
				...(await storage.agents.get({ agentId }))!,
				status: "idle",
				activeRunId: null,
			},
		});
		first.release();
		await second.acquire(agentId);
		expect((await storage.runs.get({ agentId, runId }))?.status).toBe("finished");
	});

	it("recovers an exact recorded run after SIGKILL without replacing checkpoint or history", async () => {
		const first = await open();
		await seed(first);
		await first.acquire(agentId);
		first.release();
		const child = fork(
			"-e",
			[
				`
			const {DatabaseSync} = require('node:sqlite');
			const db = new DatabaseSync(process.argv[1]);
			db.exec('BEGIN IMMEDIATE');
			process.send('locked');
			setInterval(() => {}, 1000);
		`,
				join(ownerDirectory(), "lock.db"),
			],
			{ silent: true },
		);
		try {
			await once(child, "message");
			const successor = await open();
			await expect(successor.acquire(agentId)).rejects.toThrow("active ACP prompt");
			child.kill("SIGKILL");
			await once(child, "exit");
			await successor.acquire(agentId);
			expect((await storage.runs.get({ agentId, runId }))?.status).toBe("cancelled");
			expect((await storage.agents.get({ agentId }))?.latestCheckpoint).toEqual({
				schemaVersion: 1,
				rootBlobId: "checkpoint",
			});
			expect(await storage.checkpoints.get({ agentId, blobId: "checkpoint" })).toEqual(
				new Uint8Array([1, 2, 3]),
			);
			expect((await storage.runEvents.list({ runId })).items).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ payload: { text: "remembered history" } }),
				]),
			);
			expect(
				(await storage.runs.list({ filter: { agentIds: [agentId] } })).items,
			).toHaveLength(1);
		} finally {
			child.kill("SIGKILL");
		}
	});

	it.each(["missing", "different-run"])(
		"leaves an active run with %s ownership untouched",
		async (kind) => {
			const first = await open();
			await seed(first);
			await first.acquire(agentId);
			first.release();
			if (kind === "missing") rmSync(join(ownerDirectory(), "run.json"));
			else
				writeFileSync(
					join(ownerDirectory(), "run.json"),
					JSON.stringify({ agentId, runId: "run-someone-else" }),
				);
			const successor = await open();
			await expect(successor.acquire(agentId)).rejects.toThrow("unknown ownership");
			expect((await storage.runs.get({ agentId, runId }))?.status).toBe("running");
			expect((await storage.agents.get({ agentId }))?.activeRunId).toBe(runId);
		},
	);

	it("records follow-up ownership before the SDK creates its run", async () => {
		const first = await open();
		await seed(first);
		await first.acquire(agentId);
		const nextRunId = "run-follow-up";
		await first.store.runs.create({
			run: {
				agentId,
				runId: nextRunId,
				status: "queued",
				turnNumber: 2,
				createdAt: 2,
				updatedAt: 2,
			},
		});
		await first.store.agents.update({
			agent: { ...(await storage.agents.get({ agentId }))!, activeRunId: nextRunId },
		});
		first.release();
		const successor = await open();
		await successor.acquire(agentId);
		expect((await storage.runs.get({ agentId, runId: nextRunId }))?.status).toBe("cancelled");
	});
});
