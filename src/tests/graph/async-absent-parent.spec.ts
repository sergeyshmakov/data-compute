import { describe, expect, it } from "vitest";
import { createGraph } from "../../index.js";

describe("async read of a computed child under an absent parent", () => {
	it("waits for the computed child even though its parent is absent at read time", async () => {
		interface Root {
			trigger: number;
			derived: number;
			nested: { value: number };
		}
		// `derived` is async, so its post-await read is not captured by the
		// synchronous dry run; it is declared before `nested.value`. On the first
		// pass `nested` is absent, so reading `f.nested?.value` records only
		// `nested` — the computed child `nested.value` must still be discovered so
		// `derived` waits for it instead of computing from the absent container.
		const graph = createGraph<Root>({
			derived: async (f) => {
				await Promise.resolve();
				return (f.nested?.value ?? 0) + 1;
			},
			nested: { value: (f) => f.trigger * 2 },
		});

		const r = await graph.compute({ trigger: 5 });
		expect(r.nested?.value).toBe(10);
		expect(r.derived).toBe(11);
	});
});
