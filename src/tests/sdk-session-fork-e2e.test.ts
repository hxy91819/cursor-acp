import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDefaultSdkStateRoot } from "@cursor/sdk";
import { describe, expect, it, vi } from "vitest";
import { readSessionMeta, sessionFilePath } from "../session-storage.js";
import { spawnAcpChild, type AcpChildClient } from "./sdk-session-resume-harness.js";

describe.skipIf(process.env.CURSOR_ACP_E2E_REAL_MODEL !== "1")("Cursor SDK Fork E2E", () => {
	it("inherits context across workspaces and process restarts without sharing subsequent turns", async () => {
		const directory = await mkdtemp(join(tmpdir(), "cursor-acp-fork-e2e-"));
		const sourceCwd = join(directory, "source");
		const targetCwd = join(directory, "child");
		const configDir = join(directory, "config");
		vi.stubEnv("CURSOR_ACP_CONFIG_DIR", configDir);
		await mkdir(sourceCwd);
		await mkdir(targetCwd);
		const clients: AcpChildClient[] = [];
		const connect = async (cwd: string) => {
			const client = spawnAcpChild(cwd, configDir);
			clients.push(client);
			await client.sendRequest("initialize", { protocolVersion: 1, clientCapabilities: {} });
			return client;
		};
		try {
			const token = randomBytes(12).toString("hex");
			const parentToken = randomBytes(12).toString("hex");
			const childToken = randomBytes(12).toString("hex");
			const source = await connect(sourceCwd);
			const parent = await source.sendRequest<{ sessionId: string }>("session/new", {
				cwd: sourceCwd,
				mcpServers: [],
			});
			await source.sendRequest("session/set_mode", {
				sessionId: parent.sessionId,
				modeId: "ask",
			});
			await source.sendRequest("session/set_config_option", {
				sessionId: parent.sessionId,
				configId: "model",
				value: "composer-2.5",
			});
			const first = await source.sendPrompt(
				parent.sessionId,
				`For this conversation, the current secret token is ${token}. Remember it. Reply only ACK. Do not use tools.`,
			);
			await source.kill();
			const fork = await connect(targetCwd);
			const child = await fork.sendRequest<{ sessionId: string }>("session/fork", {
				sessionId: parent.sessionId,
				cwd: targetCwd,
				mcpServers: [],
			});
			const parentMeta = await readSessionMeta(sessionFilePath(sourceCwd, parent.sessionId));
			const childMeta = await readSessionMeta(sessionFilePath(targetCwd, child.sessionId));
			expect(childMeta.sdkSessionId).toMatch(/^agent-/);
			expect(childMeta.sdkSessionId).not.toBe(parentMeta.sdkSessionId);
			await fork.kill();
			const resumedParent = await connect(sourceCwd);
			await resumedParent.sendRequest("session/load", {
				sessionId: parent.sessionId,
				cwd: sourceCwd,
				mcpServers: [],
			});
			await resumedParent.waitForReplayedHistory(first.reply);
			await resumedParent.sendPrompt(
				parent.sessionId,
				`Replace the current secret token with ${parentToken}. Reply only ACK. Do not use tools.`,
			);
			const resumedChild = await connect(targetCwd);
			await resumedChild.sendRequest("session/load", {
				sessionId: child.sessionId,
				cwd: targetCwd,
				mcpServers: [],
			});
			await resumedChild.waitForReplayedHistory(first.reply);
			const inherited = await resumedChild.sendPrompt(
				child.sessionId,
				"What is the current secret token? Reply only the token. Do not use tools.",
			);
			expect(inherited.reply.trim()).toBe(token);
			await resumedChild.sendPrompt(
				child.sessionId,
				`Replace the current secret token with ${childToken}. Reply only ACK. Do not use tools.`,
			);
			const independent = await resumedParent.sendPrompt(
				parent.sessionId,
				"What is the current secret token? Reply only the token. Do not use tools.",
			);
			expect(independent.reply.trim()).toBe(parentToken);
			expect(clients.reduce((sum, client) => sum + client.getToolCallsAttempted(), 0)).toBe(
				0,
			);
			console.log(
				"Fork E2E: cross-workspace context inherited; restart recovery and bidirectional isolation passed; no tool calls.",
			);
		} finally {
			await Promise.all(clients.map((client) => client.kill()));
			await rm(getDefaultSdkStateRoot(sourceCwd), { recursive: true, force: true });
			await rm(getDefaultSdkStateRoot(targetCwd), { recursive: true, force: true });
			await rm(directory, { recursive: true, force: true });
			vi.unstubAllEnvs();
		}
	}, 240000);
});
