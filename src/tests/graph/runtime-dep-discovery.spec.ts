import { describe, expect, it } from "vitest";
import { createGraph } from "../../index.js";

describe("runtime dependency discovery", () => {
	it("discovers a computed dependency read only after an await and converges", async () => {
		interface Root {
			a: number;
			b: number;
		}
		// `b` is declared before `a` and only reads `a` after its first await, so
		// static analysis misses the edge. The engine must discover it at runtime,
		// reorder, and retry to a correct result.
		const graph = createGraph<Root>({
			b: async (f) => {
				await Promise.resolve();
				return f.a + 1;
			},
			a: () => 5,
		});

		const result = await graph.compute({});

		expect(result.a).toBe(5);
		expect(result.b).toBe(6);
		expect(graph.status("a")).toBe("ready");
		expect(graph.status("b")).toBe("ready");
	});

	it("keeps the latest run's ready status after an overlapping compute supersedes an earlier one", async () => {
		interface Root {
			seed: number;
			a: number;
			b: number;
		}
		const graph = createGraph<Root>({
			a: (f) => f.seed * 2,
			b: async (f) => {
				await new Promise((r) => setTimeout(r, 10));
				return f.a + 1;
			},
		});

		const first = graph.compute({ seed: 1 });
		const second = graph.compute({ seed: 5 });
		const [, secondResult] = await Promise.all([first, second]);

		// The latest input wins and its nodes end up ready (not clobbered to
		// stale/pending by the superseded run's retry).
		expect(secondResult.a).toBe(10);
		expect(secondResult.b).toBe(11);
		expect(graph.status("a")).toBe("ready");
		expect(graph.status("b")).toBe("ready");
	});
});
