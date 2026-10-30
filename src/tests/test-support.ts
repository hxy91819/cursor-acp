import type { InitializeRequest, NewSessionRequest } from "@agentclientprotocol/sdk";
import type {
	ExtendedInitializeRequest,
	ExtendedNewSessionRequest,
} from "../acp-request-extensions.js";
import type { Logger } from "../utils.js";

export const noopLogger: Logger = { log() {}, error() {} };

export function initRequest(
	overrides: Partial<InitializeRequest> &
		Omit<ExtendedInitializeRequest, keyof InitializeRequest> = {},
): InitializeRequest {
	return { protocolVersion: 1, clientCapabilities: {}, ...overrides } as InitializeRequest;
}

export function newSessionRequest(
	overrides: Partial<NewSessionRequest> &
		Omit<ExtendedNewSessionRequest, keyof NewSessionRequest> = {},
): NewSessionRequest {
	return { cwd: "/tmp", mcpServers: [], ...overrides } as NewSessionRequest;
}
