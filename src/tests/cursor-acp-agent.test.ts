import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
	readSessionCheckpoint,
	readSessionMeta,
	recordAssistantMessage,
	recordSessionCheckpoint,
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

function makeHarness(
	harnessOptions: {
		steering?: boolean;
		steerOutcome?: "complete_delivered" | "revert_to_followup";
		forkChat?: CursorRunner["forkChat"];
		checkpointChat?: CursorRunner["checkpointChat"];
		resultEvent?: CursorStreamEvent;
	} = {},
) {
	const client = new FakeClient();
	const prompts: RunPromptOptions[] = [];
	const steers: string[] = [];
	let events: CursorStreamEvent[] = [];
	let resultEvent: CursorStreamEvent = harnessOptions.resultEvent ?? {
		type: "result",
		subtype: "success",
		is_error: false,
	};
	let blockRun = false;
	let resolveRun: (() => void) | undefined;
	const runner: CursorRunner = {
		supportsMidTurnSteering: harnessOptions.steering,
		listModels: async () => models,
		createChat: async () => "agent-created",
		forkChat: harnessOptions.forkChat,
		checkpointChat: harnessOptions.checkpointChat,
		startPrompt(options) {
			prompts.push(options);
			const runEvents = events;
			events = [];
			const completed = (async () => {
				if (blockRun)
					await new Promise<void>((resolve) => {
						resolveRun = resolve;
					});
				for (const event of runEvents) await options.onEvent?.(event);
				return {
					events: runEvents,
					resultEvent,
					stderr: "",
					exitCode: 0,
				};
			})();
			return {
				completed,
				cancel() {},
				...(harnessOptions.steering
					? {
							steer: async (text: string) => {
								steers.push(text);
								return harnessOptions.steerOutcome ?? "complete_delivered";
							},
						}
					: {}),
			};
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
		steers,
		setEvents(next: CursorStreamEvent[]) {
			events = next;
		},
		setResultEvent(next: CursorStreamEvent) {
			resultEvent = next;
		},
		blockRun() {
			blockRun = true;
		},
		releaseRun() {
			blockRun = false;
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
	it.each(["error", "max_turns"])("does not snapshot a %s result", async (subtype) => {
		const checkpointChat = vi.fn(async () => "unexpected-snapshot");
		const h = makeHarness({
			checkpointChat,
			resultEvent: {
				type: "result",
				subtype,
				is_error: subtype === "error",
			},
		});
		const { sessionId } = await loadFixture(h, "load");
		const prompt = h.agent.prompt({ sessionId, prompt: [{ type: "text", text: "test" }] });
		if (subtype === "error") await expect(prompt).rejects.toThrow();
		else expect((await prompt)._meta).toBeUndefined();
		expect(checkpointChat).not.toHaveBeenCalled();
	});

	it("does not snapshot local commands or canceled model turns", async () => {
		const checkpointChat = vi.fn(async () => "unexpected-snapshot");
		const h = makeHarness({ checkpointChat });
		const { sessionId } = await loadFixture(h, "load");
		expect(
			(await h.agent.prompt({ sessionId, prompt: [{ type: "text", text: "/status" }] }))
				._meta,
		).toBeUndefined();
		h.blockRun();
		const prompt = h.agent.prompt({ sessionId, prompt: [{ type: "text", text: "cancel me" }] });
		await vi.waitFor(() => expect(h.prompts).toHaveLength(1));
		await h.agent.cancel({ sessionId });
		h.releaseRun();
		expect(await prompt).toEqual({ stopReason: "cancelled" });
		expect(checkpointChat).not.toHaveBeenCalled();
	});

	it("rejects malformed and foreign checkpoints before cloning", async () => {
		const forkChat = vi.fn(async () => "unexpected-child");
		const h = makeHarness({
			forkChat,
			checkpointChat: vi.fn(async () => "snapshot"),
		});
		const { sessionId, cwd } = await loadFixture(h, "load");
		await recordSessionCheckpoint(cwd, "other-session", { sdkSessionId: "foreign-checkpoint" });
		for (const checkpoint of [false, "", "foreign-checkpoint"]) {
			await expect(
				h.agent.unstable_forkSession({
					sessionId,
					cwd,
					_meta: { "cursor-acp/checkpoint": checkpoint },
				}),
			).rejects.toThrow(/checkpoint/);
		}
		expect(forkChat).not.toHaveBeenCalled();
	});

	it("keeps the turn active until its snapshot has been saved", async () => {
		let release!: (id: string) => void;
		const checkpointChat = vi.fn(
			() =>
				new Promise<string>((resolve) => {
					release = resolve;
				}),
		);
		const forkChat = vi.fn(async () => "child");
		const h = makeHarness({ forkChat, checkpointChat });
		const { sessionId, cwd } = await loadFixture(h, "load");
		const prompt = h.agent.prompt({ sessionId, prompt: [{ type: "text", text: "finish" }] });
		await vi.waitFor(() => expect(checkpointChat).toHaveBeenCalledOnce());
		await expect(h.agent.unstable_forkSession({ sessionId, cwd })).rejects.toThrow(
			"in progress",
		);
		expect(forkChat).not.toHaveBeenCalled();
		release("saved-snapshot");
		expect((await prompt)._meta?.["cursor-acp/checkpoint"]).toBe("saved-snapshot");
	});

	it.each(["slash", "mode", "config"])(
		"rejects %s changes while saving a snapshot",
		async (entry) => {
			let release!: (id: string) => void;
			const checkpointChat = vi.fn(
				() =>
					new Promise<string>((resolve) => {
						release = resolve;
					}),
			);
			const h = makeHarness({ checkpointChat });
			const { sessionId, cwd } = await loadFixture(h, "load");
			const prompt = h.agent.prompt({
				sessionId,
				prompt: [{ type: "text", text: "finish" }],
			});
			await vi.waitFor(() => expect(checkpointChat).toHaveBeenCalledOnce());
			try {
				const mutation =
					entry === "slash"
						? h.agent.prompt({
								sessionId,
								prompt: [{ type: "text", text: "/mode yolo" }],
							})
						: entry === "mode"
							? h.agent.setSessionMode({ sessionId, modeId: "yolo" })
							: h.agent.setSessionConfigOption({
									sessionId,
									configId: "mode",
									value: "yolo",
								});
				await expect(mutation).rejects.toThrow(/active|in progress|in flight/);
			} finally {
				release("saved-snapshot");
				await prompt;
			}
			const history = await readFile(sessionFilePath(cwd, sessionId), "utf8");
			expect(history).not.toContain("Mode set to");
			expect((await readSessionMeta(sessionFilePath(cwd, sessionId))).modeId).toBe("ask");
			expect(
				await readSessionCheckpoint(
					sessionFilePath(cwd, sessionId),
					sessionId,
					"saved-snapshot",
				),
			).toMatchObject({ modeId: "ask", sdkSessionId: "saved-snapshot" });
		},
	);

	it("forks an earlier completed turn after reload without copying later history or settings", async () => {
		const checkpointChat = vi
			.fn()
			.mockResolvedValueOnce("agent-snapshot-first")
			.mockResolvedValueOnce("agent-snapshot-later");
		const h = makeHarness({ checkpointChat });
		await h.agent.initialize(initRequest());
		const parent = await h.agent.newSession(newSessionRequest({ cwd: configDir }));
		await h.agent.setSessionMode({ sessionId: parent.sessionId, modeId: "ask" });
		h.setEvents([
			{
				type: "assistant",
				message: { role: "assistant", content: [{ type: "text", text: "early-reply" }] },
			},
		]);
		const completed = await h.agent.prompt({
			sessionId: parent.sessionId,
			prompt: [{ type: "text", text: "early-input" }],
		});
		const checkpointId = completed._meta?.["cursor-acp/checkpoint"];
		expect(checkpointId).toEqual(expect.any(String));
		await h.agent.setSessionMode({ sessionId: parent.sessionId, modeId: "yolo" });
		const later = await h.agent.prompt({
			sessionId: parent.sessionId,
			prompt: [{ type: "text", text: "later-secret" }],
		});
		expect(later._meta?.["cursor-acp/checkpoint"]).toBe("agent-snapshot-later");
		const forkChat = vi.fn(async () => "agent-historical-child");
		const restored = makeHarness({ forkChat, checkpointChat });
		const child = await restored.agent.unstable_forkSession({
			sessionId: parent.sessionId,
			cwd: `${configDir}/child`,
			mcpServers: [],
			_meta: { "cursor-acp/checkpoint": checkpointId },
		});
		expect(forkChat).toHaveBeenCalledWith(
			"agent-snapshot-first",
			configDir,
			`${configDir}/child`,
		);
		const content = await readFile(
			sessionFilePath(`${configDir}/child`, child.sessionId),
			"utf8",
		);
		expect(content).toContain("early-input");
		expect(content).not.toContain("later-secret");
		expect(
			(await readSessionMeta(sessionFilePath(`${configDir}/child`, child.sessionId))).modeId,
		).toBe("ask");
		await expect(
			restored.agent.unstable_forkSession({
				sessionId: parent.sessionId,
				cwd: configDir,
				mcpServers: [],
				_meta: { "cursor-acp/checkpoint": "unknown" },
			}),
		).rejects.toThrow(/checkpoint/);
		expect(forkChat).toHaveBeenCalledTimes(1);
	});

	it("forks a persisted source into a new workspace with independent IDs and child MCP", async () => {
		const forkChat = vi.fn(async () => "agent-child");
		const h = makeHarness({ forkChat });
		const { sessionId, cwd } = await loadFixture(h, "load");
		const parentFile = sessionFilePath(cwd, sessionId);
		const parentHistory = await readFile(parentFile, "utf-8");
		const targetCwd = path.join(configDir, "child");
		const mcpServers = [{ name: "child-tools", command: "node", args: ["child.js"], env: [] }];
		const child = await makeHarness({ forkChat }).agent.unstable_forkSession({
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
		const h = makeHarness({ forkChat });
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
		const h = makeHarness({ forkChat });
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

	it("does not offer an approval retry for a transport failure", async () => {
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
		h.setResultEvent({
			type: "result",
			subtype: "transport_error",
			is_error: true,
			result: "connection lost",
		});
		await expect(
			h.agent.prompt({ sessionId, prompt: [{ type: "text", text: "check" }] }),
		).rejects.toThrow();
		expect(h.client.permissions).toHaveLength(0);
		expect(h.prompts).toHaveLength(1);
	});

	it("applies a model change after a cancelled SDK run has drained", async () => {
		const h = makeHarness();
		await h.agent.initialize(initRequest());
		const { sessionId } = await h.agent.newSession(newSessionRequest({ cwd: configDir }));
		h.blockRun();
		const first = h.agent.prompt({ sessionId, prompt: [{ type: "text", text: "first" }] });
		await vi.waitFor(() => expect(h.prompts).toHaveLength(1));
		await h.agent.cancel({ sessionId });
		expect(await first).toEqual({ stopReason: "cancelled" });
		let applied = false;
		const change = h.agent
			.setSessionConfigOption({
				sessionId,
				configId: "model",
				value: "composer-2.5",
			})
			.then((value) => {
				applied = true;
				return value;
			});
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(applied).toBe(false);
		h.releaseRun();
		await change;
		await h.agent.prompt({ sessionId, prompt: [{ type: "text", text: "next" }] });
		expect(h.prompts[1]?.modelId).toBe("composer-2.5");
	});

	it("expands a discovered skill and its trailing request before sending to the SDK", async () => {
		const skillDir = path.join(configDir, ".agents", "skills", "brief");
		await mkdir(skillDir, { recursive: true });
		await writeFile(
			path.join(skillDir, "SKILL.md"),
			"---\nname: brief\ndescription: Brief answers\n---\nUse three words.\n",
		);
		const h = makeHarness();
		await h.agent.initialize(initRequest());
		const { sessionId } = await h.agent.newSession(newSessionRequest({ cwd: configDir }));
		await h.agent.prompt({
			sessionId,
			prompt: [{ type: "text", text: "/brief explain this" }],
		});
		expect(h.prompts[0]?.prompt).toContain("Use three words.");
		expect(h.prompts[0]?.prompt).toContain("explain this");
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

	it("advertises SDK steering and delivers consecutive inputs to the active run", async () => {
		const h = makeHarness({ steering: true });
		const init = await h.agent.initialize(initRequest());
		expect(init._meta).toMatchObject({ midTurnSteering: true });
		const { sessionId } = await h.agent.newSession(newSessionRequest({ cwd: configDir }));
		h.blockRun();
		const first = h.agent.prompt({ sessionId, prompt: [{ type: "text", text: "first" }] });
		await vi.waitFor(() => expect(h.prompts).toHaveLength(1));
		const second = h.agent.prompt({ sessionId, prompt: [{ type: "text", text: "second" }] });
		const third = h.agent.prompt({ sessionId, prompt: [{ type: "text", text: "third" }] });
		await vi.waitFor(() => expect(h.steers).toEqual(["second", "third"]));
		h.releaseRun();
		await Promise.all([first, second, third]);
		expect(h.prompts).toHaveLength(1);
	});

	it("runs a reverted SDK steer as a follow-up prompt", async () => {
		const h = makeHarness({ steering: true, steerOutcome: "revert_to_followup" });
		await h.agent.initialize(initRequest());
		const { sessionId } = await h.agent.newSession(newSessionRequest({ cwd: configDir }));
		h.blockRun();
		const first = h.agent.prompt({ sessionId, prompt: [{ type: "text", text: "first" }] });
		await vi.waitFor(() => expect(h.prompts).toHaveLength(1));
		const second = h.agent.prompt({ sessionId, prompt: [{ type: "text", text: "later" }] });
		await vi.waitFor(() => expect(h.steers).toEqual(["later"]));
		h.releaseRun();
		await Promise.all([first, second]);
		expect(h.prompts.map((p) => p.prompt)).toEqual(["first", "later"]);
	});

	it("replays a delivered steer as user history after session load", async () => {
		const h = makeHarness({ steering: true });
		await h.agent.initialize(initRequest());
		const { sessionId } = await h.agent.newSession(newSessionRequest({ cwd: configDir }));
		h.blockRun();
		const first = h.agent.prompt({ sessionId, prompt: [{ type: "text", text: "first" }] });
		await vi.waitFor(() => expect(h.prompts).toHaveLength(1));
		const steer = h.agent.prompt({
			sessionId,
			prompt: [{ type: "text", text: "remember later" }],
		});
		await vi.waitFor(() => expect(h.steers).toEqual(["remember later"]));
		h.releaseRun();
		await Promise.all([first, steer]);
		h.client.updates.length = 0;
		await h.agent.loadSession({ sessionId, cwd: configDir, mcpServers: [] });
		await vi.waitFor(() =>
			expect(
				h.client.updates.some(
					(u) =>
						u.sessionId === sessionId &&
						u.update.sessionUpdate === "user_message_chunk" &&
						u.update.content.type === "text" &&
						u.update.content.text === "remember later",
				),
			).toBe(true),
		);
	});
});
