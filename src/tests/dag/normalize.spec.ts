import { describe, expect, it } from "vitest";
import { buildWildcardPrefixes, normalizePath } from "../../dag/index.js";

describe("buildWildcardPrefixes", () => {
	it("collects prefixes ending in a wildcard segment", () => {
		const prefixes = buildWildcardPrefixes([
			"items.*.tax",
			"sections.*.rows.*.total",
			"plain.value",
		]);
		expect(prefixes.has("items.*")).toBe(true);
		expect(prefixes.has("sections.*")).toBe(true);
		expect(prefixes.has("sections.*.rows.*")).toBe(true);
		expect(prefixes.has("plain")).toBe(false);
	});
});

describe("normalizePath", () => {
	it("rewrites every numeric segment to * without prefix info (legacy)", () => {
		expect(normalizePath("items.0.price")).toBe("items.*.price");
		expect(normalizePath("config.404")).toBe("config.*");
	});

	it("only rewrites numeric segments at known wildcard positions", () => {
		const prefixes = buildWildcardPrefixes(["items.*.price"]);
		// genuine array index at a wildcard position
		expect(normalizePath("items.0.price", prefixes)).toBe("items.*.price");
		// numeric object key that is NOT a wildcard position stays literal
		expect(normalizePath("config.404", prefixes)).toBe("config.404");
	});

	it("leaves non-numeric paths untouched", () => {
		const prefixes = buildWildcardPrefixes(["items.*.price"]);
		expect(normalizePath("nested.value", prefixes)).toBe("nested.value");
	});
});
