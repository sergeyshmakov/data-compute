import { describe, expect, it, vi } from "vitest";
import { flattenGraph } from "../../graph/flatten.js";
import { batchRequest, each, request } from "../../index.js";

describe("flattenGraph", () => {
	it("returns empty array for empty formulas", () => {
		const result = flattenGraph(
			{} as unknown as Parameters<typeof flattenGraph>[0],
		);
		expect(result).toEqual([]);
	});

	it("flattens single formula", () => {
		const result = flattenGraph({ a: () => 1 } as unknown as Parameters<
			typeof flattenGraph
		>[0]);
		expect(result).toHaveLength(1);
		expect(result[0]).toMatchObject({
			path: "a",
			type: "formula",
			isEach: false,
		});
		expect(typeof result[0].fn).toBe("function");
	});

	it("flattens nested formulas", () => {
		const result = flattenGraph({
			pricing: { taxRate: () => 0.1 },
		} as unknown as Parameters<typeof flattenGraph>[0]);
		expect(result).toHaveLength(1);
		expect(result[0]).toMatchObject({
			path: "pricing.taxRate",
			type: "formula",
			isEach: false,
		});
	});

	it("flattens each() with item formula", () => {
		const result = flattenGraph({
			items: each({ price: (i: { cost: number }) => i.cost } as never),
		} as unknown as Parameters<typeof flattenGraph>[0]);
		expect(result).toHaveLength(1);
		expect(result[0]).toMatchObject({
			path: "items.*.price",
			type: "formula",
			isEach: true,
		});
	});

	it("flattens batchRequest data source", () => {
		const queryFn = vi.fn().mockResolvedValue([]);
		const result = flattenGraph(undefined, {
			api: batchRequest(() => ({ id: 1 }), { query: queryFn }),
		} as unknown as Parameters<typeof flattenGraph>[1]);
		expect(result).toHaveLength(1);
		expect(result[0]).toMatchObject({
			path: "api",
			type: "batch",
			isEach: false,
		});
		expect(result[0].config).toBeDefined();
	});

	it("flattens request data source", () => {
		const queryFn = vi.fn().mockResolvedValue({ ok: true });
		const result = flattenGraph(undefined, {
			api: request(() => ({ id: 1 }), {
				query: queryFn as (req: { id: number }) => Promise<{ ok: boolean }>,
			}),
		} as unknown as Parameters<typeof flattenGraph>[1]);
		expect(result).toHaveLength(1);
		expect(result[0]).toMatchObject({
			path: "api",
			type: "request",
			isEach: false,
		});
		expect(result[0].config).toBeDefined();
	});

	it("combines formulas and dataSources", () => {
		const queryFn = vi.fn().mockResolvedValue([]);
		const result = flattenGraph(
			{
				total: (f: { a: number; b: number }) => f.a + f.b,
			} as unknown as Parameters<typeof flattenGraph>[0],
			{
				api: batchRequest(() => ({}), { query: queryFn }),
			} as unknown as Parameters<typeof flattenGraph>[1],
		);
		expect(result).toHaveLength(2);
		const formulaNode = result.find((n) => n.path === "total");
		const apiNode = result.find((n) => n.path === "api");
		expect(formulaNode).toMatchObject({ type: "formula" });
		expect(apiNode).toMatchObject({ type: "batch" });
	});

	it("returns empty when both args undefined", () => {
		const result = flattenGraph(undefined, undefined);
		expect(result).toEqual([]);
	});
});
