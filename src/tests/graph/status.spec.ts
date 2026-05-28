import { describe, expect, it, vi } from "vitest";
import { createGraph, each } from "../../index.js";
import type {
	AbErrorRoot,
	AbRoot,
	AsyncDerivedRoot,
	FastSlowRoot,
	TotalRoot,
} from "./test-types.js";

describe("status and snapshot accessors", () => {
	describe("status before compute", () => {
		it("all nodes are pending", () => {
			const graph = createGraph<AbRoot>({
				a: () => 1,
				b: (f) => f.a,
			});
			expect(graph.status("a")).toBe("pending");
			expect(graph.status("b")).toBe("pending");
		});
	});

	describe("status after compute", () => {
		it("computed nodes are ready", async () => {
			const graph = createGraph<AbRoot>({
				a: () => 1,
				b: (f) => f.a,
			});
			await graph.compute({});
			expect(graph.status("a")).toBe("ready");
			expect(graph.status("b")).toBe("ready");
		});
	});

	describe("computeStatus pending while async deps resolve", () => {
		it("dependent nodes show pending until async completes", async () => {
			const graph = createGraph<AsyncDerivedRoot>({
				asyncData: async () => {
					await new Promise((r) => setTimeout(r, 30));
					return 42;
				},
				derived: (f) => f.asyncData + 1,
			});
			const computePromise = graph.compute({});
			await new Promise((r) => setTimeout(r, 5));
			expect(graph.computeStatus((x: AsyncDerivedRoot) => x.derived)).toBe(
				"pending",
			);
			await computePromise;
			expect(graph.computeStatus((x: AsyncDerivedRoot) => x.derived)).toBe(
				"ready",
			);
		});
	});

	describe("status vs computeStatus", () => {
		it("same result for status(key) and computeStatus(accessor)", async () => {
			const graph = createGraph<TotalRoot>({
				total: (f) => f.a + f.b,
			});
			await graph.compute({ a: 1, b: 2 });
			expect(graph.status("total")).toBe(
				graph.computeStatus((x: TotalRoot) => x.total),
			);
			expect(graph.status("total")).toBe("ready");
		});
	});

	describe("snapshot before compute", () => {
		it("returns pending status", () => {
			const graph = createGraph<{ a: number }>({
				a: () => 1,
			});
			const snap = graph.snapshot("a");
			expect(snap.status).toBe("pending");
			expect("value" in snap).toBe(false);
		});
	});

	describe("snapshot after compute", () => {
		it("returns ready status with correct value", async () => {
			const graph = createGraph<TotalRoot>({
				total: (f) => f.a + f.b,
			});
			await graph.compute({ a: 1, b: 2 });
			const snap = graph.snapshot("total");
			expect(snap.status).toBe("ready");
			expect("value" in snap && snap.value).toBe(3);
		});
	});

	describe("computeResult", () => {
		it("returns value and status; value undefined when pending", () => {
			const graph = createGraph<{ a: number }>({
				a: () => 1,
			});
			const result = graph.computeResult((x: { a: number }) => x.a);
			expect(result.status).toBe("pending");
			expect(result.value).toBeUndefined();
		});

		it("returns value and status after compute", async () => {
			const graph = createGraph<{ a: number }>({
				a: () => 42,
			});
			await graph.compute({});
			const result = graph.computeResult((x: { a: number }) => x.a);
			expect(result.status).toBe("ready");
			expect(result.value).toBe(42);
		});
	});

	describe("status after formula error", () => {
		it("errored node has error status", async () => {
			const graph = createGraph<AbErrorRoot>({
				a: () => 1,
				b: () => {
					throw new Error("fail");
				},
			});
			await graph.compute({});
			expect(graph.status("a")).toBe("ready");
			expect(graph.status("b")).toBe("error");
		});
	});

	describe("each template status", () => {
		async function runMixedEach(successDelay: number, errorDelay: number) {
			interface Root {
				items: { value: number; fail: boolean; total: number }[];
			}
			const onError = vi.fn();
			const graph = createGraph<Root>(
				{
					items: each({
						total: async (item) => {
							const shouldFail = typeof item.fail === "boolean" && item.fail;
							await new Promise((resolve) =>
								setTimeout(resolve, shouldFail ? errorDelay : successDelay),
							);
							if (shouldFail) throw new Error("item failed");
							return item.value * 2;
						},
					}),
				},
				undefined,
				{ onError },
			);

			await graph.compute({
				items: [
					{ value: 1, fail: true, total: 0 },
					{ value: 2, fail: false, total: 0 },
				],
			});

			expect(graph.status("items.*.total")).toBe("error");
			expect(onError).toHaveBeenCalledWith(
				expect.objectContaining({ key: "items.0.total" }),
			);
		}

		it("is error when an element fails before successful elements", async () => {
			await runMixedEach(20, 0);
		});

		it("is error when an element fails after successful elements", async () => {
			await runMixedEach(0, 20);
		});
	});

	describe("status after stale", () => {
		it("remaining nodes marked stale or pending", async () => {
			const graph = createGraph<FastSlowRoot>(
				{
					fast: () => "fast",
					slow: async () => {
						await new Promise((r) => setTimeout(r, 50));
						return "slow";
					},
				},
				undefined,
				{ stalePolicy: "discard" },
			);
			const p1 = graph.compute({});
			await new Promise((r) => setTimeout(r, 0)); // let microtask start
			graph.compute({});
			await p1;
			expect(graph.status("fast")).toBe("ready");
			expect(["stale", "pending"]).toContain(graph.status("slow"));
		});
	});
});
