import { describe, expect, it } from "vitest";
import { setByPath } from "../../graph/path-utils.js";

describe("path utils", () => {
	it("rejects prototype-polluting path segments", () => {
		try {
			for (const path of [
				"__proto__.polluted",
				"safe.constructor.polluted",
				"safe.prototype.polluted",
			]) {
				expect(() => setByPath({}, path, true)).toThrow(/Unsafe path segment/);
			}
			expect(({} as Record<string, unknown>).polluted).toBeUndefined();
		} finally {
			delete (Object.prototype as Record<string, unknown>).polluted;
		}
	});
});
