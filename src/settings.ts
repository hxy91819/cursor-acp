export const ADAPTER_NAME = "cursor-acp";

export const ADVERTISED_MODE_IDS = ["auto-review", "accept-edits", "yolo", "ask", "plan"] as const;

export const LEGACY_MODE_ALIASES = {
	default: "auto-review",
	acceptEdits: "accept-edits",
	agent: "auto-review",
	autoReview: "auto-review",
} as const;

type AdvertisedModeId = (typeof ADVERTISED_MODE_IDS)[number];
export type SessionModeId = "default" | AdvertisedModeId;

export type AgentSessionModeId = Extract<
	SessionModeId,
	"default" | "auto-review" | "accept-edits" | "yolo"
>;

export function isAgentSessionMode(modeId: SessionModeId): modeId is AgentSessionModeId {
	return (
		modeId === "default" ||
		modeId === "auto-review" ||
		modeId === "accept-edits" ||
		modeId === "yolo"
	);
}

export type BbPermissionMode = "full" | "accept-edits";

export function parseBbPermissionMode(args: readonly string[]): BbPermissionMode | undefined {
	const flags = args.filter((arg) => arg.startsWith("--bb-permission-mode="));
	if (flags.length === 0) return undefined;
	if (flags.length !== 1) throw new Error("Duplicate --bb-permission-mode argument");
	const value = flags[0]!.slice("--bb-permission-mode=".length);
	if (value === "full" || value === "accept-edits") return value;
	throw new Error(`Invalid BB permission mode: ${value}`);
}

export function bbPermissionSessionMode(mode: BbPermissionMode): AgentSessionModeId {
	return mode === "full" ? "yolo" : "accept-edits";
}

export const DEFAULT_MODE_ID: SessionModeId = "auto-review";

export function getEnvDefaultMode(): SessionModeId | undefined {
	const raw = process.env.CURSOR_ACP_DEFAULT_MODE;
	if (!raw) {
		return undefined;
	}
	const normalized = normalizeModeId(raw.trim());
	return normalized ?? undefined;
}

export function getEnvDefaultModel(): string | undefined {
	const raw = process.env.CURSOR_ACP_DEFAULT_MODEL;
	if (!raw) {
		return undefined;
	}
	const trimmed = raw.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

export function getEnvDefaultThinking(): string | undefined {
	const raw = process.env.CURSOR_ACP_DEFAULT_THINKING;
	if (!raw) {
		return undefined;
	}
	const trimmed = raw.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

export function normalizeModeId(value: string): SessionModeId | null {
	if (ADVERTISED_MODE_IDS.includes(value as AdvertisedModeId)) {
		return value as AdvertisedModeId;
	}

	if (value in LEGACY_MODE_ALIASES) {
		return LEGACY_MODE_ALIASES[value as keyof typeof LEGACY_MODE_ALIASES];
	}

	return null;
}

/** Human-readable label for slash commands and UI `name` fields (ids stay lowercase). */
export function modeDisplayName(modeId: SessionModeId): string {
	switch (modeId) {
		case "default":
			return "Default (Auto-review)";
		case "auto-review":
			return "Auto-review";
		case "accept-edits":
			return "Accept edits";
		case "yolo":
			return "Yolo";
		case "ask":
			return "Ask";
		case "plan":
			return "Plan";
	}
}

export function availableModes(currentModeId: SessionModeId) {
	return {
		currentModeId,
		availableModes: [
			{
				id: "auto-review",
				name: "Auto-review",
				description:
					"Cursor Smart Auto Review runs approved tool calls and fails closed on the rest",
			},
			{
				id: "accept-edits",
				name: "Accept edits",
				description: "Run inside Cursor's local sandbox without Smart Auto Review",
			},
			{
				id: "yolo",
				name: "Yolo",
				description: "Run local tool calls without Auto Review",
			},
			{
				id: "ask",
				name: "Ask",
				description: "Q&A mode with no edits or command execution",
			},
			{
				id: "plan",
				name: "Plan",
				description: "Read-only planning mode",
			},
		],
	};
}
