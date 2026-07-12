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
});
