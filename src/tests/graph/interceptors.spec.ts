import { describe, expect, it, vi } from "vitest";
import { createGraph } from "../../index.js";
import type { Interceptor } from "../../types.js";

interface Root {
	base: number;
	doubled: number;
	dependent: number;
}

const makeGraph = (interceptors: Interceptor<Root>[], onError = vi.fn()) =>
	createGraph<Root>(
		{
			doubled: (f) => f.base * 2,
			dependent: (f) => f.doubled + 1,
		},
		undefined,
		{ interceptors, onError },
	);

describe("interceptor error paths", () => {
	it("marks the node error, reports onError, and skips dependents when an interceptor throws", async () => {
		const onError = vi.fn();
		const graph = makeGraph(
			[
				(path, value, _state, next) => {
					if (path === "doubled") throw new Error("rejected");
					return next(value);
				},
			],
			onError,
		);

		const result = await graph.compute({ base: 5 });

		expect(graph.status("doubled")).toBe("error");
		expect(graph.status("dependent")).toBe("error");
		expect(onError).toHaveBeenCalledWith(
			expect.objectContaining({ key: "doubled" }),
		);
		// Neither the errored node nor its blocked dependent leak into the patch.
		expect(result.doubled).toBeUndefined();
		expect(result.dependent).toBeUndefined();
	});

	it("errors the node when an interceptor calls next() more than once", async () => {
		const onError = vi.fn();
		const graph = makeGraph(
			[
				(_path, value, _state, next) => {
					next(value);
					return next(value);
				},
			],
			onError,
		);

		await graph.compute({ base: 5 });

		expect(graph.status("doubled")).toBe("error");
		const call = onError.mock.calls.find((c) => c[0].key === "doubled");
		expect((call?.[0].cause as Error).message).toMatch(
			/called next\(\) multiple times/,
		);
	});

	it("short-circuits with the interceptor's own value when next() is not called", async () => {
		const graph = makeGraph([
			(path, value) => (path === "doubled" ? 999 : value),
		]);

		const result = await graph.compute({ base: 5 });

		expect(result.doubled).toBe(999);
		// dependent reads the short-circuited value.
		expect(result.dependent).toBe(1000);
	});

	it("does not reject when state contains a typed array", async () => {
		interface BytesRoot {
			bytes: Uint8Array;
			len: number;
		}
		const graph = createGraph<BytesRoot>(
			{ len: (f) => f.bytes.length },
			undefined,
			{
				interceptors: [(_path, value, _state, next) => next(value)],
			},
		);

		const result = await graph.compute({ bytes: new Uint8Array([1, 2, 3]) });
		expect(result.len).toBe(3);
	});

	it("runs multiple interceptors in array order, threading the value through", async () => {
		const order: string[] = [];
		const graph = makeGraph([
			(_path, value, _state, next) => {
				order.push("first");
				return next((value as number) + 1);
			},
			(_path, value, _state, next) => {
				order.push("second");
				return next((value as number) * 10);
			},
		]);

		const result = await graph.compute({ base: 5 });

		// doubled = 10 -> first (+1) = 11 -> second (*10) = 110
		expect(result.doubled).toBe(110);
		expect(order.slice(0, 2)).toEqual(["first", "second"]);
	});
});
