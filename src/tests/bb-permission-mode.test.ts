import { describe, expect, it } from "vitest";
import { parseBbPermissionMode } from "../settings.js";

describe("BB permission CLI", () => {
	it("accepts only explicit supported modes", () => {
		expect(parseBbPermissionMode([])).toBeUndefined();
		expect(parseBbPermissionMode(["--bb-permission-mode=full"])).toBe("full");
		expect(parseBbPermissionMode(["--bb-permission-mode=accept-edits"])).toBe("accept-edits");
		expect(() => parseBbPermissionMode(["--bb-permission-mode=auto"])).toThrow();
		expect(() =>
			parseBbPermissionMode(["--bb-permission-mode=full", "--bb-permission-mode=full"]),
		).toThrow();
	});
});
