import type { McpServer } from "@agentclientprotocol/sdk";
import {
	Agent,
	Cursor,
	type AgentOptions,
	type McpServerConfig,
	type SDKAgent,
	type SDKMessage,
} from "@cursor/sdk";
import { randomUUID } from "node:crypto";
import { applyCursorCliAttributionEnvironment } from "./cursor-cli-config.js";
import {
	sdkMessageToCursorStreamEvent,
	sdkRunResultToCursorResultEvent,
} from "./cursor-sdk-event-adapter.js";
import { SdkRunOwnership } from "./cursor-sdk-run-ownership.js";
import { getCursorApiKey } from "./cursor-sdk-config.js";
import { buildLocalAgentOptions } from "./cursor-sdk-local-options.js";
import type {
	CursorPromptRun,
	CursorRunner,
	CursorStreamEvent,
	RunPromptOptions,
	RunPromptResult,
} from "./cursor-runner.js";
import { CursorTransportFailure } from "./cursor-transport-failure.js";
import { buildSdkModelSelection, ensureAutoModel } from "./model-id.js";
import type { CursorModelDescriptor } from "./slash-commands.js";
import type { Logger } from "./utils.js";

const PENDING_AGENT_PREFIX = "pending-";
const CANCELLATION_DRAIN_TIMEOUT_MS = 15_000;

interface ManagedAgent {
	ownership: SdkRunOwnership;
	agent: SDKAgent;
	configKey: string;
	cwd: string;
}

interface PromptHooks {
	isCancelled: () => boolean;
	waitUntilCancelled: () => Promise<void>;
	setCancelRun: (cancel: () => Promise<void>) => void;
}

type OperationOutcome<T> =
	| { cancelled: false; value: T }
	| { cancelled: true; settled: false }
	| { cancelled: true; settled: true; succeeded: false }
	| { cancelled: true; settled: true; succeeded: true; value: T };

function isPendingAgentId(agentId: string | undefined): agentId is string {
	return typeof agentId === "string" && agentId.startsWith(PENDING_AGENT_PREFIX);
}

function isResumableAgentId(agentId: string | undefined): agentId is string {
	return typeof agentId === "string" && agentId.length > 0 && !isPendingAgentId(agentId);
}

function sdkMcpServers(
	servers: McpServer[] | undefined,
): Record<string, McpServerConfig> | undefined {
	if (!servers?.length) {
		return undefined;
	}

	const result: Record<string, McpServerConfig> = {};
	for (const server of servers) {
		if ("serverId" in server) {
			continue;
		}
		if ("url" in server) {
			result[server.name] = {
				type: server.type,
				url: server.url,
				headers: Object.fromEntries(server.headers.map(({ name, value }) => [name, value])),
			};
			continue;
		}
		result[server.name] = {
			type: "stdio",
			command: server.command,
			args: server.args,
			env: Object.fromEntries(server.env.map(({ name, value }) => [name, value])),
		};
	}
	return Object.keys(result).length > 0 ? result : undefined;
}

export class CursorSdkRunner implements CursorRunner {
	private readonly agents = new Map<string, ManagedAgent>();
	private readonly ownedAgents = new WeakMap<SDKAgent, ManagedAgent>();

	constructor(
		private readonly apiKey: string | undefined = getCursorApiKey(),
		private readonly logger: Logger = console,
	) {}

	async listModels(): Promise<CursorModelDescriptor[]> {
		const models = await Cursor.models.list(this.apiKey ? { apiKey: this.apiKey } : undefined);
		return ensureAutoModel(
			models.map((model) => ({
				modelId: model.id,
				name: model.displayName?.trim() || model.id,
				...(model.parameters?.length
					? {
							parameters: model.parameters.map((parameter) => ({
								id: parameter.id,
								displayName: parameter.displayName,
								values: parameter.values.map((value) => ({
									value: value.value,
									displayName: value.displayName,
								})),
							})),
						}
					: {}),
				...(model.variants?.length
					? {
							variants: model.variants.map((variant) => ({
								params: variant.params,
								isDefault: variant.isDefault,
							})),
						}
					: {}),
			})),
		);
	}

	async createChat(): Promise<string> {
		return `${PENDING_AGENT_PREFIX}${randomUUID()}`;
	}

	startPrompt(options: RunPromptOptions): CursorPromptRun {
		let cancelled = false;
		let cancelRun: (() => Promise<void>) | undefined;
		let resolveCancelled: (() => void) | undefined;
		const cancelledPromise = new Promise<void>((resolve) => {
			resolveCancelled = resolve;
		});
		const cancelActiveRun = () => {
			const cancel = cancelRun;
			cancelRun = undefined;
			if (cancel) {
				void cancel().catch((error: unknown) => {
					this.logger.error?.("[cursor-acp] SDK cancellation failed", error);
				});
			}
		};
		const completed = this.executePrompt(options, {
			isCancelled: () => cancelled,
			waitUntilCancelled: () => cancelledPromise,
			setCancelRun: (cancel) => {
				cancelRun = cancel;
				if (cancelled) {
					cancelActiveRun();
				}
			},
		});
		void completed.then(
			() => {
				cancelRun = undefined;
			},
			() => {
				cancelRun = undefined;
			},
		);

		return {
			completed,
			cancel: () => {
				if (cancelled) {
					return;
				}
				cancelled = true;
				resolveCancelled?.();
				cancelActiveRun();
			},
		};
	}

	private async executePrompt(
		options: RunPromptOptions,
		hooks: PromptHooks,
	): Promise<RunPromptResult> {
		const events: CursorStreamEvent[] = [];
		let resultEvent: CursorStreamEvent | undefined;
		let stderr = "";
		let agent: SDKAgent | undefined;
		let ownership: SdkRunOwnership | undefined;
		const pending = new Set<Promise<unknown>>();
		const track = <T>(operation: Promise<T>): Promise<T> => {
			pending.add(operation);
			void operation.then(
				() => pending.delete(operation),
				() => pending.delete(operation),
			);
			return operation;
		};
		const unfinishedToolCalls = new Map<string, Extract<SDKMessage, { type: "tool_call" }>>();
		let assistantReply = new CursorTransportFailure();
		let nextAssistantStartsSegment = true;
		const emit = async (event: CursorStreamEvent) => {
			events.push(event);
			if (event.type === "result") {
				resultEvent = event;
			}
			await options.onEvent?.(event);
		};

		try {
			const agentCompleted = this.resolveAgent(options);
			const agentOutcome = await Promise.race([
				agentCompleted.then((value) => ({ cancelled: false as const, value })),
				hooks.waitUntilCancelled().then(() => ({ cancelled: true as const })),
			]);
			if (agentOutcome.cancelled) {
				void agentCompleted
					.then((lateAgent) => this.retireAgent(lateAgent.agent))
					.catch(() => undefined);
				resultEvent = sdkRunResultToCursorResultEvent({ status: "cancelled" });
				await emit(resultEvent);
				return { events, resultEvent, stderr, exitCode: 0 };
			}
			const resolved = agentOutcome.value;
			await resolved.ownership.acquire(resolved.agent.agentId);
			ownership = resolved.ownership;
			agent = resolved.agent;
			await emit({ type: "system", subtype: "init", session_id: agent.agentId });
			if (hooks.isCancelled()) {
				resultEvent = sdkRunResultToCursorResultEvent({ status: "cancelled" });
				await emit(resultEvent);
				return { events, resultEvent, stderr, exitCode: 0 };
			}

			const sendOptions: Parameters<SDKAgent["send"]>[1] = {
				model: buildSdkModelSelection(
					options.modelId ?? "auto",
					options.modelCatalog,
					options.thinkingLevel,
					options.fastValue,
				),
				...(options.modeId === "plan" ? { mode: "plan" as const } : {}),
				...(sdkMcpServers(options.mcpServers)
					? { mcpServers: sdkMcpServers(options.mcpServers) }
					: {}),
			};

			this.logger.log?.(
				"[cursor-acp] SDK prompt:",
				agent.agentId,
				options.workspace,
				options.modelId ?? "auto",
				options.reviewPolicy === "run-everything"
					? "approval-retry"
					: options.reviewPolicy === "auto-review"
						? "auto-review"
						: "run-everything",
			);

			const message = options.images?.length
				? { text: options.prompt, images: options.images }
				: options.prompt;
			const sendCompleted = track(agent.send(message, sendOptions));
			const sendOutcome = await this.completeOperation(sendCompleted, hooks, agent);
			if (sendOutcome.cancelled && (!sendOutcome.settled || !sendOutcome.succeeded)) {
				track(
					sendCompleted.then(async (run) => {
						await run.cancel();
						await run.wait();
					}),
				).catch(() => undefined);
				resultEvent = sdkRunResultToCursorResultEvent({ status: "cancelled" });
				await emit(resultEvent);
				return { events, resultEvent, stderr, exitCode: 0 };
			}
			const run = sendOutcome.value;
			const terminal = track(run.wait());
			void terminal.catch(() => undefined);
			hooks.setCancelRun(() => run.cancel());
			const streamCompleted = track(
				(async () => {
					for await (const message of run.stream()) {
						let duplicateRunningToolCall = false;
						if (message.type === "tool_call") {
							nextAssistantStartsSegment = true;
							if (message.status === "running") {
								duplicateRunningToolCall = unfinishedToolCalls.has(message.call_id);
								unfinishedToolCalls.set(message.call_id, message);
							} else {
								unfinishedToolCalls.delete(message.call_id);
							}
						} else if (message.type === "assistant") {
							if (nextAssistantStartsSegment) {
								assistantReply = new CursorTransportFailure();
								nextAssistantStartsSegment = false;
							}
							for (const content of message.message.content) {
								if (content.type === "text") {
									assistantReply.push(content.text);
								}
							}
						}
						if (duplicateRunningToolCall) {
							continue;
						}
						for (const adapted of sdkMessageToCursorStreamEvent(message)) {
							await emit(adapted);
						}
					}
				})(),
			);

			const streamOutcome = await this.completeOperation(streamCompleted, hooks, agent);
			if (streamOutcome.cancelled) {
				resultEvent = sdkRunResultToCursorResultEvent({ status: "cancelled" });
				await emit(resultEvent);
				return { events, resultEvent, stderr, exitCode: 0 };
			}

			if (hooks.isCancelled()) {
				resultEvent = sdkRunResultToCursorResultEvent({ status: "cancelled" });
			} else {
				const waitCompleted = terminal;
				const waitOutcome = await this.completeOperation(waitCompleted, hooks, agent);
				if (waitOutcome.cancelled) {
					resultEvent = sdkRunResultToCursorResultEvent({ status: "cancelled" });
					await emit(resultEvent);
					return { events, resultEvent, stderr, exitCode: 0 };
				}
				const finished = waitOutcome.value;
				if (finished.status === "finished") {
					for (const toolCall of unfinishedToolCalls.values()) {
						for (const adapted of sdkMessageToCursorStreamEvent({
							...toolCall,
							status: "error",
							result: {
								message:
									"Cursor Auto Review stopped this tool at the auto-approval boundary",
							},
						})) {
							await emit(adapted);
						}
					}
				}
				const transportFailure =
					finished.status === "finished" ? assistantReply.failure : undefined;
				if (transportFailure) {
					stderr = transportFailure;
					this.retireAgent(agent);
					resultEvent = {
						...sdkRunResultToCursorResultEvent({
							status: "error",
							errorText: transportFailure,
						}),
						subtype: "transport_error",
					};
				} else {
					resultEvent = sdkRunResultToCursorResultEvent({
						status: finished.status,
						resultText: finished.result,
						errorText: finished.error?.message ?? finished.result,
					});
					stderr =
						finished.status === "error"
							? (finished.error?.message ?? finished.result ?? "")
							: "";
				}
			}
			await emit(resultEvent);
			return {
				events,
				resultEvent,
				stderr,
				exitCode: resultEvent.is_error === true ? 1 : 0,
			};
		} catch (error) {
			if (agent) {
				this.retireAgent(agent);
			}
			stderr = error instanceof Error ? error.message : String(error);
			resultEvent = sdkRunResultToCursorResultEvent(
				hooks.isCancelled()
					? { status: "cancelled" }
					: { status: "error", errorText: stderr },
			);
			await emit(resultEvent);
			return { events, resultEvent, stderr, exitCode: hooks.isCancelled() ? 0 : 1 };
		} finally {
			if (ownership) {
				const held = ownership;
				if (pending.size === 0) held.release();
				else void Promise.allSettled(pending).then(() => held.release());
			}
		}
	}

	private async completeOperation<T>(
		operation: Promise<T>,
		hooks: PromptHooks,
		agent: SDKAgent,
	): Promise<OperationOutcome<T>> {
		const first = await Promise.race([
			operation.then((value) => ({ completed: true as const, value })),
			hooks.waitUntilCancelled().then(() => ({ completed: false as const })),
		]);
		if (first.completed) {
			return { cancelled: false, value: first.value };
		}

		let timeout: ReturnType<typeof setTimeout> | undefined;
		const settled = await Promise.race([
			operation.then(
				(value) => ({ settled: true as const, succeeded: true as const, value }),
				() => ({ settled: true as const, succeeded: false as const }),
			),
			new Promise<{ settled: false }>((resolve) => {
				timeout = setTimeout(
					() => resolve({ settled: false }),
					CANCELLATION_DRAIN_TIMEOUT_MS,
				);
			}),
		]);
		if (timeout) {
			clearTimeout(timeout);
		}
		if (!settled.settled) {
			this.retireAgent(agent);
			void operation.catch(() => undefined);
		}
		return { cancelled: true, ...settled };
	}

	private retireAgent(agent: SDKAgent): void {
		const managed = this.ownedAgents.get(agent);
		if (!managed) return;
		this.ownedAgents.delete(agent);
		if (this.agents.get(agent.agentId) === managed) this.agents.delete(agent.agentId);
		managed.ownership.close();
		try {
			agent.close();
		} catch (error) {
			this.logger.error?.("[cursor-acp] Failed to close unusable SDK agent", error);
		}
	}

	private cacheAgent(managed: ManagedAgent): ManagedAgent {
		this.agents.set(managed.agent.agentId, managed);
		this.ownedAgents.set(managed.agent, managed);
		return managed;
	}

	private agentConfig(options: RunPromptOptions) {
		// The SDK has no approval callback. Smart Auto fails closed; an ACP-approved retry
		// deliberately resumes with Auto-review disabled for that one whole-turn retry.
		const autoReview = options.reviewPolicy !== "run-everything";
		const ask = options.modeId === "ask";
		return {
			autoReview,
			ask,
			key: JSON.stringify({ autoReview, ask }),
		};
	}

	private agentOptions(options: RunPromptOptions): AgentOptions {
		applyCursorCliAttributionEnvironment(options.workspace);
		const config = this.agentConfig(options);
		return {
			...(this.apiKey ? { apiKey: this.apiKey } : {}),
			model: buildSdkModelSelection(
				options.modelId ?? "auto",
				options.modelCatalog,
				options.thinkingLevel,
				options.fastValue,
			),
			local: buildLocalAgentOptions(options.workspace, config.autoReview),
			...(config.ask ? { tools: [] } : {}),
			...(sdkMcpServers(options.mcpServers)
				? { mcpServers: sdkMcpServers(options.mcpServers) }
				: {}),
		};
	}

	private async resolveAgent(options: RunPromptOptions): Promise<ManagedAgent> {
		const backendSessionId = options.backendSessionId;
		const configKey = this.agentConfig(options).key;
		if (backendSessionId) {
			const cached = this.agents.get(backendSessionId);
			if (cached && cached.cwd === options.workspace && cached.configKey === configKey) {
				return cached;
			}
			if (cached) {
				if (cached.ownership.isActive)
					throw new Error(`Agent ${backendSessionId} already has an active ACP prompt`);
				this.retireAgent(cached.agent);
			}

			if (isResumableAgentId(backendSessionId)) {
				const ownership = await SdkRunOwnership.open(options.workspace);
				let agent: SDKAgent;
				try {
					const config = this.agentOptions(options);
					agent = await Agent.resume(backendSessionId, {
						...config,
						local: { ...config.local, store: ownership.store },
					});
				} catch (error) {
					ownership.close();
					throw error;
				}
				return this.cacheAgent({
					ownership,
					agent,
					cwd: options.workspace,
					configKey,
				});
			}
		}

		const ownership = await SdkRunOwnership.open(options.workspace);
		let agent: SDKAgent;
		try {
			const config = this.agentOptions(options);
			agent = await Agent.create({
				...config,
				local: { ...config.local, store: ownership.store },
			});
		} catch (error) {
			ownership.close();
			throw error;
		}
		if (backendSessionId) {
			this.agents.delete(backendSessionId);
		}
		return this.cacheAgent({ ownership, agent, cwd: options.workspace, configKey });
	}
}
