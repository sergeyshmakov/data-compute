import { describe, expect, it, vi } from "vitest";
import { createGraph, each } from "../../index.js";

describe("branch-aware error gating", () => {
	interface Root {
		isPremium: boolean;
		base: number;
		premiumDiscount: number;
		standardDiscount: number;
		discount: number;
	}

	it("does not gate a node on an errored alternate-branch dep it did not read", async () => {
		const onError = vi.fn();
		const graph = createGraph<Root>(
			{
				premiumDiscount: (f) => f.base * 0.5,
				standardDiscount: (f) => {
					if (f.base < 0) throw new Error("bad base");
					return f.base * 0.1;
				},
				// Dry run takes the truthy branch → static dep is premiumDiscount.
				discount: (f) => (f.isPremium ? f.premiumDiscount : f.standardDiscount),
			},
			undefined,
			{ onError },
		);

		// Run 1 takes the standard branch, so standardDiscount is discovered as a
		// runtime dependency of discount and added to the persistent deps map.
		const first = await graph.compute({ isPremium: false, base: 100 });
		expect(first.discount).toBe(10);

		// Run 2 takes the premium branch and standardDiscount errors. discount does
		// not read standardDiscount this run, so its valid output must survive.
		onError.mockClear();
		const second = await graph.compute({ isPremium: true, base: -5 });

		expect(onError).toHaveBeenCalledWith(
			expect.objectContaining({ key: "standardDiscount" }),
		);
		expect(second.discount).toBe(-2.5);
	});

	it("does not gate an each template on an errored dep its items did not read", async () => {
		interface EachRoot {
			useAlt: boolean;
			bad: boolean;
			factor: number;
			altFactor: number;
			items: number[];
		}
		const onError = vi.fn();
		const graph = createGraph<EachRoot>(
			{
				factor: () => 2,
				altFactor: (f) => {
					if (f.bad) throw new Error("alt boom");
					return 3;
				},
				// Dry run takes the truthy branch → altFactor is the static dep.
				items: each((item: number, root) =>
					root.useAlt ? item * root.altFactor : item * root.factor,
				),
			},
			undefined,
			{ onError },
		);

		// Run 1 reads altFactor (its static branch) and succeeds.
		const first = await graph.compute({
			useAlt: true,
			bad: false,
			items: [1, 2],
		});
		expect(first.items).toEqual([3, 6]);

		// Run 2 reads factor instead; altFactor errors but is not read by the
		// items, so the mapping must still produce values.
		onError.mockClear();
		const second = await graph.compute({
			useAlt: false,
			bad: true,
			items: [1, 2],
		});

		expect(onError).toHaveBeenCalledWith(
			expect.objectContaining({ key: "altFactor" }),
		);
		expect(second.items).toEqual([2, 4]);
		// No per-item error was reported for the mapping.
		expect(
			onError.mock.calls.some(([e]) => String(e.key).startsWith("items")),
		).toBe(false);
	});
});
