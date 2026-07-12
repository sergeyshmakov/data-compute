import { describe, expect, it } from "vitest";
import { createGraph } from "../../index.js";

describe("prototype pollution safety", () => {
	it("does not pollute the prototype from a __proto__ key in the input patch", async () => {
		interface Root {
			qty: number;
			total: number;
		}
		const graph = createGraph<Root>({ total: (f) => f.qty * 2 });
		// A JSON-parsed patch can carry an own __proto__ data property.
		const malicious = JSON.parse('{"qty": 3, "__proto__": {"polluted": true}}');
		try {
			const result = await graph.compute(malicious);

			expect(({} as Record<string, unknown>).polluted).toBeUndefined();
			expect((result as Record<string, unknown>).polluted).toBeUndefined();
			expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
			expect(result.qty).toBe(3);
			expect(result.total).toBe(6);
		} finally {
			delete (Object.prototype as Record<string, unknown>).polluted;
		}
	});

	it("does not carry a nested __proto__ key through the clone into the output patch", async () => {
		interface Root {
			nested: { value: number };
			out: number;
		}
		const graph = createGraph<Root>({ out: (f) => f.nested.value * 2 });
		// A nested own __proto__ data property survives structuredClone verbatim.
		const malicious = JSON.parse(
			'{"nested": {"value": 4, "__proto__": {"polluted": true}}}',
		);
		try {
			const result = await graph.compute(malicious);

			const nested = (result as { nested: Record<string, unknown> }).nested;
			// The clone path must strip the nested unsafe key, so a consumer applying
			// the returned patch via [[Set]] cannot pollute the prototype.
			expect(Object.hasOwn(nested, "__proto__")).toBe(false);
			expect(({} as Record<string, unknown>).polluted).toBeUndefined();
			expect(result.out).toBe(8);
		} finally {
			delete (Object.prototype as Record<string, unknown>).polluted;
		}
	});
});
