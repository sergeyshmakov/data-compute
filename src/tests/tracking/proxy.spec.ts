import { describe, expect, it } from "vitest";
import { dryRunProxy, isProxy } from "../../tracking/proxy.js";

describe("isProxy", () => {
	it("returns true for dryRunProxy", () => {
		const deps = new Set<string>();
		const proxy = dryRunProxy(deps);
		expect(isProxy(proxy)).toBe(true);
	});

	describe("returns false for non-proxy values", () => {
		it("returns false for null", () => {
			expect(isProxy(null)).toBe(false);
		});

		it("returns false for primitives", () => {
			expect(isProxy(undefined)).toBe(false);
			expect(isProxy(0)).toBe(false);
			expect(isProxy("")).toBe(false);
			expect(isProxy(true)).toBe(false);
		});

		it("returns false for plain objects", () => {
			expect(isProxy({})).toBe(false);
			expect(isProxy({ foo: 1 })).toBe(false);
		});
	});
});

/** Type for dry-run proxy in tests — allows property access and iteration. */
interface DryRunProxyTest {
	[key: string]: DryRunProxyTest | number | (() => DryRunProxyTest);
	length: number;
	(): DryRunProxyTest;
	[Symbol.iterator](): IterableIterator<DryRunProxyTest>;
}

describe("dryRunProxy", () => {
	describe("records property accesses", () => {
		it("records accessed property paths", () => {
			const deps = new Set<string>();
			const proxy = dryRunProxy(deps) as DryRunProxyTest;
			proxy.foo;
			(proxy.bar as DryRunProxyTest).baz;
			expect(deps).toContain("foo");
			expect(deps).toContain("bar");
			expect(deps).toContain("bar.baz");
		});
	});

	describe("returns safe defaults for primitive coercions", () => {
		it("length returns 2", () => {
			const deps = new Set<string>();
			const proxy = dryRunProxy(deps) as DryRunProxyTest;
			expect(proxy.length).toBe(2);
		});

		it("Symbol.toPrimitive returns safe values", () => {
			const deps = new Set<string>();
			const proxy = dryRunProxy(deps) as DryRunProxyTest;
			expect(Number(proxy)).toBe(0);
			expect(String(proxy)).toBe("");
			expect(Boolean(proxy)).toBe(true);
		});
	});

	describe("Symbol.iterator yields elements and records paths", () => {
		it("iterates and records element paths", () => {
			const deps = new Set<string>();
			const proxy = dryRunProxy(deps) as DryRunProxyTest;
			for (const _ of proxy) {
				// consume iterator
			}
			expect(deps).toContain("0");
			expect(deps).toContain("1");
		});
	});

	describe("is callable", () => {
		it("returns proxy when called", () => {
			const deps = new Set<string>();
			const proxy = dryRunProxy(deps) as DryRunProxyTest;
			const result = proxy();
			expect(isProxy(result)).toBe(true);
		});
	});

	describe("records element reads inside array-method callbacks", () => {
		it("captures reduce callback dependencies", () => {
			const deps = new Set<string>();
			// Simulate `items.reduce((sum, item) => sum + item.total, 0)`.
			const items = dryRunProxy(deps, "items") as {
				reduce: (
					cb: (sum: number, item: { total: number }) => number,
					init: number,
				) => number;
			};
			items.reduce((sum, item) => sum + item.total, 0);
			expect(deps).toContain("items.0.total");
		});

		it("captures map callback dependencies", () => {
			const deps = new Set<string>();
			const items = dryRunProxy(deps, "items") as {
				map: (cb: (item: { price: number }) => number) => number[];
			};
			items.map((item) => item.price);
			expect(deps).toContain("items.0.price");
		});

		it("captures reads via the array argument", () => {
			const deps = new Set<string>();
			const items = dryRunProxy(deps, "items") as {
				map: (
					cb: (
						item: unknown,
						index: number,
						array: { price: number }[],
					) => number,
				) => number[];
			};
			items.map((_item, index, array) => array[index].price);
			expect(deps).toContain("items.0.price");
		});

		it("captures reducer callbacks with the full (acc, value, index, array) signature", () => {
			const deps = new Set<string>();
			const items = dryRunProxy(deps, "items") as {
				reduce: (
					cb: (
						acc: number,
						item: unknown,
						index: number,
						array: { tax: number }[],
					) => number,
					init: number,
				) => number;
			};
			items.reduce((acc, _item, index, array) => acc + array[index].tax, 0);
			expect(deps).toContain("items.0.tax");
		});

		it("forwards thisArg to the callback", () => {
			const deps = new Set<string>();
			const items = dryRunProxy(deps, "items") as {
				map: (
					cb: (this: { rate: number }, item: { price: number }) => number,
					thisArg: { rate: number },
				) => number[];
			};
			items.map(
				function (item) {
					return this.rate * item.price;
				},
				{ rate: 2 },
			);
			expect(deps).toContain("items.0.price");
		});
	});

	describe("has returns true", () => {
		it("in operator returns true for any property", () => {
			const deps = new Set<string>();
			const proxy = dryRunProxy(deps) as DryRunProxyTest;
			expect("anyProp" in proxy).toBe(true);
		});
	});
});
