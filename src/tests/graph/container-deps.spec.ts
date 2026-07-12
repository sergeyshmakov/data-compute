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

	it("does not create a false cycle from an incidental parent-path visit", () => {
		interface Root2 {
			a: number;
			nested: { value: number; summary: number };
		}
		// `a` reads the leaf f.nested.value (recording the intermediate path
		// "nested"); `nested.summary` reads `a`. Expanding the incidental "nested"
		// visit to sibling `nested.summary` would fabricate a cycle.
		expect(() =>
			createGraph<Root2>({
				a: (f) => f.nested.value,
				nested: { value: () => 1, summary: (f) => f.a },
			}),
		).not.toThrow();
	});

	it("a leaf read does not depend on unrelated computed siblings", () => {
		interface Root2 {
			a: number;
			nested: { value: number; summary: number };
		}
		const graph = createGraph<Root2>({
			a: (f) => f.nested.value,
			nested: { value: () => 1, summary: () => 2 },
		});
		const deps = graph.deps((x) => x.a);
		expect(deps).toContain("nested.value");
		expect(deps).not.toContain("nested.summary");
	});

	it("a node that spreads its own parent container depends on its computed siblings", async () => {
		interface Root2 {
			group: { a: number; b: number; summary: number };
		}
		const graph = createGraph<Root2>({
			group: {
				a: () => 1,
				b: () => 2,
				summary: (f) => {
					const g = { ...f.group };
					return (g.a ?? 0) + (g.b ?? 0);
				},
			},
		});
		expect(graph.deps((x) => x.group.summary)).toEqual(
			expect.arrayContaining(["group.a", "group.b"]),
		);
		const result = await graph.compute({});
		expect(result.group?.summary).toBe(3);
	});

	it("recovers at runtime when an async formula spreads a container after await", async () => {
		interface Root2 {
			nested: { value: number };
			derived: { value: number };
		}
		const graph = createGraph<Root2>({
			// async + declared before nested.value, so the container read is only
			// visible at runtime — the engine must reorder and retry.
			derived: async (f) => {
				await Promise.resolve();
				return { ...f.nested };
			},
			nested: { value: () => 1 },
		});
		const result = await graph.compute({});
		expect(result.derived).toEqual({ value: 1 });
	});
});
