import { describe, expect, it } from "vitest";
import { createGraph } from "../../index.js";

describe("formula returning a snapshot container", () => {
	interface Root {
		nested: { value: number };
		copy: { value: number };
	}

	it("returns a plain, mutable object (no readonly snapshot proxy leaks out)", async () => {
		const graph = createGraph<Root>({
			copy: (f) => f.nested,
			nested: { value: () => 1 },
		});
		const result = await graph.compute({ nested: {} });

		expect(result.copy).toEqual({ value: 1 });
		// A leaked tracking proxy would throw here; a materialized value does not.
		expect(() => {
			(result.copy as { value: number }).value = 99;
		}).not.toThrow();
	});

	it("depends on the container's computed children even without spreading", async () => {
		// `copy` is declared before `nested.value` and aliases the whole container
		// without enumerating it; it must still run after nested.value.
		const graph = createGraph<Root>({
			copy: (f) => f.nested,
			nested: { value: () => 1 },
		});
		const result = await graph.compute({ nested: {} });
		expect(result.copy).toEqual({ value: 1 });
	});
});
