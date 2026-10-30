import { Agent, type LocalAgentStore } from "@cursor/sdk";
import { SqliteLocalAgentStore } from "@cursor/sdk/sqlite";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

/** A process-scoped SQLite lock plus the exact SDK run created under that lock. */
export class SdkRunOwnership {
	readonly store: LocalAgentStore;
	private lock: DatabaseSync | undefined;
	private directory: string | undefined;
	private initialRunId: string | undefined;
	private retired = false;

	private constructor(private readonly storage: SqliteLocalAgentStore) {
		this.store = {
			agents: storage.agents,
			checkpoints: storage.checkpoints,
			runEvents: storage.runEvents,
			runs: {
				get: (input) => storage.runs.get(input),
				list: (input) => storage.runs.list(input),
				update: (input) => storage.runs.update(input),
				delete: (input) => storage.runs.delete(input),
				create: async (input) => {
					// Persist ownership BEFORE the SDK can persist a queued/running row.
					// This also covers a crash while send() has not returned its Run yet.
					if (this.lock) this.record(input.run.agentId, input.run.runId);
					else this.initialRunId = input.run.runId;
					return await storage.runs.create(input);
				},
			},
		};
	}

	static async open(workspace: string): Promise<SdkRunOwnership> {
		return new SdkRunOwnership(await SqliteLocalAgentStore.open({ workspaceRef: workspace }));
	}

	get isActive(): boolean {
		return this.lock !== undefined;
	}

	async acquire(agentId: string): Promise<void> {
		if (this.lock) throw new Error(`Agent ${agentId} already has an active ACP prompt`);
		const directory = join(
			this.storage.stateRoot,
			"acp-run-owners",
			createHash("sha256").update(agentId).digest("hex"),
		);
		mkdirSync(directory, { recursive: true, mode: 0o700 });
		const lock = new DatabaseSync(join(directory, "lock.db"));
		try {
			// The OS releases this lock on exit, including SIGKILL. No PID reuse,
			// heartbeat timeout, or stale-file deletion race can evict a live owner.
			lock.exec("BEGIN IMMEDIATE");
		} catch {
			lock.close();
			throw new Error(`Agent ${agentId} already has an active ACP prompt`);
		}
		this.lock = lock;
		this.directory = directory;
		try {
			const agent = await this.storage.agents.get({ agentId });
			const runId = agent?.activeRunId;
			if (!runId) return;
			const run = await this.storage.runs.get({ agentId, runId });
			if (!run || !["queued", "running"].includes(run.status)) return;
			if (runId === this.initialRunId) {
				this.initialRunId = undefined;
				this.record(agentId, runId);
				return;
			}

			let previous: { agentId?: unknown; runId?: unknown } = {};
			try {
				previous = JSON.parse(readFileSync(join(directory, "run.json"), "utf8"));
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
			if (previous.agentId !== agentId || previous.runId !== runId) {
				throw new Error(`Agent ${agentId} already has active run with unknown ownership`);
			}
			// Target this exact abandoned run, never force-expire whichever run is
			// current at send time. The SDK retains the agent checkpoint and history.
			const abandoned = await Agent.getRun(runId, {
				cwd: this.storage.workspaceRef,
				store: this.store,
			});
			if (abandoned.agentId !== agentId || !abandoned.supports("cancel")) {
				throw new Error(`Cannot recover abandoned run for agent ${agentId}`);
			}
			await abandoned.cancel();
		} catch (error) {
			this.release();
			throw error;
		}
	}

	private record(agentId: string, runId: string): void {
		if (!this.directory) throw new Error("SDK run ownership lock is not held");
		const temporary = join(this.directory, `run-${randomUUID()}.tmp`);
		writeFileSync(temporary, JSON.stringify({ agentId, runId }), { mode: 0o600 });
		renameSync(temporary, join(this.directory, "run.json"));
	}

	release(): void {
		this.lock?.close();
		this.lock = undefined;
		if (this.retired) void this.storage.dispose().catch(() => undefined);
	}

	close(): void {
		this.retired = true;
		if (!this.lock) void this.storage.dispose().catch(() => undefined);
	}
}
