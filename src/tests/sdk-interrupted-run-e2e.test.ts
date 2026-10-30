import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Agent } from "@cursor/sdk";
import { SqliteLocalAgentStore } from "@cursor/sdk/sqlite";
import { expect, it } from "vitest";
import type { CursorStreamEvent, RunPromptResult } from "../cursor-runner.js";

const childSource = `
const {pathToFileURL} = require('node:url');
(async () => {
 const {CursorSdkRunner} = await import(pathToFileURL(process.argv[1]));
 const {Agent} = await import(pathToFileURL(process.argv[2]));
 const resume = Agent.resume.bind(Agent);
 let arrivals = 0; let release; const barrier = new Promise(resolve => { release = resolve; });
 Agent.resume = async (...args) => {
  const agent = await resume(...args);
  if (process.env.CURSOR_ACP_TEST_RESUME_BARRIER === '1') { if (++arrivals === 2) release(); await barrier; }
  return agent;
 };
 const runner = new CursorSdkRunner(undefined, console, async () => '');
 process.on('message', async options => {
  const prompt = runner.startPrompt({...options, modeId:'ask', modelId:'composer-2.5', fastValue:'false', onEvent:event => process.send({event})});
  process.send({requestId:options.requestId, result:await prompt.completed});
 });
 process.send({ready:true});
})();
`;

function start(workspace: string, resumeBarrier = false) {
	let requestId = 0;
	const child = fork(
		"-e",
		[
			childSource,
			resolve("dist/cursor-sdk-runner.js"),
			resolve("node_modules/@cursor/sdk/dist/esm/index.js"),
		],
		{
			cwd: workspace,
			env: { ...process.env, CURSOR_ACP_TEST_RESUME_BARRIER: resumeBarrier ? "1" : "0" },
			silent: true,
		},
	);
	child.stdout!.resume();
	child.stderr!.resume();
	const events: CursorStreamEvent[] = [];
	const ready = once(child, "message");
	child.on("message", (message: { event?: CursorStreamEvent }) => {
		if (message.event) events.push(message.event);
	});
	return {
		child,
		events,
		async send(prompt: string, agentId?: string): Promise<RunPromptResult> {
			await ready;
			const id = ++requestId;
			return await new Promise((resolveResult, reject) => {
				const receive = (message: { requestId?: number; result?: RunPromptResult }) => {
					if (message.requestId === id && message.result) {
						child.off("message", receive);
						child.off("exit", exited);
						resolveResult(message.result);
					}
				};
				const exited = () => {
					child.off("message", receive);
					reject(new Error("SDK owner process exited"));
				};
				child.on("message", receive);
				child.once("exit", exited);
				child.send({
					requestId: id,
					workspace,
					prompt,
					backendSessionId: agentId,
					sdkSessionId: agentId,
				});
			});
		},
	};
}
async function kill(child: ChildProcess) {
	if (child.exitCode !== null || child.signalCode !== null) return;
	child.kill("SIGKILL");
	await once(child, "exit");
}
function reply(result: RunPromptResult) {
	return result.events
		.filter((event) => event.type === "assistant")
		.map((event) => {
			const message = event.message as { content: { type: string; text?: string }[] };
			return message.content
				.filter((part) => part.type === "text")
				.map((part) => part.text)
				.join("");
		})
		.join("");
}

it.skipIf(process.env.CURSOR_ACP_E2E_REAL_MODEL !== "1")(
	"resumes the same real SDK agent after killing an active owner, without duplicate sends",
	async () => {
		const workspace = mkdtempSync(join(tmpdir(), "cursor-sdk-interruption-"));
		const storage = await SqliteLocalAgentStore.open({ workspaceRef: workspace });
		const children: ChildProcess[] = [];
		let agentId: string | undefined;
		try {
			const first = start(workspace);
			children.push(first.child);
			const initial = await first.send(
				"Remember the code ORCHID_RECOVERY_CHECK. Reply only ACK.",
			);
			expect(initial.exitCode).toBe(0);
			expect(reply(initial)).toContain("ACK");
			agentId = first.events.find((event) => event.subtype === "init")?.session_id as string;
			expect(agentId).toMatch(/^agent-/);
			// Normal same-agent continuation must not need recovery or replace the agent.
			const normal = await first.send(
				"What code did I give you? Reply only the code.",
				agentId,
			);
			expect(normal.exitCode).toBe(0);
			expect(reply(normal)).toContain("ORCHID_RECOVERY_CHECK");
			await kill(first.child);
			const interrupter = start(workspace, true);
			children.push(interrupter.child);
			const concurrent = [1, 2].map(() =>
				interrupter
					.send(
						"Write a numbered list of 10000 different English nouns, one per line. Start now.",
						agentId,
					)
					.catch(() => undefined),
			);
			const rejectedConcurrent = await Promise.race(concurrent);
			expect(rejectedConcurrent?.stderr).toContain("active ACP prompt");
			let activeRunId: string | undefined;
			for (let attempt = 0; attempt < 300; attempt++) {
				const runs = await Agent.listRuns(agentId!, { cwd: workspace });
				activeRunId = runs.items.find((run) => run.status === "running")?.id;
				if (activeRunId) break;
				await new Promise((resolveWait) => setTimeout(resolveWait, 100));
			}
			expect(activeRunId).toBeDefined();
			const competitor = start(workspace);
			children.push(competitor.child);
			const blocked = await competitor.send("Reply only SHOULD_NOT_RUN", agentId);
			expect(blocked.exitCode).toBe(1);
			expect(blocked.stderr).toContain("active ACP prompt");
			expect((await Agent.getRun(activeRunId!, { cwd: workspace })).status).toBe("running");
			expect((await Agent.listRuns(agentId!, { cwd: workspace })).items).toHaveLength(3);
			await kill(interrupter.child);
			await Promise.all(concurrent);
			const checkpoint = (await storage.agents.get({ agentId: agentId! }))!.latestCheckpoint;
			expect(checkpoint).toBeTruthy();
			const checkpointBytes = await storage.checkpoints.get({
				agentId: agentId!,
				blobId: checkpoint!.rootBlobId,
			});
			expect(checkpointBytes).not.toBeNull();

			expect((await Agent.getRun(activeRunId!, { cwd: workspace })).status).toBe("running");
			expect(
				(await storage.agents.get({ agentId: agentId! }))!.latestCheckpoint,
			).toBeTruthy();
			const restarted = start(workspace);
			children.push(restarted.child);
			const recovered = await restarted.send(
				"What code did I give you? Reply only the code.",
				agentId,
			);
			expect(recovered.exitCode, recovered.stderr).toBe(0);
			expect(
				await storage.checkpoints.get({
					agentId: agentId!,
					blobId: checkpoint!.rootBlobId,
				}),
			).toEqual(checkpointBytes);
			expect(reply(recovered)).toContain("ORCHID_RECOVERY_CHECK");
			expect(restarted.events.find((event) => event.subtype === "init")?.session_id).toBe(
				agentId,
			);
			expect((await Agent.getRun(activeRunId!, { cwd: workspace })).status).toBe("cancelled");
			const runs = (await Agent.listRuns(agentId!, { cwd: workspace })).items;
			expect(runs).toHaveLength(4);
			expect(runs.filter((run) => run.status === "finished")).toHaveLength(3);
			expect(runs.filter((run) => run.status === "running")).toHaveLength(0);
		} finally {
			await Promise.all(children.map(kill));
			if (agentId) {
				for (const run of (await Agent.listRuns(agentId, { cwd: workspace })).items) {
					if (run.status === "running") await run.cancel();
				}
			}
			await storage.dispose();
			rmSync(storage.stateRoot, { recursive: true, force: true });
			rmSync(workspace, { recursive: true, force: true });
		}
	},
	180_000,
);
