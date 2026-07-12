import { describe, expect, it, vi } from "vitest";
import { flattenGraph } from "../../graph/flatten.js";
import { batchRequest, createGraph, eachDataSource } from "../../index.js";
import type { BatchEntry, BatchOutcome } from "../../types.js";

interface Item {
	id: number;
	amount: number;
}
interface Root {
	items: Item[];
}

describe("eachDataSource runtime behavior", () => {
	it("coalesces per-item batchRequests into a single query and maps responses", async () => {
		const query = vi.fn(
			async (entries: readonly BatchEntry<{ id: number }>[]) =>
				entries.map((e) => ({ id: e.id, response: e.request.id * 10 })),
		);

		const graph = createGraph<Root>(
			{},
			{
				items: eachDataSource({
					amount: batchRequest((item) => ({ id: item.id }), { query }),
				}),
			},
		);

		const result = await graph.compute({
			items: [
				{ id: 1, amount: 0 },
				{ id: 2, amount: 0 },
				{ id: 3, amount: 0 },
			],
		});

		expect(query).toHaveBeenCalledTimes(1);
		expect(result).toEqual({
			items: [
				{ id: 1, amount: 10 },
				{ id: 2, amount: 20 },
				{ id: 3, amount: 30 },
			],
		});
		expect(graph.status("items.*.amount")).toBe("ready");
	});

	it("deduplicates items sharing a dedupeKey and fans the response back out", async () => {
		const query = vi.fn(
			async (entries: readonly BatchEntry<{ id: number }>[]) =>
				entries.map((e) => ({ id: e.id, response: e.request.id * 10 })),
		);

		const graph = createGraph<Root>(
			{},
			{
				items: eachDataSource({
					amount: batchRequest((item) => ({ id: item.id }), {
						query,
						dedupeKey: (req) => String(req.id),
					}),
				}),
			},
		);

		const result = await graph.compute({
			items: [
				{ id: 1, amount: 0 },
				{ id: 1, amount: 0 },
				{ id: 2, amount: 0 },
			],
		});

		expect(query).toHaveBeenCalledTimes(1);
		expect(query.mock.calls[0][0]).toHaveLength(2); // deduped to 2 entries
		expect(result).toEqual({
			items: [
				{ id: 1, amount: 10 },
				{ id: 1, amount: 10 },
				{ id: 2, amount: 20 },
			],
		});
	});

	it("marks the each node error and reports onError when one item's query fails", async () => {
		const onError = vi.fn();
		const query = vi.fn(
			async (
				entries: readonly BatchEntry<{ id: number }>[],
			): Promise<BatchOutcome<number>[]> =>
				entries.map((e) =>
					e.request.id === 2
						? { id: e.id, error: new Error("boom") }
						: { id: e.id, response: e.request.id * 10 },
				),
		);

		const graph = createGraph<Root>(
			{},
			{
				items: eachDataSource({
					amount: batchRequest((item) => ({ id: item.id }), { query }),
				}),
			},
			{ onError },
		);

		const result = await graph.compute({
			items: [
				{ id: 1, amount: 0 },
				{ id: 2, amount: 0 },
			],
		});

		expect(graph.status("items.*.amount")).toBe("error");
		expect(onError).toHaveBeenCalledWith(
			expect.objectContaining({ key: "items.1.amount" }),
		);
		// Successful sibling is still committed.
		expect(result.items?.[0]).toEqual({ id: 1, amount: 10 });
	});
});

describe("eachDataSource flattening", () => {
	it("produces isEach data-source nodes at the wildcard path", () => {
		const nodes = flattenGraph<Root>(undefined, {
			items: eachDataSource({
				amount: batchRequest((item) => ({ id: item.id }), {
					query: async () => [],
				}),
			}),
		});

		const amount = nodes.find((n) => n.path === "items.*.amount");
		expect(amount).toBeDefined();
		expect(amount?.isEach).toBe(true);
		expect(amount?.type).toBe("batch");
	});
});
