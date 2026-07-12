import { describe, expect, it, vi } from "vitest";
import { createGraph, each } from "../../index.js";

describe("each() aggregate reachability via accessor", () => {
	it("resolves a scalar each() array through its natural accessor", async () => {
		interface Root {
			list: number[];
		}
		const graph = createGraph<Root>({
			list: each((item: number) => item * 2),
		});

		await graph.compute({ list: [1, 2, 3] });

		// Before the fix, `(x) => x.list` resolved to "list" — a non-node —
		// and reported pending forever.
		expect(graph.computeStatus((x) => x.list)).toBe("ready");
		expect(graph.computeResult((x) => x.list).value).toEqual([2, 4, 6]);
		expect(graph.computeSnapshot((x) => x.list)).toEqual({
			status: "ready",
			value: [2, 4, 6],
		});
	});

	it("computeSnapshot exposes the error branch of the discriminated union", async () => {
		interface Root {
			base: number;
			derived: number;
		}
		const graph = createGraph<Root>({
			derived: () => {
				throw new Error("nope");
			},
		});

		await graph.compute({ base: 1 });

		const snap = graph.computeSnapshot((x) => x.derived);
		expect(snap.status).toBe("error");
		if (snap.status === "error") {
			expect((snap.error as Error).message).toBe("nope");
		}
	});
});

describe("partial each() failure commit semantics", () => {
	it("commits successful siblings to the patch and setState even when one element errors", async () => {
		interface Root {
			items: { value: number; fail: boolean; total: number }[];
		}
		const setState = vi.fn();
		const graph = createGraph<Root>(
			{
				items: each({
					total: (item) => {
						if (item.fail) throw new Error("item failed");
						return item.value * 2;
					},
				}),
			},
			undefined,
			{ setState },
		);

		const result = await graph.compute({
			items: [
				{ value: 1, fail: true, total: 0 },
				{ value: 2, fail: false, total: 0 },
			],
		});

		expect(graph.status("items.*.total")).toBe("error");
		// Successful sibling is committed to both the returned patch and setState.
		expect(result.items?.[1]?.total).toBe(4);
		expect(setState).toHaveBeenCalledTimes(1);
		const patch = setState.mock.calls[0][0] as Root;
		expect(patch.items?.[1]?.total).toBe(4);
	});
});
