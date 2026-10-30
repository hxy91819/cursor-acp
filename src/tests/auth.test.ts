import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CursorAuth } from "../auth.js";

const sdkMocks = vi.hoisted(() => ({
	login: vi.fn(),
	logout: vi.fn(),
	status: vi.fn(),
	me: vi.fn(),
}));

vi.mock("@cursor/sdk", () => ({
	Cursor: {
		auth: { login: sdkMocks.login, logout: sdkMocks.logout, status: sdkMocks.status },
		me: sdkMocks.me,
	},
}));

const originalApiKey = process.env.CURSOR_API_KEY;

beforeEach(() => {
	vi.clearAllMocks();
	delete process.env.CURSOR_API_KEY;
	sdkMocks.status.mockResolvedValue({ status: "logged-out" });
});

afterEach(() => {
	if (originalApiKey === undefined) delete process.env.CURSOR_API_KEY;
	else process.env.CURSOR_API_KEY = originalApiKey;
});

describe("CursorAuth", () => {
	it("uses persisted SDK login status", async () => {
		sdkMocks.status.mockResolvedValue({ status: "logged-in", email: "user@example.com" });

		await expect(new CursorAuth().status()).resolves.toMatchObject({
			loggedIn: true,
			account: "user@example.com",
		});
	});

	it("logs in through the SDK without exposing the minted key", async () => {
		sdkMocks.login.mockResolvedValue({
			apiKey: "secret-key",
			email: "user@example.com",
			apiKeyExpiresAtMs: Date.now() + 1_000,
		});

		const result = await new CursorAuth().login();

		expect(sdkMocks.login).toHaveBeenCalledWith({ apiKeyName: "cursor-acp" });
		expect(result.stdout).toContain("user@example.com");
		expect(result.stdout).not.toContain("secret-key");
	});
});
