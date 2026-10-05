import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
	RequestPermissionRequest,
	RequestPermissionResponse,
	SessionNotification,
} from "@agentclientprotocol/sdk";
import { CursorAcpAgent } from "../cursor-acp-agent.js";
import type { CursorAcpClient } from "../cursor-acp-client.js";
import type { CursorRunner, RunPromptOptions, CursorStreamEvent } from "../cursor-runner.js";
import {
	readSessionMeta,
	recordAssistantMessage,
	recordSessionMeta,
	recordUserMessage,
	sessionFilePath,
} from "../session-storage.js";
import { initRequest, newSessionRequest, noopLogger } from "./test-support.js";

const models = [
	{ modelId: "auto", name: "Auto", current: true },
	{
		modelId: "composer-2.5",
		name: "Composer 2.5",
		parameters: [
			{
				id: "fast",
				type: "boolean" as const,
				default: "false",
				values: [
					{ value: "true", displayName: "On" },
					{ value: "false", displayName: "Off" },
				],
			},
		],
	},
];

class FakeClient implements CursorAcpClient {
	updates: SessionNotification[] = [];
	permissions: RequestPermissionRequest[] = [];
	async sessionUpdate(update: SessionNotification) {
		this.updates.push(update);
	}
	async requestPermission(request: RequestPermissionRequest): Promise<RequestPermissionResponse> {
		this.permissions.push(request);
		return { outcome: { outcome: "selected", optionId: "allow_once" } };
	}
	async extMethod() {
		return {};
	}
	async extNotification() {}
	async readTextFile() {
		return { content: "" };
	}
	async writeTextFile() {
		return {};
	}
}

function makeHarness(forkChat?: CursorRunner["forkChat"]) {
	const client = new FakeClient();
	const prompts: RunPromptOptions[] = [];
	let events: CursorStreamEvent[] = [];
	let resolveRun: (() => void) | undefined;
	const runner: CursorRunner = {
		listModels: async () => models,
		createChat: async () => "agent-created",
		forkChat,
		startPrompt(options) {
			prompts.push(options);
			const runEvents = events;
			events = [];
			const completed = (async () => {
				if (resolveRun)
					await new Promise<void>((resolve) => {
						resolveRun = resolve;
					});
				for (const event of runEvents) await options.onEvent?.(event);
				return {
					events: runEvents,
					resultEvent: { type: "result", subtype: "success", is_error: false },
					stderr: "",
					exitCode: 0,
				};
			})();
			return { completed, cancel() {} };
		},
	};
	const agent = new CursorAcpAgent(client, {
		runner,
		logger: noopLogger,
		auth: {
			status: async () => ({ loggedIn: true, account: "test", raw: "" }),
			ensureLoggedIn: async () => ({ loggedIn: true, account: "test", raw: "" }),
			login: async () => ({ code: 0, stdout: "", stderr: "" }),
			logout: async () => ({ code: 0, stdout: "", stderr: "" }),
		},
	});
	return {
		agent,
		client,
		prompts,
		setEvents(next: CursorStreamEvent[]) {
			events = next;
		},
		blockRun() {
			resolveRun = () => {};
		},
		releaseRun() {
			resolveRun?.();
		},
	};
}

let configDir: string;
const previousConfigDir = process.env.CURSOR_ACP_CONFIG_DIR;
beforeEach(async () => {
	configDir = await mkdtemp(path.join(os.tmpdir(), "cursor-acp-sdk-test-"));
	process.env.CURSOR_ACP_CONFIG_DIR = configDir;
});
afterEach(async () => {
	if (previousConfigDir === undefined) delete process.env.CURSOR_ACP_CONFIG_DIR;
	else process.env.CURSOR_ACP_CONFIG_DIR = previousConfigDir;
	await rm(configDir, { recursive: true, force: true });
});

async function loadFixture(h: ReturnType<typeof makeHarness>, method: "load" | "resume") {
	const sessionId = "acp-persisted";
	const cwd = configDir;
	await recordSessionMeta(cwd, sessionId, {
		sdkSessionId: "agent-persisted",
		modeId: "ask",
		modelId: "composer-2.5",
		fastValue: "false",
	});
	await recordUserMessage(cwd, sessionId, "remember this");
	await recordAssistantMessage(cwd, sessionId, "ACK");
	await h.agent.initialize(initRequest());
	if (method === "load") await h.agent.loadSession({ sessionId, cwd, mcpServers: [] });
	else await h.agent.resumeSession({ sessionId, cwd });
	return { sessionId, cwd };
}

describe("CursorAcpAgent SDK behavior", () => {
	it("forks a persisted source into a new workspace with independent IDs and child MCP", async () => {
		const forkChat = vi.fn(async () => "agent-child");
		const h = makeHarness(forkChat);
		const { sessionId, cwd } = await loadFixture(h, "load");
		const parentFile = sessionFilePath(cwd, sessionId);
		const parentHistory = await readFile(parentFile, "utf-8");
		const targetCwd = path.join(configDir, "child");
		const mcpServers = [{ name: "child-tools", command: "node", args: ["child.js"], env: [] }];
		const child = await makeHarness(forkChat).agent.unstable_forkSession({
			sessionId,
			cwd: targetCwd,
			mcpServers,
		});
		expect(child.sessionId).not.toBe(sessionId);
		expect(forkChat).toHaveBeenCalledWith("agent-persisted", cwd, targetCwd);
		expect(await readSessionMeta(sessionFilePath(targetCwd, child.sessionId))).toMatchObject({
			cwd: targetCwd,
			sdkSessionId: "agent-child",
			modelId: "composer-2.5",
			modeId: "ask",
			fastValue: "false",
		});
		expect(await readFile(parentFile, "utf-8")).toBe(parentHistory);
		const resumed = makeHarness();
		await resumed.agent.loadSession({ sessionId: child.sessionId, cwd: targetCwd, mcpServers });
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(
			resumed.client.updates.some(
				(u) =>
					u.sessionId === child.sessionId &&
					u.update.sessionUpdate === "agent_message_chunk" &&
					u.update.content.type === "text" &&
					u.update.content.text === "ACK",
			),
		).toBe(true);
		await resumed.agent.prompt({
			sessionId: child.sessionId,
			prompt: [{ type: "text", text: "continue child" }],
		});
		expect(resumed.prompts[0]).toMatchObject({
			sdkSessionId: "agent-child",
			workspace: targetCwd,
			modeId: "ask",
			mcpServers,
		});
	});

	it("inherits live settings and rejects a fork during an active prompt", async () => {
		const forkChat = vi.fn(async () => "agent-child");
		const h = makeHarness(forkChat);
		const { sessionId, cwd } = await loadFixture(h, "load");
		await h.agent.setSessionConfigOption({ sessionId, configId: "fast", value: "true" });
		const child = await h.agent.unstable_forkSession({ sessionId, cwd });
		expect((await readSessionMeta(sessionFilePath(cwd, child.sessionId))).fastValue).toBe(
			"true",
		);
		h.blockRun();
		const prompt = h.agent.prompt({
			sessionId,
			prompt: [{ type: "text", text: "still working" }],
		});
		await vi.waitFor(() => expect(h.prompts).toHaveLength(1));
		await expect(h.agent.unstable_forkSession({ sessionId, cwd })).rejects.toThrow(
			"in progress",
		);
		expect(forkChat).toHaveBeenCalledOnce();
		h.releaseRun();
		await prompt;
	});

	it("does not advertise unsupported forks or silently replace a missing source with a blank session", async () => {
		const unsupported = makeHarness();
		expect(
			(await unsupported.agent.initialize(initRequest())).agentCapabilities
				?.sessionCapabilities?.fork,
		).toBeUndefined();
		const forkChat = vi.fn(async () => "agent-child");
		const h = makeHarness(forkChat);
		expect(
			(await h.agent.initialize(initRequest())).agentCapabilities?.sessionCapabilities?.fork,
		).toEqual({});
		await expect(
			h.agent.unstable_forkSession({ sessionId: "missing", cwd: configDir }),
		).rejects.toThrow("source session not found");
		expect(forkChat).not.toHaveBeenCalled();
	});

	it("advertises SDK models and ACP mode and parameter controls", async () => {
		const h = makeHarness();
		await h.agent.initialize(
			initRequest({ clientCapabilities: { session: { configOptions: { boolean: {} } } } }),
		);
		const session = await h.agent.newSession(
			newSessionRequest({ cwd: configDir, default_model: "composer-2.5" }),
		);
		expect(session.models?.availableModels.map((m) => m.modelId)).toContain("composer-2.5");
		expect(session.configOptions?.find((option) => option.id === "fast")?.type).toBe("boolean");
		expect(session.modes?.currentModeId).toBe("auto-review");
	});

	it("applies Ask, model and fast=false to the SDK runner", async () => {
		const h = makeHarness();
		await h.agent.initialize(initRequest());
		const { sessionId } = await h.agent.newSession(newSessionRequest({ cwd: configDir }));
		await h.agent.setSessionMode({ sessionId, modeId: "ask" });
		await h.agent.setSessionConfigOption({
			sessionId,
			configId: "model",
			value: "composer-2.5",
		});
		await h.agent.setSessionConfigOption({ sessionId, configId: "fast", value: "false" });
		h.setEvents([
			{ type: "system", subtype: "init", session_id: "agent-actual" },
			{ type: "assistant", message: { content: [{ type: "text", text: "ACK" }] } },
		]);
		await h.agent.prompt({ sessionId, prompt: [{ type: "text", text: "hello" }] });
		expect(h.prompts[0]).toMatchObject({
			modelId: "composer-2.5",
			modeId: "ask",
			fastValue: "false",
			sdkSessionId: "agent-created",
		});
		expect((await readSessionMeta(sessionFilePath(configDir, sessionId))).sdkSessionId).toBe(
			"agent-actual",
		);
		expect(h.client.updates.some((u) => u.update.sessionUpdate === "agent_message_chunk")).toBe(
			true,
		);
	});

	it("applies ACP defaults and reports config changes to the client", async () => {
		const h = makeHarness();
		await h.agent.initialize(initRequest());
		const session = await h.agent.newSession(
			newSessionRequest({
				cwd: configDir,
				default_mode: "ask",
				default_model: "composer-2.5",
			}),
		);
		expect(session.modes?.currentModeId).toBe("ask");
		await h.agent.setSessionConfigOption({
			sessionId: session.sessionId,
			configId: "fast",
			value: "false",
		});
		expect(
			h.client.updates.some(
				(u) =>
					u.sessionId === session.sessionId &&
					u.update.sessionUpdate === "config_option_update",
			),
		).toBe(true);
		await h.agent.prompt({
			sessionId: session.sessionId,
			prompt: [{ type: "text", text: "hello" }],
		});
		expect(h.prompts[0]).toMatchObject({
			modeId: "ask",
			modelId: "composer-2.5",
			fastValue: "false",
		});
	});

	it("handles built-in slash commands without starting an SDK prompt", async () => {
		const h = makeHarness();
		await h.agent.initialize(initRequest());
		const { sessionId } = await h.agent.newSession(newSessionRequest({ cwd: configDir }));
		await h.agent.prompt({ sessionId, prompt: [{ type: "text", text: "/mode ask" }] });
		expect(h.prompts).toHaveLength(0);
		expect((await readSessionMeta(sessionFilePath(configDir, sessionId))).modeId).toBe("ask");
	});

	for (const method of ["load", "resume"] as const) {
		it(`replays history before ${method} resolves and keeps ACP and SDK session IDs`, async () => {
			const h = makeHarness();
			const { sessionId } = await loadFixture(h, method);
			expect(
				h.client.updates.some(
					(u) =>
						u.sessionId === sessionId &&
						u.update.sessionUpdate === "agent_message_chunk" &&
						u.update.content.type === "text" &&
						u.update.content.text === "ACK",
				),
			).toBe(true);
			const replayCount = h.client.updates.length;
			await h.agent.prompt({ sessionId, prompt: [{ type: "text", text: "next" }] });
			expect(h.prompts[0]?.sdkSessionId).toBe("agent-persisted");
			expect(
				h.client.updates
					.slice(replayCount)
					.some((u) => u.update.sessionUpdate === "agent_message_chunk"),
			).toBe(false);
		});
	}

	it("exposes the old ACP session/set_model method", async () => {
		const h = makeHarness();
		await h.agent.initialize(initRequest());
		const { sessionId } = await h.agent.newSession(newSessionRequest({ cwd: configDir }));
		await h.agent.extMethod("session/set_model", { sessionId, modelId: "composer-2.5" });
		await h.agent.prompt({ sessionId, prompt: [{ type: "text", text: "hello" }] });
		expect(h.prompts[0]?.modelId).toBe("composer-2.5");
	});

	it("offers blocked SDK tools to the ACP client and retries approved turns", async () => {
		const h = makeHarness();
		await h.agent.initialize(initRequest());
		const { sessionId } = await h.agent.newSession(newSessionRequest({ cwd: configDir }));
		h.setEvents([
			{
				type: "tool_call",
				subtype: "started",
				call_id: "call_1",
				tool_call: { shellToolCall: { args: { command: "pwd" } } },
			},
			{
				type: "tool_call",
				subtype: "completed",
				call_id: "call_1",
				tool_call: {
					shellToolCall: {
						args: { command: "pwd" },
						result: { rejected: { message: "auto-approval boundary" } },
					},
				},
			},
		]);
		await h.agent.prompt({ sessionId, prompt: [{ type: "text", text: "check" }] });
		expect(h.client.permissions).toHaveLength(1);
		expect(h.client.permissions[0]?.toolCall.title).toBe("pwd");
		expect(h.prompts.map((p) => p.reviewPolicy)).toEqual(["auto-review", "run-everything"]);
	});

	it("rejects a concurrent prompt and model change", async () => {
		const h = makeHarness();
		await h.agent.initialize(initRequest());
		const { sessionId } = await h.agent.newSession(newSessionRequest({ cwd: configDir }));
		h.blockRun();
		const first = h.agent.prompt({ sessionId, prompt: [{ type: "text", text: "first" }] });
		await vi.waitFor(() => expect(h.prompts).toHaveLength(1));
		await expect(
			h.agent.prompt({ sessionId, prompt: [{ type: "text", text: "second" }] }),
		).rejects.toThrow();
		await expect(
			h.agent.setSessionConfigOption({ sessionId, configId: "model", value: "composer-2.5" }),
		).rejects.toThrow();
		h.releaseRun();
		await first;
	});
});
