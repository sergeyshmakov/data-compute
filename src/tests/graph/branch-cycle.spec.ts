import { describe, expect, it } from "vitest";
import { createGraph } from "../../index.js";

describe("branch-dependent topology", () => {
	it("computes a graph that is acyclic per-run but cyclic in the dep union", async () => {
		interface Root {
			flag: boolean;
			a: number;
			b: number;
		}
		const graph = createGraph<Root>({
			a: (f) => (f.flag ? f.b : 1),
			b: (f) => (f.flag ? 2 : f.a),
		});

		// flag:true — a -> b, acyclic.
		const truthy = await graph.compute({ flag: true });
		expect(truthy.a).toBe(2);
		expect(truthy.b).toBe(2);

		// flag:false — only b reads a, so the run is acyclic even though the union
		// (a -> b from the truthy run + b -> a here) forms a cycle.
		const falsy = await graph.compute({ flag: false });
		expect(falsy.a).toBe(1);
		expect(falsy.b).toBe(1);

		// Introspection still reports the accumulated superset both edges.
		expect(graph.deps((g) => g.a)).toContain("b");
		expect(graph.deps((g) => g.b)).toContain("a");
	});

	it("still rejects a genuine runtime cycle (both branches read each other)", async () => {
		interface Root {
			flag: boolean;
			a: number;
			b: number;
		}
		// Dry run takes the truthy branch (a=1, b=1: no edges, constructs fine).
		// flag:false makes a read b and b read a in the same run — a real cycle.
		const graph = createGraph<Root>({
			a: (f) => (f.flag ? 1 : f.b),
			b: (f) => (f.flag ? 1 : f.a),
		});

		await expect(graph.compute({ flag: false })).rejects.toThrow(/cyclic/i);
	});
});
