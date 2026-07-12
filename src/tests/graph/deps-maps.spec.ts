import { describe, expect, it } from "vitest";
import { buildDepsMap, buildReverseDepsMap } from "../../graph/deps-maps.js";
import type { FlatNode } from "../../graph/flatten.js";
import { flattenGraph } from "../../graph/flatten.js";

function node(
	path: string,
	fn: (state: unknown, root: unknown) => unknown,
	isEach = false,
): FlatNode {
	return {
		path,
		type: "formula",
		isEach,
		fn,
	};
}

describe("buildDepsMap", () => {
	it("captures deps for flat formula reading f.a and f.b", () => {
		const nodes: FlatNode[] = [
			node(
				"total",
				(s) =>
					(s as { a: number; b: number }).a + (s as { a: number; b: number }).b,
			),
		];
		const depsMap = buildDepsMap(nodes);
		const deps = depsMap.get("total");
		expect(deps).toBeDefined();
		expect(deps).toContain("a");
		expect(deps).toContain("b");
		expect(deps?.size).toBe(2);
	});

	it("captures nested access for f.pricing.taxRate", () => {
		const nodes: FlatNode[] = [
			node(
				"total",
				(s) => (s as { pricing: { taxRate: number } }).pricing.taxRate * 100,
			),
		];
		const depsMap = buildDepsMap(nodes);
		const deps = depsMap.get("total");
		expect(deps).toBeDefined();
		expect(deps).toContain("pricing");
		expect(deps).toContain("pricing.taxRate");
	});

	it("excludes self-reference from deps", () => {
		const nodes: FlatNode[] = [
			node("total", (s) => (s as { total: number }).total + 1),
		];
		const depsMap = buildDepsMap(nodes);
		const deps = depsMap.get("total");
		expect(deps).toBeDefined();
		expect(deps).not.toContain("total");
	});

	it("captures item and root deps for each node", () => {
		const nodes: FlatNode[] = [
			node(
				"items.*.sum",
				(item, root) => (item as { x: number }).x + (root as { y: number }).y,
				true,
			),
		];
		const depsMap = buildDepsMap(nodes);
		const deps = depsMap.get("items.*.sum");
		expect(deps).toBeDefined();
		expect(deps).toContain("items.*.x");
		expect(deps).toContain("y");
	});

	it("anchors nested each item deps at the wildcard item path", () => {
		const nodes: FlatNode[] = [
			node(
				"items.*.pricing.tax",
				(item) => (item as { pricing: { base: number } }).pricing.base * 0.1,
				true,
			),
		];
		const depsMap = buildDepsMap(nodes);
		const deps = depsMap.get("items.*.pricing.tax");
		expect(deps).toContain("items.*.pricing.base");
		expect(deps).not.toContain("items.*.pricing.pricing.base");
	});

	it("returns empty deps for formula with no reads", () => {
		const nodes: FlatNode[] = [node("a", () => 1)];
		const depsMap = buildDepsMap(nodes);
		const deps = depsMap.get("a");
		expect(deps).toBeDefined();
		expect(deps?.size).toBe(0);
	});

	it("documents that plain conditionals only record the executed dry-run branch", () => {
		const nodes: FlatNode[] = [
			node("discount", (s) =>
				(s as { flag: boolean; a: number; b: number }).flag
					? (s as { flag: boolean; a: number; b: number }).a
					: (s as { flag: boolean; a: number; b: number }).b,
			),
		];
		const depsMap = buildDepsMap(nodes);
		const deps = depsMap.get("discount");
		expect(deps).toContain("flag");
		expect(deps).toContain("a");
		expect(deps).not.toContain("b");
	});
});

describe("buildReverseDepsMap", () => {
	it("reverses dependency map correctly", () => {
		const depsMap = new Map<string, Set<string>>([
			["a", new Set()],
			["b", new Set(["a"])],
			["c", new Set(["a", "b"])],
		]);
		const reverse = buildReverseDepsMap(depsMap);
		expect(reverse.get("a")).toEqual(new Set(["b", "c"]));
		expect(reverse.get("b")).toEqual(new Set(["c"]));
	});

	it("returns empty map for empty depsMap", () => {
		const reverse = buildReverseDepsMap(new Map());
		expect(reverse.size).toBe(0);
	});

	it("works with flattenGraph output", () => {
		interface ChainRoot {
			a: number;
			b: number;
			c: number;
		}
		const flatNodes = flattenGraph<ChainRoot>({
			a: () => 1,
			b: (f) => f.a + 1,
			c: (f) => f.b + 1,
		});
		const depsMap = buildDepsMap(flatNodes);
		const reverse = buildReverseDepsMap(depsMap);
		expect(reverse.get("a")).toContain("b");
		expect(reverse.get("b")).toContain("c");
	});
});
