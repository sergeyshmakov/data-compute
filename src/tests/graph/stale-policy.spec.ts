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

	it("does not commit stale normal-node results after awaited interceptors", async () => {
		interface Root {
			input: number;
			doubled: number;
		}

		let releaseOld!: () => void;
		const store: Root = { input: 0, doubled: 0 };
		const setState = vi.fn((patch: DeepPartial<Root>) => {
			Object.assign(store, patch);
		});

		const graph = createGraph<Root>(
			{
				doubled: (f) => f.input * 2,
			},
			undefined,
			{
				stalePolicy: "discard",
				getState: () => store,
				setState,
				interceptors: [
					async (path, value, state, next) => {
						if (path === "doubled" && (state as Root).input === 1) {
							await new Promise<void>((resolve) => {
								releaseOld = resolve;
							});
						}
						return next(value);
					},
				],
			},
		);

		const first = graph.compute({ input: 1 });
		await new Promise((resolve) => setTimeout(resolve, 0));
		const second = graph.compute({ input: 2 });

		await expect(second).resolves.toEqual({ input: 2, doubled: 4 });
		releaseOld();
		await expect(first).resolves.toEqual({ input: 1 });
		expect(setState).not.toHaveBeenCalledWith({ input: 1, doubled: 2 });
		expect(store).toEqual({ input: 2, doubled: 4 });
	});

	it("does not commit partial stale each results after awaited interceptors", async () => {
		interface Root {
			items: { value: number; doubled: number }[];
		}

		let releaseOld!: () => void;
		let markOldInterceptorStarted!: () => void;
		const oldInterceptorStarted = new Promise<void>((resolve) => {
			markOldInterceptorStarted = resolve;
		});
		let store: Root = { items: [{ value: 0, doubled: 0 }] };
		const setState = vi.fn((patch: DeepPartial<Root>) => {
			store = patch as Root;
		});

		const graph = createGraph<Root>(
			{
				items: each({
					doubled: (item) => item.value * 2,
				}),
			},
			undefined,
			{
				stalePolicy: "discard",
				getState: () => store,
				setState,
				interceptors: [
					async (path, value, state, next) => {
						if (
							path === "items.1.doubled" &&
							(state as Root).items[0].value === 1
						) {
							markOldInterceptorStarted();
							await new Promise<void>((resolve) => {
								releaseOld = resolve;
							});
						}
						return next(value);
					},
				],
			},
		);

		const first = graph.compute({
			items: [{ value: 1 }, { value: 10 }],
		});
		await oldInterceptorStarted;
		const second = graph.compute({
			items: [{ value: 2 }, { value: 20 }],
		});

		await expect(second).resolves.toEqual({
			items: [
				{ value: 2, doubled: 4 },
				{ value: 20, doubled: 40 },
			],
		});
		releaseOld();
		await expect(first).resolves.toEqual({
			items: [{ value: 1 }, { value: 10 }],
		});
		expect(setState).not.toHaveBeenCalledWith({
			items: [{ value: 1, doubled: 2 }, { value: 10 }],
		});
		expect(store).toEqual({
			items: [
				{ value: 2, doubled: 4 },
				{ value: 20, doubled: 40 },
			],
		});
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

	it("retries stale normal-node interceptors against the latest input", async () => {
		interface Root {
			input: number;
			doubled: number;
		}

		let releaseOld!: () => void;
		const store: Root = { input: 0, doubled: 0 };
		const setState = vi.fn((patch: DeepPartial<Root>) => {
			Object.assign(store, patch);
		});

		const graph = createGraph<Root>(
			{
				doubled: (f) => f.input * 2,
			},
			undefined,
			{
				stalePolicy: "discard-and-retry",
				getState: () => store,
				setState,
				interceptors: [
					async (path, value, state, next) => {
						if (path === "doubled" && (state as Root).input === 1) {
							await new Promise<void>((resolve) => {
								releaseOld = resolve;
							});
						}
						return next(value);
					},
				],
			},
		);

		const first = graph.compute({ input: 1 });
		await new Promise((resolve) => setTimeout(resolve, 0));
		const second = graph.compute({ input: 2 });

		await expect(second).resolves.toEqual({ input: 2, doubled: 4 });
		releaseOld();
		await expect(first).resolves.toEqual({ input: 2, doubled: 4 });
		expect(setState).not.toHaveBeenCalledWith({ input: 1, doubled: 2 });
		expect(store).toEqual({ input: 2, doubled: 4 });
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

	it("retries stale each interceptors without overwriting ready status", async () => {
		interface Root {
			items: { value: number; doubled: number }[];
		}

		let releaseOld!: () => void;
		let store: Root = { items: [{ value: 0, doubled: 0 }] };
		const setState = vi.fn((patch: DeepPartial<Root>) => {
			store = patch as Root;
		});

		const graph = createGraph<Root>(
			{
				items: each({
					doubled: (item) => item.value * 2,
				}),
			},
			undefined,
			{
				stalePolicy: "discard-and-retry",
				getState: () => store,
				setState,
				interceptors: [
					async (path, value, state, next) => {
						if (
							path === "items.0.doubled" &&
							(state as Root).items[0].value === 1
						) {
							await new Promise<void>((resolve) => {
								releaseOld = resolve;
							});
						}
						return next(value);
					},
				],
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
		expect(graph.status("items.*.doubled")).toBe("ready");
		expect(setState).not.toHaveBeenCalledWith({
			items: [{ value: 1, doubled: 2 }],
		});
		expect(store).toEqual({ items: [{ value: 2, doubled: 4 }] });
	});
});

describe("batch coordinator stale handling", () => {
	it("aborts an in-flight batch signal when a newer compute supersedes it", async () => {
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
		// The superseded run's query must have its signal aborted so signal-aware
		// data sources can cancel instead of running to completion.
		expect(capturedSignals[0]?.aborted).toBe(true);
	});

	it("still resolves when a signal-ignoring query is superseded (result discarded)", async () => {
		let firstQueryCompleted = false;
		let call = 0;
		const queryFn = vi.fn().mockImplementation((entries: { id: string }[]) => {
			call++;
			const isFirst = call === 1;
			// This query ignores meta.signal entirely.
			return new Promise((resolve) => {
				setTimeout(() => {
					if (isFirst) firstQueryCompleted = true;
					resolve([{ id: entries[0].id, response: {} }]);
				}, 20);
			});
		});
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
		// Neither compute rejects; the superseded query keeps running (it ignores
		// the abort signal) and its stale result is simply discarded.
		await expect(Promise.all([p1, p2])).resolves.toBeDefined();
		await new Promise((r) => setTimeout(r, 40));
		expect(firstQueryCompleted).toBe(true);
	});
});
