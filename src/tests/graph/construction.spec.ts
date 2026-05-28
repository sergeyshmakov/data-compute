import { describe, expect, it } from "vitest";
import { createGraph } from "../../graph/index.js";
import type {
	AbRoot,
	DepsRoot,
	ItemsTotalRoot,
	TraceAbcRoot,
} from "./test-types.js";

describe("createGraph construction", () => {
	describe("sync formulas build correct order", () => {
		it("linear chain a->b->c executes in dependency order", () => {
			const graph = createGraph<TraceAbcRoot>({
				a: () => 1,
				b: (f) => f.a + 1,
				c: (f) => f.b + 1,
			});
			expect(graph.order).toEqual(["a", "b", "c"]);
		});

		it("diamond a->b,c->d has a first and d last", () => {
			interface DiamondRoot {
				a: number;
				b: number;
				c: number;
				d: number;
			}
			const graph = createGraph<DiamondRoot>({
				a: () => 1,
				b: (f) => f.a + 1,
				c: (f) => f.a + 2,
				d: (f) => f.b + f.c,
			});
			expect(graph.order?.[0]).toBe("a");
			expect(graph.order?.[3]).toBe("d");
			expect(graph.order).toContain("b");
			expect(graph.order).toContain("c");
			expect(graph.order).toHaveLength(4);
		});

		it("formula order in definition does not affect execution order", () => {
			const graph = createGraph<DepsRoot>({
				total: (f) => f.subtotal + f.tax,
				subtotal: (f) => f.quantity * f.unitPrice,
				tax: (f) => f.subtotal * f.taxRate,
			});
			const order = graph.order ?? [];
			const subtotalIdx = order.indexOf("subtotal");
			const taxIdx = order.indexOf("tax");
			const totalIdx = order.indexOf("total");
			expect(subtotalIdx).toBeLessThan(totalIdx);
			expect(taxIdx).toBeLessThan(totalIdx);
		});
	});

	describe("dependency extraction", () => {
		it("formula reading f.pricing.taxRate produces dep on pricing", () => {
			interface PricingTotalRoot {
				pricing: { taxRate: number };
				total: number;
			}
			const graph = createGraph<PricingTotalRoot>({
				pricing: () => ({ taxRate: 0.1 }),
				total: (f) => f.pricing.taxRate * 100,
			});
			const deps = graph.deps((x: PricingTotalRoot) => x.total);
			expect(deps).toContain("pricing");
		});

		it("self-references are excluded", () => {
			const graph = createGraph<{ a: number }>({
				a: (f) => f.a + 1,
			});
			const deps = graph.deps((x: { a: number }) => x.a);
			expect(deps).not.toContain("a");
		});
	});

	describe("native array tracking", () => {
		it("formula with f.items.reduce produces dep on items", () => {
			const graph = createGraph<ItemsTotalRoot>({
				total: (f) =>
					f.items.reduce((sum: number, item) => sum + item.price, 0),
			});
			const deps = graph.deps((x: ItemsTotalRoot) => x.total);
			expect(deps).toContain("items");
		});

		it("formula with f.items.find tracks all elements before short-circuit", () => {
			interface ItemsFoundRoot {
				items: { id: number }[];
				found: { id: number } | undefined;
			}
			const graph = createGraph<ItemsFoundRoot>({
				found: (f) => f.items.find((x) => x.id === 1),
			});
			const deps = graph.deps((x: ItemsFoundRoot) => x.found);
			expect(deps).toContain("items");
		});
	});

	describe("cyclic graph", () => {
		it("throws with default cyclic when a->b->c->a", () => {
			interface CyclicRoot {
				a: number;
				b: number;
				c: number;
			}
			expect(() =>
				createGraph<CyclicRoot>({
					a: (f) => f.c + 1,
					b: (f) => f.a + 1,
					c: (f) => f.b + 1,
				}),
			).toThrow("Cyclic dependency detected");
		});

		it("rejects unsupported cyclic freeze mode", () => {
			interface CyclicFreezeRoot {
				a: number;
				b: number;
				c: number;
			}
			expect(() =>
				createGraph<CyclicFreezeRoot>(
					{
						a: (f) => (f as { c?: number }).c ?? 0,
						b: (f) => f.a + 1,
						c: (f) => f.b + 1,
					},
					undefined,
					{ cyclic: "freeze" as "error" },
				),
			).toThrow('Unsupported cyclic mode "freeze"');
		});
	});

	describe("async formula in dry-run", () => {
		it("sync accesses before first await are captured", () => {
			interface AsyncSourceRoot {
				source: string;
				asyncData: string;
			}
			const graph = createGraph<AsyncSourceRoot>({
				asyncData: async (f) => {
					const x = f.source;
					await Promise.resolve();
					return x;
				},
			});
			const deps = graph.deps((x: AsyncSourceRoot) => x.asyncData);
			expect(deps).toContain("source");
		});
	});

	describe("computedKeys, nodes, order", () => {
		it("match formula keys and are topologically ordered", () => {
			interface XyzRoot {
				x: number;
				y: number;
				z: number;
			}
			const graph = createGraph<XyzRoot>({
				z: (f) => f.y,
				y: (f) => f.x,
				x: () => 1,
			});
			expect(graph.computedKeys).toEqual(
				expect.arrayContaining(["x", "y", "z"]),
			);
			expect(graph.nodes).toEqual(graph.computedKeys);
			expect(graph.order).toEqual(["x", "y", "z"]);
		});
	});

	describe("hasCycle", () => {
		it("is false for DAG", () => {
			const graph = createGraph<AbRoot>({
				a: () => 1,
				b: (f) => f.a,
			});
			expect(graph.hasCycle).toBe(false);
		});

		it("is not observable for unsupported cyclic freeze mode", () => {
			interface CyclicFreezeRoot {
				a: number;
				b: number;
				c: number;
			}
			expect(() =>
				createGraph<CyclicFreezeRoot>(
					{
						a: (f) => (f as { c?: number }).c ?? 0,
						b: (f) => f.a,
						c: (f) => f.b,
					},
					undefined,
					{ cyclic: "freeze" as "error" },
				),
			).toThrow('Unsupported cyclic mode "freeze"');
		});
	});

	describe("empty formulas", () => {
		it("creates graph with empty order and no cycle", () => {
			interface EmptyRoot {
				foo?: number;
			}
			const graph = createGraph<EmptyRoot>({});
			expect(graph.order).toEqual([]);
			expect(graph.hasCycle).toBe(false);
			expect(graph.computedKeys).toEqual([]);
		});
	});
});
