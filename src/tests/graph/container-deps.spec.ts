import { describe, expect, it } from "vitest";
import { createGraph } from "../../index.js";

describe("container reads depend on computed descendants", () => {
	interface Root {
		nested: { value: number };
		summary: { value: number };
	}

	it("orders a whole-container reader after its computed descendant", () => {
		const graph = createGraph<Root>({
			// declared before `nested.value`, reads the whole container
			summary: (f) => ({ ...f.nested }),
			nested: { value: () => 1 },
		});

		expect(graph.deps((x) => x.summary)).toContain("nested.value");
		expect(graph.order.indexOf("nested.value")).toBeLessThan(
			graph.order.indexOf("summary"),
		);
	});

	it("computes the container reader from the fresh descendant value", async () => {
		const graph = createGraph<Root>({
			summary: (f) => ({ ...f.nested }),
			nested: { value: () => 1 },
		});

		const result = await graph.compute({ nested: {} });
		expect(result.summary).toEqual({ value: 1 });
	});

	it("does not create false cycles between sibling computed nodes", () => {
		interface Siblings {
			group: { a: number; b: number };
		}
		// Two siblings under the same container; neither reads the other, so the
		// implicit parent dependency must not link them.
		expect(() =>
			createGraph<Siblings>({
				group: { a: () => 1, b: () => 2 },
			}),
		).not.toThrow();
	});
});
