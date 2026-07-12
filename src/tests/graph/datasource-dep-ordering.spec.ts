import { describe, expect, it, vi } from "vitest";
import { createGraph, request } from "../../index.js";

describe("data-source dependency ordering", () => {
	interface Root {
		flag: boolean;
		aOut: number;
		bOut: number;
	}

	it("records deps before querying and skips the query when a retry is needed", async () => {
		// `aOut` reads `bOut` only in the branch taken when flag is false. The
		// dry-run proxy makes conditions truthy, so it takes the other branch and
		// misses the dependency; it is discovered at runtime.
		const queryA = vi.fn(async (req: { from: number }) => req.from);
		const queryB = vi.fn(async () => 10);

		const graph = createGraph<Root>(
			{},
			{
				aOut: request((f) => (f.flag ? { from: 1 } : { from: f.bOut }), {
					query: queryA,
				}),
				bOut: request(() => ({}), { query: queryB }),
			},
		);

		const result = await graph.compute({ flag: false });

		expect(result.aOut).toBe(10);
		// The query must fire exactly once, with the resolved dependency — never a
		// first call built from the not-yet-computed (undefined) `bOut`.
		expect(queryA).toHaveBeenCalledTimes(1);
		expect(queryA).toHaveBeenCalledWith({ from: 10 });
	});
});
