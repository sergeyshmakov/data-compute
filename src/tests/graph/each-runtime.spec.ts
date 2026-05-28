import { describe, expect, it } from "vitest";
import { createGraph, each } from "../../index.js";

describe("each runtime expansion", () => {
	it("computes nested object paths inside each items", async () => {
		interface Root {
			items: { pricing: { base: number; tax: number } }[];
		}
		const graph = createGraph<Root>({
			items: each({
				pricing: {
					tax: (item) => item.pricing.base * 0.1,
				},
			}),
		});

		await expect(
			graph.compute({ items: [{ pricing: { base: 10, tax: 0 } }] }),
		).resolves.toEqual({
			items: [{ pricing: { base: 10, tax: 1 } }],
		});
	});

	it("computes paths with more than one wildcard", async () => {
		interface Root {
			sections: {
				rows: { qty: number; price: number; cellTotal: number }[];
			}[];
		}
		const graph = createGraph<Root>({
			sections: each({
				rows: each({
					cellTotal: (row) => row.qty * row.price,
				}),
			}),
		});

		await expect(
			graph.compute({
				sections: [{ rows: [{ qty: 2, price: 5, cellTotal: 0 }] }],
			}),
		).resolves.toEqual({
			sections: [{ rows: [{ qty: 2, price: 5, cellTotal: 10 }] }],
		});
	});
});
