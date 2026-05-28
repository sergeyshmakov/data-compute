import { describe, expect, it, vi } from "vitest";
import { batchRequest, createGraph, request } from "../../index.js";
import type {
	AbErrorRoot,
	ApiOkRoot,
	ApiResultRoot,
	BonusRoot,
	DelayedRoot,
	DiscountRoot,
	NestedArrRoot,
	OptRoot,
	SourceComputedRoot,
	SumRoot,
	SyncChainRoot,
} from "./test-types.js";

interface PricingForm {
	productId: string;
	quantity: number;
	customerTier: string;
	basePrice: number;
	subtotal: number;
	pricing: { adjustedPrice: number; taxRate: number };
	finalPrice: number;
	tax: number;
	total: number;
}

describe("compute", () => {
	describe("sync-only chain", () => {
		it("computes subtotal, tax, total from sources correctly", async () => {
			const graph = createGraph<SyncChainRoot>({
				subtotal: (f) => f.quantity * f.unitPrice,
				tax: (f) => f.subtotal * f.taxRate,
				total: (f) => f.subtotal + f.tax - f.discount,
			});
			const result = await graph.compute({
				quantity: 2,
				unitPrice: 10,
				taxRate: 0.1,
				discount: 0,
			});
			expect(result.subtotal).toBe(20);
			expect(result.tax).toBe(2);
			expect(result.total).toBe(22);
		});
	});

	describe("snapshot semantics across awaits", () => {
		it("reads before and after await see same values", async () => {
			const graph = createGraph<DelayedRoot>({
				delayed: async (f) => {
					const before = f.value;
					await Promise.resolve();
					const after = f.value;
					return { before, after };
				},
			});
			const result = await graph.compute({ value: 42 });
			expect(result.delayed?.before).toBe(42);
			expect(result.delayed?.after).toBe(42);
		});
	});

	describe("input overrides computed keys", () => {
		it("formulas overwrite provided computed keys", async () => {
			const graph = createGraph<SourceComputedRoot>({
				computed: (f) => f.source + 1,
			});
			const result = await graph.compute({
				source: 10,
				computed: 999,
			});
			expect(result.computed).toBe(11);
		});
	});

	describe("batchRequest integration", () => {
		it("data source uses batchRequest and result flows into state", async () => {
			const queryFn = vi
				.fn()
				.mockImplementation(async (entries: { id: string }[]) =>
					entries.map((e) => ({
						id: e.id,
						response: { data: 42 },
					})),
				);
			const graph = createGraph<ApiResultRoot>(
				{},
				{
					apiResult: batchRequest(() => ({ id: 1 }), { query: queryFn }),
				},
			);
			const result = await graph.compute({});
			expect(result.apiResult).toEqual({ data: 42 });
			expect(queryFn).toHaveBeenCalled();
		});
	});

	describe("full async pricing flow", () => {
		it("computes subtotal, pricing, finalPrice, tax, total end-to-end", async () => {
			const graph = createGraph<PricingForm>(
				{
					subtotal: (f) => f.quantity * f.basePrice,
					finalPrice: (f) => (f.pricing?.adjustedPrice ?? 0) * f.quantity,
					tax: (f) => f.finalPrice * (f.pricing?.taxRate ?? 0),
					total: (f) => f.finalPrice + f.tax,
				},
				{
					pricing: batchRequest(
						(f) => ({
							productId: f.productId,
							quantity: f.quantity,
							customerTier: f.customerTier,
						}),
						{
							query: vi
								.fn()
								.mockImplementation(
									async (
										entries: { id: string; request: { quantity: number } }[],
									) =>
										entries.map((e) => ({
											id: e.id,
											response: {
												adjustedPrice: 10,
												taxRate: 0.1,
											},
										})),
								),
						},
					),
				},
			);
			const result = await graph.compute({
				productId: "x",
				quantity: 5,
				customerTier: "gold",
				basePrice: 10,
			});
			expect(result.subtotal).toBe(50);
			expect(result.pricing).toEqual({ adjustedPrice: 10, taxRate: 0.1 });
			expect(result.finalPrice).toBe(50);
			expect(result.tax).toBe(5);
			expect(result.total).toBe(55);
		});
	});

	describe("request integration", () => {
		it("data source uses request and result in state", async () => {
			const handler = vi.fn().mockResolvedValue({ ok: true });
			const graph = createGraph<ApiOkRoot>(
				{},
				{
					apiResult: request(() => ({ id: 1 }), {
						query: handler as unknown as (req: {
							id: number;
						}) => Promise<{ ok: boolean }>,
					}),
				},
			);
			const result = await graph.compute({});
			expect(result.apiResult).toEqual({ ok: true });
			expect(handler).toHaveBeenCalledWith({ id: 1 });
		});
	});

	describe("branch/match logic via normal JS", () => {
		it("runtime branch with real boolean runs only matching branch", async () => {
			const graph = createGraph<DiscountRoot>({
				discount: (f) => (f.isPremium ? f.premiumDiscount : f.standardDiscount),
			});
			const result = await graph.compute({
				isPremium: true,
				premiumDiscount: 20,
				standardDiscount: 5,
			});
			expect(result.discount).toBe(20);
		});

		it("runtime match runs only matching case", async () => {
			const graph = createGraph<BonusRoot>({
				bonus: (f) => {
					switch (f.userTier) {
						case "gold":
							return f.goldDiscount;
						case "silver":
							return f.silverDiscount;
						default:
							return 0;
					}
				},
			});
			const result = await graph.compute({
				userTier: "gold",
				goldDiscount: 100,
				silverDiscount: 50,
			});
			expect(result.bonus).toBe(100);
		});
	});

	describe("setState", () => {
		it("fires once with final granular state patch on success", async () => {
			const setState = vi.fn();
			const graph = createGraph<SumRoot>({ sum: (f) => f.a + f.b }, undefined, {
				setState,
			});
			await graph.compute({ a: 1, b: 2 });
			expect(setState).toHaveBeenCalledTimes(1);
			expect(setState).toHaveBeenCalledWith(
				expect.objectContaining({ a: 1, b: 2, sum: 3 }),
			);
		});
	});

	describe("onError", () => {
		it("called when formula throws with key and cause", async () => {
			const onError = vi.fn();
			const graph = createGraph<AbErrorRoot>(
				{
					a: () => 1,
					b: () => {
						throw new Error("formula error");
					},
				},
				undefined,
				{ onError },
			);
			await graph.compute({});
			expect(onError).toHaveBeenCalledWith(
				expect.objectContaining({
					key: "b",
					cause: expect.any(Error),
				}),
			);
		});
	});

	describe("sourceKeys populated after first compute", () => {
		it("sources reflect input keys not in computedKeys", async () => {
			const graph = createGraph<{ source: number; computed: number }>({
				computed: (f) => f.source,
			});
			expect(graph.sources).toEqual([]);
			await graph.compute({ source: 1 });
			expect(graph.sources).toContain("source");
			expect(graph.sources).not.toContain("computed");
		});
	});

	describe("formula returning undefined", () => {
		it("stored in state without crash", async () => {
			const graph = createGraph<OptRoot>({
				opt: () => undefined,
			});
			const result = await graph.compute({});
			expect(result.opt).toBeUndefined();
		});
	});

	describe("formula returning object/array", () => {
		it("deep values stored correctly", async () => {
			const graph = createGraph<NestedArrRoot>({
				nested: () => ({ a: 1, b: { c: 2 } }),
				arr: () => [1, 2, 3],
			});
			const result = await graph.compute({});
			expect(result.nested).toEqual({ a: 1, b: { c: 2 } });
			expect(result.arr).toEqual([1, 2, 3]);
		});
	});

	describe("array aggregation at runtime", () => {
		it("f.items.reduce computes correct total", async () => {
			interface Root {
				items: { price: number }[];
				total: number;
			}
			const graph = createGraph<Root>({
				total: (f) =>
					(f.items ?? []).reduce((sum: number, item) => sum + item.price, 0),
			});
			const result = await graph.compute({
				items: [{ price: 10 }, { price: 20 }, { price: 30 }],
			});
			expect(result.total).toBe(60);
		});
	});
});
