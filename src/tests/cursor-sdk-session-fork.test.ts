import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteLocalAgentStore } from "@cursor/sdk/sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cloneSdkSession } from "../cursor-sdk-session-fork.js";

describe("SDK checkpoint forks", () => {
	let directory: string;
	let source: SqliteLocalAgentStore;
	let target: SqliteLocalAgentStore;
	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "cursor-sdk-fork-"));
		source = await SqliteLocalAgentStore.open({
			workspaceRef: "/source",
			stateRoot: join(directory, "source"),
		});
		target = await SqliteLocalAgentStore.open({
			workspaceRef: "/child",
			stateRoot: join(directory, "target"),
		});
		await source.agents.create({
			agent: {
				agentId: "agent-parent",
				cwd: "/source",
				status: "idle",
				activeRunId: null,
				createdAt: 1,
				updatedAt: 2,
				latestCheckpoint: { schemaVersion: 1, rootBlobId: "root" },
				sdkMetadata: { opaque: "preserved" },
			},
		});
		await source.checkpoints.create({
			agentId: "agent-parent",
			blobId: "root",
			data: new Uint8Array([1, 2, 3]),
		});
		await source.checkpoints.create({
			agentId: "agent-parent",
			blobId: "dependency",
			data: new Uint8Array([7, 9]),
		});
	});
	afterEach(async () => {
		vi.restoreAllMocks();
		await source.dispose();
		await target.dispose();
		await rm(directory, { recursive: true, force: true });
	});

	it("copies every page of checkpoint blobs to an independent agent and survives reopen", async () => {
		const list = vi
			.spyOn(source.checkpoints, "list")
			.mockResolvedValueOnce({ items: ["dependency"], nextCursor: "dependency" })
			.mockResolvedValueOnce({ items: ["root"] });
		const id = await cloneSdkSession(source, target, "agent-parent", "/child");
		expect(list).toHaveBeenNthCalledWith(2, {
			filter: { agentIds: ["agent-parent"], cursor: "dependency" },
		});
		expect(id).toMatch(/^agent-/);
		expect(id).not.toBe("agent-parent");
		expect(await target.agents.get({ agentId: id })).toMatchObject({
			cwd: "/child",
			status: "idle",
			activeRunId: null,
			latestCheckpoint: { schemaVersion: 1, rootBlobId: "root" },
			sdkMetadata: { opaque: "preserved" },
		});
		expect(await target.checkpoints.get({ agentId: id, blobId: "dependency" })).toEqual(
			new Uint8Array([7, 9]),
		);
		await target.checkpoints.update({ agentId: id, blobId: "root", data: new Uint8Array([4]) });
		expect(await source.checkpoints.get({ agentId: "agent-parent", blobId: "root" })).toEqual(
			new Uint8Array([1, 2, 3]),
		);
		await target.dispose();
		target = await SqliteLocalAgentStore.open({
			workspaceRef: "/child",
			stateRoot: join(directory, "target"),
		});
		expect((await target.agents.get({ agentId: id }))?.latestCheckpoint?.rootBlobId).toBe(
			"root",
		);
		expect((await target.runs.list({ filter: { agentIds: [id] } })).items).toEqual([]);
	});

	it("also isolates forks inside the same store", async () => {
		const id = await cloneSdkSession(source, source, "agent-parent", "/source");
		await source.checkpoints.delete({ filter: { agentIds: [id] } });
		expect(
			await source.checkpoints.get({ agentId: "agent-parent", blobId: "dependency" }),
		).toEqual(new Uint8Array([7, 9]));
	});

	it("forks an immutable historical snapshot after the parent replaces its blobs and reopens", async () => {
		const snapshotId = await cloneSdkSession(source, source, "agent-parent", "/source");
		await source.checkpoints.delete({ filter: { agentIds: ["agent-parent"] } });
		await source.checkpoints.create({
			agentId: "agent-parent",
			blobId: "f00d",
			data: new Uint8Array([99]),
		});
		const parent = await source.agents.get({ agentId: "agent-parent" });
		if (!parent) throw new Error("missing fixture");
		await source.agents.update({
			agent: { ...parent, latestCheckpoint: { schemaVersion: 1, rootBlobId: "f00d" } },
		});
		await source.dispose();
		source = await SqliteLocalAgentStore.open({
			workspaceRef: "/source",
			stateRoot: join(directory, "source"),
		});
		const childId = await cloneSdkSession(source, target, snapshotId, "/child");
		expect((await target.agents.get({ agentId: childId }))?.latestCheckpoint?.rootBlobId).toBe(
			"root",
		);
		expect(await target.checkpoints.get({ agentId: childId, blobId: "root" })).toEqual(
			new Uint8Array([1, 2, 3]),
		);
		expect(await target.checkpoints.get({ agentId: childId, blobId: "dependency" })).toEqual(
			new Uint8Array([7, 9]),
		);
		expect(await target.checkpoints.get({ agentId: childId, blobId: "f00d" })).toBeNull();
	});

	it("rejects a missing source and active runs without creating a child", async () => {
		await expect(cloneSdkSession(source, target, "missing", "/child")).rejects.toThrow(
			"not found",
		);
		const row = await source.agents.get({ agentId: "agent-parent" });
		if (!row) throw new Error("missing fixture");
		await source.agents.update({ agent: { ...row, activeRunId: "run-active" } });
		await expect(cloneSdkSession(source, target, "agent-parent", "/child")).rejects.toThrow(
			"in progress",
		);
		expect((await target.agents.list()).items).toEqual([]);
	});

	it("removes partially copied blobs when the checkpoint root is missing", async () => {
		const row = await source.agents.get({ agentId: "agent-parent" });
		if (!row) throw new Error("missing fixture");
		await source.agents.update({
			agent: { ...row, latestCheckpoint: { schemaVersion: 1, rootBlobId: "missing-root" } },
		});
		await expect(cloneSdkSession(source, target, "agent-parent", "/child")).rejects.toThrow(
			"root is missing",
		);
		expect((await target.agents.list()).items).toEqual([]);
		expect((await target.checkpoints.list()).items).toEqual([]);
		expect(
			await source.checkpoints.get({ agentId: "agent-parent", blobId: "dependency" }),
		).not.toBeNull();
	});
});
