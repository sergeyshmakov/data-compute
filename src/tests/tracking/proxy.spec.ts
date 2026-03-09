import { describe, expect, it } from "vitest";
import { dryRunProxy, isProxy, trackingProxy } from "../../tracking/proxy";

describe("isProxy", () => {
	describe("returns true for tracking and dry-run proxies", () => {
		it("returns true for trackingProxy", () => {
			const deps = new Set<string>();
			const proxy = trackingProxy({ foo: 1 }, deps);
			expect(isProxy(proxy)).toBe(true);
		});

		it("returns true for dryRunProxy", () => {
			const deps = new Set<string>();
			const proxy = dryRunProxy(deps);
			expect(isProxy(proxy)).toBe(true);
		});
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

describe("trackingProxy", () => {
	describe("records property accesses into deps Set", () => {
		it("records top-level property access", () => {
			const deps = new Set<string>();
			const target = { foo: 42, bar: "baz" };
			const proxy = trackingProxy(target, deps);
			proxy.foo;
			expect(deps).toContain("foo");
			expect(deps).not.toContain("bar");
		});

		it("records nested property access with dotted path", () => {
			const deps = new Set<string>();
			const target = { a: { b: { c: 1 } } };
			const proxy = trackingProxy(target, deps);
			proxy.a.b.c;
			expect(deps).toContain("a");
			expect(deps).toContain("a.b");
			expect(deps).toContain("a.b.c");
		});

		it("records array index access", () => {
			const deps = new Set<string>();
			const target = [10, 20, 30];
			const proxy = trackingProxy(target, deps);
			proxy[1];
			expect(deps).toContain("1");
		});
	});

	describe("handles nested objects", () => {
		it("returns proxied nested objects", () => {
			const deps = new Set<string>();
			const target = { inner: { value: 1 } };
			const proxy = trackingProxy(target, deps);
			const inner = proxy.inner;
			inner.value;
			expect(deps).toContain("inner");
			expect(deps).toContain("inner.value");
		});
	});

	describe("short-circuit array methods touch all elements", () => {
		it("find touches all elements before short-circuiting", () => {
			const deps = new Set<string>();
			const arr = [1, 2, 3];
			const proxy = trackingProxy(arr, deps);
			proxy.find((x: number) => x === 3);
			expect(deps).toContain("0");
			expect(deps).toContain("1");
			expect(deps).toContain("2");
		});

		it("some touches all elements when returning false", () => {
			const deps = new Set<string>();
			const arr = [1, 2, 3];
			const proxy = trackingProxy(arr, deps);
			proxy.some((x: number) => x > 10);
			expect(deps).toContain("0");
			expect(deps).toContain("1");
			expect(deps).toContain("2");
		});

		it("every touches all elements when returning true", () => {
			const deps = new Set<string>();
			const arr = [1, 2, 3];
			const proxy = trackingProxy(arr, deps);
			proxy.every((x: number) => x < 10);
			expect(deps).toContain("0");
			expect(deps).toContain("1");
			expect(deps).toContain("2");
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

	describe("has returns true", () => {
		it("in operator returns true for any property", () => {
			const deps = new Set<string>();
			const proxy = dryRunProxy(deps) as DryRunProxyTest;
			expect("anyProp" in proxy).toBe(true);
		});
	});
});
