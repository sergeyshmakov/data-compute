import { describe, expect, it } from "vitest";
import { createGraph } from "../../graph/index.js";
import type { AbRoot, DepsRoot, IntrospectionRoot } from "./test-types.js";

describe("graph introspection", () => {
	describe("deps", () => {
		it("returns direct dependencies of node", () => {
			const graph = createGraph<DepsRoot>({
				subtotal: (f) => f.quantity * f.unitPrice,
				tax: (f) => f.subtotal * f.taxRate,
				total: (f) => f.subtotal + f.tax,
			});
			const deps = graph.deps((x: DepsRoot) => x.total);
			expect(deps).toContain("subtotal");
			expect(deps).toContain("tax");
			expect(deps).toHaveLength(2);
		});

		it("returns empty array for node with no deps", () => {
			const graph = createGraph<{ a: number }>({
				a: () => 1,
			});
			const deps = graph.deps((x: { a: number }) => x.a);
			expect(deps).toEqual([]);
		});
	});

	describe("dependents", () => {
		it("returns nodes that depend on the key", () => {
			const graph = createGraph<DepsRoot>({
				subtotal: (f) => f.quantity * f.unitPrice,
				tax: (f) => f.subtotal * f.taxRate,
				total: (f) => f.subtotal + f.tax,
			});
			const deps = graph.dependents((x: DepsRoot) => x.subtotal);
			expect(deps).toContain("tax");
			expect(deps).toContain("total");
			expect(deps).toHaveLength(2);
		});

		it("returns empty array for leaf node", () => {
			const graph = createGraph<AbRoot>({
				a: () => 1,
				b: (f) => f.a,
			});
			const deps = graph.dependents((x: AbRoot) => x.b);
			expect(deps).toEqual([]);
		});
	});

	describe("toMermaid", () => {
		it("returns string starting with graph TD", () => {
			const graph = createGraph<AbRoot>({
				a: () => 1,
				b: (f) => f.a,
			});
			const mermaid = graph.toMermaid();
			expect(mermaid).toMatch(/^graph TD/);
		});

		it("contains edges in form dep --> node", () => {
			const graph = createGraph<AbRoot>({
				a: () => 1,
				b: (f) => f.a,
			});
			const mermaid = graph.toMermaid();
			expect(mermaid).toContain("a --> b");
		});

		it("nodes with no deps appear as standalone lines", () => {
			const graph = createGraph<AbRoot>({
				a: () => 1,
				b: (f) => f.a,
			});
			const mermaid = graph.toMermaid();
			expect(mermaid).toMatch(/^ {2}a$/m);
			expect(mermaid).toContain("  a --> b");
		});
	});

	describe("nested accessors", () => {
		it("targets the leaf path for status, result, deps, and dependents", async () => {
			interface NestedRoot {
				nested: { value: number };
				doubled: number;
			}
			const graph = createGraph<NestedRoot>({
				nested: { value: () => 1 },
				doubled: (f) => f.nested.value * 2,
			});

			await graph.compute({});

			expect(graph.computeStatus((x) => x.nested.value)).toBe("ready");
			expect(graph.computeResult((x) => x.nested.value)).toEqual({
				value: 1,
				status: "ready",
			});
			expect(graph.deps((x) => x.nested.value)).toEqual(["nested"]);
			expect(graph.dependents((x) => x.nested.value)).toContain("doubled");
		});
	});

	describe("sourceKeys and sources", () => {
		it("populated after first compute", async () => {
			const graph = createGraph<IntrospectionRoot>({
				computed: (f) => f.source,
			});
			expect(graph.sourceKeys).toEqual([]);
			expect(graph.sources).toEqual([]);
			await graph.compute({ source: 1 });
			expect(graph.sourceKeys).toContain("source");
			expect(graph.sources).toContain("source");
		});

		it("sources alias matches sourceKeys", async () => {
			const graph = createGraph<IntrospectionRoot>({
				computed: (f) => f.source,
			});
			await graph.compute({ source: 1 });
			expect(graph.sources).toEqual(graph.sourceKeys);
		});
	});
});
