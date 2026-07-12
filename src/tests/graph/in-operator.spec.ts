import { describe, expect, it } from "vitest";
import { createGraph } from "../../index.js";

describe("`in` operator dependency tracking", () => {
	interface Root {
		total: number;
		exists: boolean;
	}

	it("records a computed key probed with `in` as a dependency", () => {
		const graph = createGraph<Root>({
			exists: (f) => "total" in f,
			total: () => 5,
		});
		expect(graph.deps((x) => x.exists)).toContain("total");
		expect(graph.order.indexOf("total")).toBeLessThan(
			graph.order.indexOf("exists"),
		);
	});

	it("computes the `in` check after the probed computed node runs", async () => {
		const graph = createGraph<Root>({
			// declared before `total`, so without dependency tracking it would see
			// `total` as absent and return false
			exists: (f) => "total" in f,
			total: () => 5,
		});
		const result = await graph.compute({});
		expect(result.exists).toBe(true);
	});

	it("records a computed key probed with Object.hasOwn (getOwnPropertyDescriptor)", () => {
		const graph = createGraph<Root>({
			exists: (f) => Object.hasOwn(f, "total"),
			total: () => 5,
		});
		expect(graph.deps((x) => x.exists)).toContain("total");
	});

	it("computes an Object.hasOwn check after the probed node runs", async () => {
		const graph = createGraph<Root>({
			exists: (f) => Object.hasOwn(f, "total"),
			total: () => 5,
		});
		const result = await graph.compute({});
		expect(result.exists).toBe(true);
	});
});
