import { describe, expect, it, vi } from "vitest";
import { createGraph } from "../../graph/index.js";

interface DeepState {
	a?: { b?: { c?: number; d?: number } };
	x?: { y?: { z?: number; w?: number } };
	computedC?: number;
	computedZ?: number;
	total?: number;
}

describe("Granular Updates and Microtask Batching", () => {
	it("batches multiple synchronous compute calls into a single execution and single setState", async () => {
		const setState = vi.fn();
		let executions = 0;

		const graph = createGraph<DeepState>(
			{
				total: (f) => {
					executions++;
					const c = f.a?.b?.c ?? 0;
					const z = f.x?.y?.z ?? 0;
					return c + z;
				},
			},
			undefined,
			{ setState },
		);

		// Reset executions after graph initialization (which executes once to trace dependencies)
		executions = 0;

		// Synchronous calls
		const p1 = graph.compute({ a: { b: { c: 10 } } });
		const p2 = graph.compute({ x: { y: { z: 20 } } });

		const [res1, res2] = await Promise.all([p1, p2]);

		// Both promises should resolve to the exact same coalesced patch
		expect(res1).toBe(res2);

		// The coalesced patch should contain inputs and the computed 'total'
		expect(res1).toEqual({
			a: { b: { c: 10 } },
			x: { y: { z: 20 } },
			total: 30,
		});

		// Ensure it only executed formulas once (microtask batching worked)
		expect(executions).toBe(1);

		// Ensure setState was called exactly once with the granular patch
		expect(setState).toHaveBeenCalledTimes(1);
		expect(setState).toHaveBeenCalledWith({
			a: { b: { c: 10 } },
			x: { y: { z: 20 } },
			total: 30,
		});
	});

	it("merges deeply nested granular patches perfectly without leaking base state", async () => {
		const setState = vi.fn();

		// Base state contains other fields that are NOT touched
		const baseState: DeepState = {
			a: { b: { c: 0, d: 99 } },
			x: { y: { z: 0, w: 88 } },
			total: 0,
		};

		const graph = createGraph<DeepState>(
			{
				computedC: (f) => (f.a?.b?.c ?? 0) * 2,
				computedZ: (f) => (f.x?.y?.z ?? 0) * 2,
			},
			undefined,
			{
				getState: () => baseState,
				setState,
			},
		);

		// Trigger two granular updates on deep leaf nodes
		const p1 = graph.compute({ a: { b: { c: 5 } } });
		const p2 = graph.compute({ x: { y: { z: 10 } } });

		const res = await p1; // p1 and p2 resolve to the same patch
		await p2;

		// The resulting granular patch MUST NOT contain 'd' or 'w' because they were not in the patch
		// and the graph must not leak them from the base state.
		const expectedPatch = {
			a: { b: { c: 5 } },
			x: { y: { z: 10 } },
			computedC: 10, // 5 * 2
			computedZ: 20, // 10 * 2
		};

		expect(res).toEqual(expectedPatch);

		expect(setState).toHaveBeenCalledTimes(1);
		expect(setState).toHaveBeenCalledWith(expectedPatch);

		// Explicit negative checks to be absolutely sure no bleed occurred
		expect(res).not.toHaveProperty("a.b.d");
		expect(res).not.toHaveProperty("x.y.w");
	});

	it("prevents stale closures by relying on getState for fresh values", async () => {
		let externalStore = { value: 10, other: 100, sum: 0 };

		const graph = createGraph<{ value: number; other: number; sum: number }>(
			{
				sum: (f) => f.value + f.other,
			},
			undefined,
			{
				getState: () => externalStore,
			},
		);

		// While a computation is requested but hasn't run yet, we synchronously mutate the external store.
		// Since flushCompute happens in a microtask, it should read the latest getState()!
		const p = graph.compute({ value: 20 });

		externalStore = { value: 10, other: 200, sum: 0 }; // mutated synchronously

		const patch = await p;

		// The patch should use the updated 'other' from the fresh getState
		expect(patch).toEqual({
			value: 20,
			sum: 220, // 20 (patch) + 200 (latest base state)
		});
	});
});
