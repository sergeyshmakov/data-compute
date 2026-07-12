import { describe, expect, it } from "vitest";
import { normalizePath, pathDependencies } from "../../dag/index.js";

describe("normalizePath", () => {
	it("replaces numeric segments with asterisk", () => {
		expect(normalizePath("items.0.price")).toBe("items.*.price");
	});

	it("handles nested array indices", () => {
		expect(normalizePath("nested.array.1")).toBe("nested.array.*");
	});

	it("leaves paths without digits unchanged", () => {
		expect(normalizePath("a.b.c")).toBe("a.b.c");
	});

	it("replaces single numeric segment", () => {
		expect(normalizePath("0")).toBe("*");
	});

	it("replaces multiple numeric segments", () => {
		expect(normalizePath("items.0.1.price")).toBe("items.*.*.price");
	});
});

describe("pathDependencies", () => {
	it("includes single accessed path when self is different", () => {
		const result = pathDependencies(new Set(["a"]), "b");
		expect(result).toContain("a");
		expect(result.size).toBe(1);
	});

	it("includes full path and all parent paths for nested access", () => {
		const result = pathDependencies(new Set(["a.b.c"]), "x");
		expect(result).toContain("a");
		expect(result).toContain("a.b");
		expect(result).toContain("a.b.c");
		expect(result.size).toBe(3);
	});

	it("excludes self from dependencies", () => {
		const result = pathDependencies(new Set(["a"]), "a");
		expect(result).not.toContain("a");
		expect(result.size).toBe(0);
	});

	it("normalizes numeric indices and adds parent paths", () => {
		const result = pathDependencies(new Set(["items.0.price"]), "total");
		expect(result).toContain("items.*.price");
		expect(result).toContain("items");
		expect(result).toContain("items.*");
	});

	it("handles multiple accessed paths", () => {
		const result = pathDependencies(new Set(["a", "b.c"]), "x");
		expect(result).toContain("a");
		expect(result).toContain("b");
		expect(result).toContain("b.c");
	});
});
