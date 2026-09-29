import { Cursor } from "@cursor/sdk";
import { getCursorApiKey } from "./cursor-sdk-config.js";

export interface CommandResult {
	code: number;
	stdout: string;
	stderr: string;
}

export type ParsedAuthStatus =
	| { loggedIn: true; account: string; raw: string }
	| { loggedIn: false; raw: string };

export interface CursorAuthClient {
	status(): Promise<ParsedAuthStatus>;
	login(): Promise<CommandResult>;
	logout(): Promise<CommandResult>;
	ensureLoggedIn(): Promise<ParsedAuthStatus>;
}

export class CursorAuth implements CursorAuthClient {
	async status(): Promise<ParsedAuthStatus> {
		const apiKey = getCursorApiKey();
		if (apiKey) {
			try {
				const user = await Cursor.me({ apiKey });
				return {
					loggedIn: true,
					account: user.userEmail ?? user.apiKeyName,
					raw: "Authenticated with CURSOR_API_KEY",
				};
			} catch (error) {
				return {
					loggedIn: false,
					raw: error instanceof Error ? error.message : String(error),
				};
			}
		}

		const status = await Cursor.auth.status();
		return status.status === "logged-in"
			? { loggedIn: true, account: status.email ?? "Cursor SDK", raw: "SDK login active" }
			: { loggedIn: false, raw: "Not logged in" };
	}

	async login(): Promise<CommandResult> {
		const result = await Cursor.auth.login({ apiKeyName: "cursor-acp" });
		return {
			code: 0,
			stdout: result.email ? `Logged in as ${result.email}` : "Cursor SDK login completed",
			stderr: "",
		};
	}

	async logout(): Promise<CommandResult> {
		await Cursor.auth.logout();
		return {
			code: 0,
			stdout: "Logged out of stored Cursor SDK credentials",
			stderr: getCursorApiKey()
				? "CURSOR_API_KEY remains active until it is removed from the environment"
				: "",
		};
	}

	async ensureLoggedIn(): Promise<ParsedAuthStatus> {
		const current = await this.status();
		if (current.loggedIn) {
			return current;
		}

		await this.login();
		return await this.status();
	}
}
