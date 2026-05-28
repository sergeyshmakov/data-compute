import { describe, expect, it } from "vitest";
import { createGraph } from "../../graph/index.js";
import type {
	TraceAbcRoot,
	TraceAsyncRoot,
	TraceSumRoot,
	TraceXRoot,
} from "./test-types.js";

describe("trace", () => {
	describe("returns steps in order", () => {
		it("one step per node in execution order", () => {
			const graph = createGraph<TraceAbcRoot>({
				a: () => 1,
				b: (f) => f.a + 1,
				c: (f) => f.b + 1,
			});
			const steps = graph.trace({});
			expect(steps).toHaveLength(3);
			expect(steps[0].node).toBe("a");
			expect(steps[1].node).toBe("b");
			expect(steps[2].node).toBe("c");
		});
	});

	describe("step structure", () => {
		it("each step has node, deps, result, ms", () => {
			const graph = createGraph<TraceXRoot>({
				a: (f) => f.x + 1,
			});
			const steps = graph.trace({ x: 10 });
			expect(steps).toHaveLength(1);
			expect(steps[0]).toHaveProperty("node", "a");
			expect(steps[0]).toHaveProperty("deps");
			expect(steps[0]).toHaveProperty("result");
			expect(steps[0]).toHaveProperty("ms");
			expect(typeof steps[0].ms).toBe("number");
		});
	});

	describe("sync formula", () => {
		it("result is actual value", () => {
			const graph = createGraph<TraceSumRoot>({
				sum: (f) => f.a + f.b,
			});
			const steps = graph.trace({ a: 1, b: 2 });
			expect(steps[0].result).toBe(3);
		});

		it("populates dependency values from the current trace state", () => {
			const graph = createGraph<{
				a: number;
				b: number;
				sum: number;
				double: number;
			}>({
				sum: (f) => f.a + f.b,
				double: (f) => f.sum * 2,
			});
			const steps = graph.trace({ a: 1, b: 2 });
			expect(steps[0]).toMatchObject({
				node: "sum",
				deps: { a: 1, b: 2 },
				result: 3,
			});
			expect(steps[1]).toMatchObject({
				node: "double",
				deps: { sum: 3 },
				result: 6,
			});
		});
	});

	describe("async formula", () => {
		it("result is [async] when formula awaits", () => {
			const graph = createGraph<TraceAsyncRoot>({
				asyncVal: async () => {
					await Promise.resolve();
					return 42;
				},
			});
			const steps = graph.trace({});
			expect(steps[0].result).toBe("[async]");
		});
	});
});
