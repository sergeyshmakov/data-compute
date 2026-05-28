import { describe, expect, it, vi } from "vitest";
import { batchRequest, createGraph, each, request } from "../../index.js";
import type { BatchDataSourceConfig, DeepPartial } from "../../types.js";
import type { FastSlowRoot, SlowRoot } from "./test-types.js";

describe("stalePolicy discard", () => {
	it("does not call setState when result is discarded due to stale", async () => {
		const setState = vi.fn();
		const graph = createGraph<SlowRoot>(
			{
				slow: async () => {
					await new Promise((r) => setTimeout(r, 50));
					return "slow";
				},
			},
			undefined,
			{ setState, stalePolicy: "discard" },
		);
		const p1 = graph.compute({});
		const p2 = graph.compute({});
		const [, result2] = await Promise.all([p1, p2]);
		expect(result2.slow).toBe("slow");
		expect(setState).toHaveBeenCalledTimes(1);
	});

	it("marks remaining pending nodes stale and returns partial state", async () => {
		let resolveSlow!: () => void;
		const slowPromise = new Promise<string>((r) => {
			resolveSlow = () => r("slow");
		});
		const graph = createGraph<FastSlowRoot>(
			{
				fast: () => "fast",
				slow: () => slowPromise,
			},
			undefined,
			{ stalePolicy: "discard" },
		);
		const p1 = graph.compute({});
		await new Promise((r) => setTimeout(r, 0));
		const p2 = graph.compute({});
		resolveSlow();
		const [result1, result2] = await Promise.all([p1, p2]);
		expect(result1.fast).toBe("fast");
		expect(result1.slow).toBeUndefined();
		expect(result2.fast).toBe("fast");
		expect(result2.slow).toBe("slow");
	});
});

describe("stalePolicy discard-and-retry", () => {
	it("retries when stale; single compute completes successfully", async () => {
		const graph = createGraph<SlowRoot>(
			{
				slow: async () => {
					await new Promise((r) => setTimeout(r, 20));
					return "done";
				},
			},
			undefined,
			{ stalePolicy: "discard-and-retry" },
		);
		const result = await graph.compute({});
		expect(result.slow).toBe("done");
	});

	it("does not replay an old patch over newer state when retrying", async () => {
		interface RetryRoot {
			input: number;
			doubled: number;
		}

		let releaseOld!: () => void;
		let oldRunCount = 0;
		const store: RetryRoot = { input: 0, doubled: 0 };
		const setState = vi.fn((patch: Partial<RetryRoot>) => {
			Object.assign(store, patch);
		});

		const graph = createGraph<RetryRoot>(
			{
				doubled: async (f) => {
					if (f.input === 1 && oldRunCount++ === 0) {
						await new Promise<void>((resolve) => {
							releaseOld = resolve;
						});
					}
					return f.input * 2;
				},
			},
			undefined,
			{
				stalePolicy: "discard-and-retry",
				getState: () => store,
				setState,
			},
		);

		const first = graph.compute({ input: 1 });
		await new Promise((resolve) => setTimeout(resolve, 0));

		const second = graph.compute({ input: 2 });
		await expect(second).resolves.toEqual({ input: 2, doubled: 4 });
		expect(store).toEqual({ input: 2, doubled: 4 });

		releaseOld();
		await expect(first).resolves.toEqual({ input: 2, doubled: 4 });

		expect(store).toEqual({ input: 2, doubled: 4 });
		expect(setState).not.toHaveBeenCalledWith({
			input: 1,
			doubled: 2,
		});
	});

	it("does not replay source keys from earlier successful cycles", async () => {
		interface Root {
			a: number;
			b: number;
			sum: number;
		}

		let releaseOld!: () => void;
		let oldRunCount = 0;
		const store: Root = { a: 1, b: 0, sum: 0 };
		const setState = vi.fn((patch: Partial<Root>) => {
			Object.assign(store, patch);
		});

		const graph = createGraph<Root>(
			{},
			{
				sum: request((f) => ({ a: f.a, b: f.b }), {
					stalePolicy: "discard-and-retry",
					query: async ({ a, b }) => {
						if (b === 1 && oldRunCount++ === 0) {
							await new Promise<void>((resolve) => {
								releaseOld = resolve;
							});
						}
						return a + b;
					},
				}),
			},
			{ getState: () => store, setState },
		);

		await graph.compute({ a: 1 });
		store.a = 2;

		const first = graph.compute({ b: 1 });
		await new Promise((resolve) => setTimeout(resolve, 0));
		const second = graph.compute({ b: 2 });

		await expect(second).resolves.toEqual({ b: 2, sum: 4 });
		releaseOld();
		await expect(first).resolves.toEqual({ b: 2, sum: 4 });
		expect(store).toEqual({ a: 2, b: 2, sum: 4 });
	});

	it("honors request-level discard-and-retry without graph-level policy", async () => {
		interface Root {
			input: number;
			result: number;
		}
		let releaseOld!: () => void;
		let oldRunCount = 0;
		const store: Root = { input: 0, result: 0 };
		const setState = vi.fn((patch: Partial<Root>) => {
			Object.assign(store, patch);
		});

		const graph = createGraph<Root>(
			{},
			{
				result: request((f) => f.input, {
					stalePolicy: "discard-and-retry",
					query: async (input) => {
						if (input === 1 && oldRunCount++ === 0) {
							await new Promise<void>((resolve) => {
								releaseOld = resolve;
							});
						}
						return input * 2;
					},
				}),
			},
			{ getState: () => store, setState },
		);

		const first = graph.compute({ input: 1 });
		await new Promise((resolve) => setTimeout(resolve, 0));
		const second = graph.compute({ input: 2 });

		await expect(second).resolves.toEqual({ input: 2, result: 4 });
		releaseOld();
		await expect(first).resolves.toEqual({ input: 2, result: 4 });
		expect(setState).not.toHaveBeenCalledWith({ input: 1, result: 2 });
		expect(store).toEqual({ input: 2, result: 4 });
	});

	it("honors batch-level discard-and-retry without graph-level policy", async () => {
		interface Root {
			input: number;
			result: number;
		}
		let releaseOld!: () => void;
		let oldRunCount = 0;
		const store: Root = { input: 0, result: 0 };
		const setState = vi.fn((patch: Partial<Root>) => {
			Object.assign(store, patch);
		});

		const graph = createGraph<Root>(
			{},
			{
				result: batchRequest((f) => f.input, {
					stalePolicy: "discard-and-retry",
					query: async (entries) => {
						const input = entries[0].request;
						if (input === 1 && oldRunCount++ === 0) {
							await new Promise<void>((resolve) => {
								releaseOld = resolve;
							});
						}
						return entries.map((entry) => ({
							id: entry.id,
							response: entry.request * 2,
						}));
					},
				}),
			},
			{ getState: () => store, setState },
		);

		const first = graph.compute({ input: 1 });
		await new Promise((resolve) => setTimeout(resolve, 0));
		const second = graph.compute({ input: 2 });

		await expect(second).resolves.toEqual({ input: 2, result: 4 });
		releaseOld();
		await expect(first).resolves.toEqual({ input: 2, result: 4 });
		expect(setState).not.toHaveBeenCalledWith({ input: 1, result: 2 });
		expect(store).toEqual({ input: 2, result: 4 });
	});

	it("retries stale async each nodes against the latest input", async () => {
		interface Root {
			items: { value: number; doubled: number }[];
		}
		let releaseOld!: () => void;
		let oldRunCount = 0;
		let store: Root = { items: [{ value: 0, doubled: 0 }] };
		const setState = vi.fn((patch: DeepPartial<Root>) => {
			store = patch as Root;
		});

		const graph = createGraph<Root>(
			{
				items: each({
					doubled: async (item) => {
						if (item.value === 1 && oldRunCount++ === 0) {
							await new Promise<void>((resolve) => {
								releaseOld = resolve;
							});
						}
						return item.value * 2;
					},
				}),
			},
			undefined,
			{
				stalePolicy: "discard-and-retry",
				getState: () => store,
				setState,
			},
		);

		const first = graph.compute({ items: [{ value: 1 }] });
		await new Promise((resolve) => setTimeout(resolve, 0));
		const second = graph.compute({ items: [{ value: 2 }] });

		await expect(second).resolves.toEqual({
			items: [{ value: 2, doubled: 4 }],
		});
		releaseOld();
		await expect(first).resolves.toEqual({
			items: [{ value: 2, doubled: 4 }],
		});
		expect(setState).not.toHaveBeenCalledWith({
			items: [{ value: 1, doubled: 2 }],
		});
	});
});

describe("batch coordinator stale handling", () => {
	it("does not abort a completed batch signal when stale is detected after await", async () => {
		const capturedSignals: AbortSignal[] = [];
		const queryFn = vi
			.fn()
			.mockImplementation(
				(_entries: unknown[], meta: { signal: AbortSignal }) => {
					capturedSignals.push(meta.signal);
					return new Promise((resolve, reject) => {
						meta.signal.addEventListener("abort", () => {
							reject(new DOMException("Aborted"));
						});
						setTimeout(() => resolve([{ id: "1", response: {} }]), 50);
					});
				},
			);
		const graph = createGraph<SlowRoot>(
			{},
			{
				slow: batchRequest(() => ({ id: 0 }), {
					query: queryFn as BatchDataSourceConfig<
						{ id: number },
						string
					>["query"],
					stalePolicy: "discard",
				}),
			},
			{ stalePolicy: "discard" },
		);
		const p1 = graph.compute({});
		await new Promise((r) => setTimeout(r, 0));
		const p2 = graph.compute({});
		await Promise.all([p1, p2]);
		expect(capturedSignals[0]?.aborted).toBe(false);
	});
});
