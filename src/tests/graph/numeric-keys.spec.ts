import { describe, expect, it } from "vitest";
import { createGraph, each } from "../../index.js";

describe("numeric object keys (not array indices)", () => {
	interface Root {
		items: { 0: number };
		dependent: number;
	}

	it("orders a dependent after a producer keyed by a numeric object key", () => {
		const graph = createGraph<Root>({
			items: { 0: () => 5 },
			dependent: (s) => (s.items[0] ?? 0) + 100,
		});

		expect(graph.order.indexOf("items.0")).toBeLessThan(
			graph.order.indexOf("dependent"),
		);
		expect(graph.deps((x) => x.dependent)).toContain("items.0");
	});

	it("computes the dependent correctly and keeps the object shape (not an array)", async () => {
		const graph = createGraph<Root>({
			items: { 0: () => 5 },
			dependent: (s) => (s.items[0] ?? 0) + 100,
		});

		const result = await graph.compute({});

		expect(result.dependent).toBe(105);
		expect(result.items).toEqual({ 0: 5 });
		expect(Array.isArray(result.items)).toBe(false);
	});

	it("still treats genuine array indices as wildcards for each() nodes", async () => {
		interface ArrRoot {
			list: { value: number; doubled: number }[];
		}
		const graph = createGraph<ArrRoot>({
			list: each({
				doubled: (item) => item.value * 2,
			}),
		});

		const result = await graph.compute({
			list: [
				{ value: 1, doubled: 0 },
				{ value: 2, doubled: 0 },
			],
		});

		expect(Array.isArray(result.list)).toBe(true);
		expect(result.list).toEqual([
			{ value: 1, doubled: 2 },
			{ value: 2, doubled: 4 },
		]);
	});
});
