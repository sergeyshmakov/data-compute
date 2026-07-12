import { describe, expect, it, vi } from "vitest";
import { mergeDeepPartial } from "../../graph/state-utils.js";
import { createGraph, each } from "../../index.js";

describe("output patch does not leak caller-supplied computed values", () => {
	it("omits a computed key from the output when its node errors", async () => {
		interface Root {
			computed: number;
			other: number;
		}
		const onError = vi.fn();
		const setState = vi.fn();
		const graph = createGraph<Root>(
			{
				computed: () => {
					throw new Error("boom");
				},
				other: () => 7,
			},
			undefined,
			{ onError, setState },
		);

		const result = await graph.compute({ computed: 999 });

		expect(onError).toHaveBeenCalledWith(
			expect.objectContaining({ key: "computed" }),
		);
		expect(result.computed).toBeUndefined();
		expect(result.other).toBe(7);
		expect(setState).toHaveBeenCalledTimes(1);
		expect((setState.mock.calls[0][0] as Root).computed).toBeUndefined();
	});

	it("returns the computed value, not the caller-supplied one, on success", async () => {
		interface Root {
			computed: number;
		}
		const graph = createGraph<Root>({ computed: () => 5 });
		const result = await graph.compute({ computed: 999 });
		expect(result.computed).toBe(5);
	});

	it("passes source fields through unchanged", async () => {
		interface Root {
			qty: number;
			total: number;
		}
		const graph = createGraph<Root>({ total: (f) => f.qty * 2 });
		const result = await graph.compute({ qty: 3 });
		expect(result).toMatchObject({ qty: 3, total: 6 });
	});

	it("keeps a scalar each() mapping working (node reads its own input path)", async () => {
		interface Root {
			list: number[];
		}
		const graph = createGraph<Root>({ list: each((item: number) => item * 2) });
		const result = await graph.compute({ list: [1, 2, 3] });
		expect(result.list).toEqual([2, 4, 6]);
	});

	it("omits an un-produced scalar each() entry as a hole, not undefined", async () => {
		interface Root {
			list: number[];
		}
		const onError = vi.fn();
		const setState = vi.fn();
		const graph = createGraph<Root>(
			{
				list: each((item: number) => {
					if (item === 2) throw new Error("boom");
					return item * 10;
				}),
			},
			undefined,
			{ onError, setState },
		);

		const result = await graph.compute({ list: [1, 2, 3] });

		expect(onError).toHaveBeenCalledWith(
			expect.objectContaining({ key: "list.1" }),
		);
		const list = result.list as number[];
		expect(list[0]).toBe(10);
		expect(list[2]).toBe(30);
		// The failed entry must be a hole, not an explicit `undefined` — otherwise
		// a deep-merge consumer would overwrite its existing value with `undefined`.
		expect(1 in list).toBe(false);

		const setStateList = (setState.mock.calls[0][0] as Root).list;
		expect(1 in setStateList).toBe(false);

		// Applying the patch with the documented deep-merge semantics preserves the
		// consumer's prior value at the omitted index.
		const merged = mergeDeepPartial<number[]>([7, 8, 9], result.list);
		expect(merged).toEqual([10, 8, 30]);
	});
});
