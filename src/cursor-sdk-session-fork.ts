import { randomUUID } from "node:crypto";
import type { LocalAgentStore } from "@cursor/sdk";

export async function cloneSdkSession(
	sourceStore: LocalAgentStore,
	targetStore: LocalAgentStore,
	sourceAgentId: string,
	cwd: string,
): Promise<string> {
	const source = await sourceStore.agents.get({ agentId: sourceAgentId });
	if (!source) throw new Error(`Cursor SDK source agent not found: ${sourceAgentId}`);
	if (source.activeRunId || source.status === "running") {
		throw new Error("Cannot fork a Cursor SDK agent while a run is in progress");
	}
	if (!source.latestCheckpoint) {
		throw new Error("Cursor SDK source agent has no conversation checkpoint");
	}

	const agentId = `agent-${randomUUID()}`;
	try {
		let cursor: string | undefined;
		do {
			const page = await sourceStore.checkpoints.list({
				filter: { agentIds: [sourceAgentId], cursor },
			});
			for (const blobId of page.items) {
				const data = await sourceStore.checkpoints.get({ agentId: sourceAgentId, blobId });
				if (!data) throw new Error(`Cursor SDK checkpoint blob not found: ${blobId}`);
				await targetStore.checkpoints.create({ agentId, blobId, data });
			}
			cursor = page.nextCursor;
		} while (cursor);

		if (
			!(await targetStore.checkpoints.get({
				agentId,
				blobId: source.latestCheckpoint.rootBlobId,
			}))
		) {
			throw new Error("Cursor SDK source checkpoint root is missing");
		}
		const now = Date.now();
		await targetStore.agents.create({
			agent: {
				...source,
				agentId,
				cwd,
				status: "idle",
				activeRunId: null,
				createdAt: now,
				updatedAt: now,
			},
		});
		return agentId;
	} catch (error) {
		if (await targetStore.agents.get({ agentId })) {
			await targetStore.agents.delete({ filter: { agentIds: [agentId] } });
		}
		await targetStore.checkpoints.delete({ filter: { agentIds: [agentId] } });
		throw error;
	}
}
