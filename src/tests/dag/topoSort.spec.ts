import { describe, expect, it } from "vitest";
import { topoSort } from "../../dag/index.js";

describe("topoSort", () => {
	describe("empty and single node", () => {
		it("returns empty order and no cycle for empty nodes", () => {
			const result = topoSort([], new Map());
			expect(result.order).toEqual([]);
			expect(result.hasCycle).toBe(false);
		});

		it("returns single node and no cycle for single node with no deps", () => {
			const result = topoSort(["a"], new Map());
			expect(result.order).toEqual(["a"]);
			expect(result.hasCycle).toBe(false);
		});
	});

	describe("linear dependency chain", () => {
		it("returns a,b,c when b depends on a and c depends on b", () => {
			const adj = new Map<string, Set<string>>([
				["a", new Set()],
				["b", new Set(["a"])],
				["c", new Set(["b"])],
			]);
			const result = topoSort(["a", "b", "c"], adj);
			expect(result.order).toEqual(["a", "b", "c"]);
			expect(result.hasCycle).toBe(false);
		});
	});

	describe("diamond DAG", () => {
		it("returns a first and d last when a -> b,c -> d", () => {
			const adj = new Map<string, Set<string>>([
				["a", new Set()],
				["b", new Set(["a"])],
				["c", new Set(["a"])],
				["d", new Set(["b", "c"])],
			]);
			const result = topoSort(["a", "b", "c", "d"], adj);
			expect(result.order[0]).toBe("a");
			expect(result.order[3]).toBe("d");
			expect(result.order).toContain("b");
			expect(result.order).toContain("c");
			expect(result.order.length).toBe(4);
			expect(result.hasCycle).toBe(false);
		});
	});

	describe("cycle detection", () => {
		it("sets hasCycle true when a -> b -> c -> a", () => {
			const adj = new Map<string, Set<string>>([
				["a", new Set(["c"])],
				["b", new Set(["a"])],
				["c", new Set(["b"])],
			]);
			const result = topoSort(["a", "b", "c"], adj);
			expect(result.hasCycle).toBe(true);
			expect(result.order.length).toBeLessThan(3);
		});
	});

	describe("disconnected components", () => {
		it("returns all nodes in order with no cycle for independent subgraphs", () => {
			const adj = new Map<string, Set<string>>([
				["a", new Set()],
				["b", new Set(["a"])],
				["x", new Set()],
				["y", new Set(["x"])],
			]);
			const result = topoSort(["a", "b", "x", "y"], adj);
			expect(result.order.length).toBe(4);
			expect(result.hasCycle).toBe(false);
			const aIdx = result.order.indexOf("a");
			const bIdx = result.order.indexOf("b");
			const xIdx = result.order.indexOf("x");
			const yIdx = result.order.indexOf("y");
			expect(aIdx).toBeLessThan(bIdx);
			expect(xIdx).toBeLessThan(yIdx);
		});
	});

	describe("nodes with no deps", () => {
		it("places nodes not in adj early in order", () => {
			const adj = new Map<string, Set<string>>([["b", new Set(["a"])]]);
			const result = topoSort(["a", "b"], adj);
			expect(result.order[0]).toBe("a");
			expect(result.order[1]).toBe("b");
			expect(result.hasCycle).toBe(false);
		});
	});

	describe("deps outside node set", () => {
		it("ignores deps not in nodes", () => {
			const adj = new Map<string, Set<string>>([["a", new Set(["external"])]]);
			const result = topoSort(["a"], adj);
			expect(result.order).toEqual(["a"]);
			expect(result.hasCycle).toBe(false);
		});
	});

	describe("edge cases", () => {
		it("empty adj with non-empty nodes returns all nodes in arbitrary order", () => {
			const result = topoSort(["a", "b", "c"], new Map());
			expect(result.order).toHaveLength(3);
			expect(result.order).toContain("a");
			expect(result.order).toContain("b");
			expect(result.order).toContain("c");
			expect(result.hasCycle).toBe(false);
		});

		it("adj references nodes not in nodes list are ignored", () => {
			const adj = new Map<string, Set<string>>([
				["a", new Set()],
				["b", new Set(["a"])],
				["orphan", new Set(["nonexistent"])],
			]);
			const result = topoSort(["a", "b"], adj);
			expect(result.order).toEqual(["a", "b"]);
			expect(result.hasCycle).toBe(false);
		});

		it("deduplicates input nodes without reporting a false cycle", () => {
			const adj = new Map<string, Set<string>>([
				["a", new Set()],
				["b", new Set(["a"])],
			]);
			const result = topoSort(["a", "a", "b"], adj);
			expect(result.order).toEqual(["a", "b"]);
			expect(result.hasCycle).toBe(false);
		});
	});
});
