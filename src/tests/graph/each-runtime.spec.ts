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

	it("applies interceptors to each runtime outcomes before dependent nodes run", async () => {
		interface Root {
			items: { price: number; total: number }[];
			grandTotal: number;
		}
		const graph = createGraph<Root>(
			{
				items: each({
					total: (item) => item.price * 10,
				}),
				grandTotal: (f) => f.items.reduce((sum, item) => sum + item.total, 0),
			},
			undefined,
			{
				interceptors: [
					(path, value, _state, next) =>
						next(
							path.endsWith(".total") ? Math.min(value as number, 15) : value,
						),
				],
			},
		);

		await expect(
			graph.compute({
				items: [
					{ price: 2, total: 0 },
					{ price: 3, total: 0 },
				],
			}),
		).resolves.toEqual({
			items: [
				{ price: 2, total: 15 },
				{ price: 3, total: 15 },
			],
			grandTotal: 30,
		});
	});
});
