import { describe, expect, it } from "vitest";
import { createGraph, each } from "../../index.js";

describe("dependency extraction through array-method callbacks", () => {
	it("statically captures each-computed deps read inside reduce", () => {
		interface Root {
			items: { price: number; tax: number }[];
			total: number;
		}
		const graph = createGraph<Root>({
			items: each({ tax: (item) => item.price * 0.2 }),
			total: (f) => f.items.reduce((sum, item) => sum + item.tax, 0),
		});

		// total reads item.tax inside reduce; that computed each node must be a
		// static dependency so total is ordered after it without a runtime retry.
		expect(graph.deps((x) => x.total)).toContain("items.*.tax");
		expect(graph.order.indexOf("items.*.tax")).toBeLessThan(
			graph.order.indexOf("total"),
		);
	});

	it("computes the reduce aggregate correctly", async () => {
		interface Root {
			items: { price: number; tax: number }[];
			total: number;
		}
		const graph = createGraph<Root>({
			items: each({ tax: (item) => item.price * 0.2 }),
			total: (f) => f.items.reduce((sum, item) => sum + item.tax, 0),
		});

		const result = await graph.compute({
			items: [
				{ price: 100, tax: 0 },
				{ price: 200, tax: 0 },
			],
		});

		expect(result.total).toBe(60); // 20 + 40
	});
});
