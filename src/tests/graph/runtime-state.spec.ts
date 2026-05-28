import { describe, expect, it } from "vitest";
import { createGraph, each } from "../../index.js";
import type { AbcRoot } from "./test-types.js";

describe("runtime state snapshots", () => {
	it("each formula receives immutable copy; mutations do not affect others", async () => {
		const graph = createGraph<AbcRoot>({
			a: () => 1,
			b: (f) => f.a + 1,
			c: (f) => f.a + f.b,
		});
		const result = await graph.compute({});
		expect(result.a).toBe(1);
		expect(result.b).toBe(2);
		expect(result.c).toBe(3);
	});

	it("deep-freezes root snapshots so nested mutations do not leak", async () => {
		interface Root {
			nested: { x: number };
			items: { quantity: number }[];
			mutate: number;
			readBack: number;
		}
		const graph = createGraph<Root>({
			mutate: (f) => {
				try {
					(f.nested as { x: number }).x = 99;
				} catch {
					// Strict mode throws for frozen snapshots.
				}
				try {
					(f.items[0] as { quantity: number }).quantity = 99;
				} catch {
					// Strict mode throws for frozen snapshots.
				}
				return 1;
			},
			readBack: (f) => f.nested.x + f.items[0].quantity,
		});

		const result = await graph.compute({
			nested: { x: 1 },
			items: [{ quantity: 2 }],
		});

		expect(result.readBack).toBe(3);
		expect(result.nested).toEqual({ x: 1 });
		expect(result.items?.[0]).toEqual({ quantity: 2 });
	});

	it("deep-freezes each item snapshots so item mutations do not leak", async () => {
		interface Root {
			items: {
				pricing: { base: number; tax: number };
				copy: number;
			}[];
		}
		const graph = createGraph<Root>({
			items: each({
				pricing: {
					tax: (item) => {
						try {
							(item.pricing as { base: number }).base = 999;
						} catch {
							// Strict mode throws for frozen snapshots.
						}
						return item.pricing.base * 0.1;
					},
				},
				copy: (item) => item.pricing.base,
			}),
		});

		const result = await graph.compute({
			items: [{ pricing: { base: 10, tax: 0 }, copy: 0 }],
		});

		expect(result.items?.[0]?.pricing?.tax).toBe(1);
		expect(result.items?.[0]?.copy).toBe(10);
	});

	it("preserves structured-cloneable source values", async () => {
		interface Root {
			date: Date;
			nan: number;
			infinity: number;
			optional?: undefined;
			map: Map<string, number>;
			set: Set<string>;
			fn: () => string;
			dateOk: boolean;
			nanOk: boolean;
			infinityOk: boolean;
			undefinedOk: boolean;
			mapValue: number;
			setOk: boolean;
			fnValue: string;
		}
		const fn = () => "callable";
		const graph = createGraph<Root>(
			{
				dateOk: (f) => f.date instanceof Date,
				nanOk: (f) => Number.isNaN(f.nan),
				infinityOk: (f) => f.infinity === Infinity,
				undefinedOk: (f) =>
					Object.hasOwn(f, "optional") && f.optional === undefined,
				mapValue: (f) => f.map.get("a") ?? 0,
				setOk: (f) => f.set.has("x"),
				fnValue: (f) => f.fn(),
			},
			undefined,
			{
				getState: () => ({
					date: new Date("2020-01-01T00:00:00.000Z"),
					nan: NaN,
					infinity: Infinity,
					optional: undefined,
					map: new Map([["a", 1]]),
					set: new Set(["x"]),
					fn,
					dateOk: false,
					nanOk: false,
					infinityOk: false,
					undefinedOk: false,
					mapValue: 0,
					setOk: false,
					fnValue: "",
				}),
			},
		);

		await expect(graph.compute({})).resolves.toMatchObject({
			dateOk: true,
			nanOk: true,
			infinityOk: true,
			undefinedOk: true,
			mapValue: 1,
			setOk: true,
			fnValue: "callable",
		});
	});

	it("prevents Map and Set mutations inside frozen snapshots", async () => {
		interface Root {
			map: Map<string, number>;
			set: Set<string>;
			mapMutated: boolean;
			setMutated: boolean;
		}
		const graph = createGraph<Root>(
			{
				mapMutated: (f) => {
					try {
						f.map.set("b", 2);
					} catch {
						// Frozen collection snapshots reject mutating methods.
					}
					return f.map.has("b");
				},
				setMutated: (f) => {
					try {
						f.set.add("y");
					} catch {
						// Frozen collection snapshots reject mutating methods.
					}
					return f.set.has("y");
				},
			},
			undefined,
			{
				getState: () => ({
					map: new Map([["a", 1]]),
					set: new Set(["x"]),
					mapMutated: false,
					setMutated: false,
				}),
			},
		);

		await expect(graph.compute({})).resolves.toMatchObject({
			mapMutated: false,
			setMutated: false,
		});
	});
});
