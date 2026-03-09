import { describe, expect, it } from "vitest";
import { resolveAccessor } from "../../tracking/accessor";

describe("resolveAccessor", () => {
	describe("single-level access", () => {
		it("resolves (x) => x.foo to 'foo'", () => {
			const accessor = (x: { foo: unknown }) => x.foo;
			expect(resolveAccessor(accessor)).toBe("foo");
		});

		it("resolves (x) => x.total to 'total'", () => {
			const accessor = (x: { total: unknown }) => x.total;
			expect(resolveAccessor(accessor)).toBe("total");
		});
	});

	describe("nested access", () => {
		it("resolves (x) => x.a.b to root key 'a'", () => {
			const accessor = (x: { a: { b: unknown } }) => x.a.b;
			expect(resolveAccessor(accessor)).toBe("a");
		});

		it("resolves (x) => x.pricing.taxRate to root key 'pricing'", () => {
			const accessor = (x: { pricing: { taxRate: unknown } }) =>
				x.pricing.taxRate;
			expect(resolveAccessor(accessor)).toBe("pricing");
		});
	});

	describe("throws when accessor touches nothing", () => {
		it("throws when accessor returns without accessing", () => {
			const accessor = () => undefined;
			expect(() => resolveAccessor(accessor)).toThrow(
				"Accessor did not access any property",
			);
		});

		it("throws when accessor is a no-op", () => {
			const accessor = (_x: unknown) => 42;
			expect(() => resolveAccessor(accessor)).toThrow(
				"Accessor did not access any property",
			);
		});
	});
});
