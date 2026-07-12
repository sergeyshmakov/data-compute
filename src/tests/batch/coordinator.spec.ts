import { describe, expect, it, vi } from "vitest";
import { BatchCoordinator } from "../../batch/coordinator.js";
import type { BatchDataSourceConfig } from "../../types.js";

describe("BatchCoordinator", () => {
	describe("submit", () => {
		it("resolves with query response", async () => {
			const queryFn = vi
				.fn()
				.mockImplementation(async (entries: { id: string }[]) =>
					entries.map((e) => ({ id: e.id, response: { data: 42 } })),
				);
			const config: BatchDataSourceConfig<{ id: number }, { data: number }> = {
				query: queryFn,
			};
			const coordinator = new BatchCoordinator();
			const result = await coordinator.submit(config, { id: 1 });
			expect(result).toEqual({ data: 42 });
			expect(queryFn).toHaveBeenCalled();
		});

		it("coalesces multiple submits in same microtask", async () => {
			const queryFn = vi
				.fn()
				.mockImplementation(async (entries: { id: string }[]) =>
					entries.map((e) => ({ id: e.id, response: e.id })),
				);
			const config: BatchDataSourceConfig<{ req: number }, string> = {
				query: queryFn,
			};
			const coordinator = new BatchCoordinator();
			const p1 = coordinator.submit(config, { req: 1 });
			const p2 = coordinator.submit(config, { req: 2 });
			const [r1, r2] = await Promise.all([p1, p2]);
			expect(queryFn).toHaveBeenCalledTimes(1);
			expect(queryFn).toHaveBeenCalledWith(
				expect.arrayContaining([
					expect.objectContaining({ request: { req: 1 } }),
					expect.objectContaining({ request: { req: 2 } }),
				]),
				expect.objectContaining({ signal: expect.any(AbortSignal) }),
			);
			expect(r1).toBeDefined();
			expect(r2).toBeDefined();
		});

		it("rejects submits omitted from query outcomes", async () => {
			const config: BatchDataSourceConfig<{ req: number }, string> = {
				query: vi
					.fn()
					.mockImplementation(async (entries: { id: string }[]) => [
						{ id: entries[0].id, response: "first" },
					]),
			};
			const coordinator = new BatchCoordinator();
			const p1 = coordinator.submit(config, { req: 1 });
			const p2 = coordinator.submit(config, { req: 2 });

			await expect(p1).resolves.toBe("first");
			await expect(p2).rejects.toThrow("Missing batch outcome for id");
		});

		it("ignores unknown query outcomes", async () => {
			const config: BatchDataSourceConfig<{ req: number }, string> = {
				query: vi.fn().mockImplementation(async (entries: { id: string }[]) => [
					{ id: "unknown", response: "ignored" },
					{ id: entries[0].id, response: "ok" },
				]),
			};
			const coordinator = new BatchCoordinator();
			await expect(coordinator.submit(config, { req: 1 })).resolves.toBe("ok");
		});
	});

	describe("submit with dedupeKey", () => {
		it("deduplicates requests with same dedupeKey", async () => {
			const queryFn = vi
				.fn()
				.mockImplementation(
					async (entries: { id: string; request: { key: string } }[]) =>
						entries.map((e) => ({
							id: e.id,
							response: { value: e.request.key },
						})),
				);
			const config: BatchDataSourceConfig<{ key: string }, { value: string }> =
				{
					query: queryFn,
					dedupeKey: (req) => req.key,
				};
			const coordinator = new BatchCoordinator();
			const p1 = coordinator.submit(config, { key: "same" });
			const p2 = coordinator.submit(config, { key: "same" });
			const [r1, r2] = await Promise.all([p1, p2]);
			expect(queryFn).toHaveBeenCalledTimes(1);
			expect(queryFn).toHaveBeenCalledWith(
				expect.arrayContaining([
					expect.objectContaining({ request: { key: "same" } }),
				]),
				expect.any(Object),
			);
			expect(r1).toEqual({ value: "same" });
			expect(r2).toEqual({ value: "same" });
		});

		it("fans out response to all callers with same dedupeKey", async () => {
			const config: BatchDataSourceConfig<{ a: number }, { shared: boolean }> =
				{
					query: vi
						.fn()
						.mockImplementation(async (entries: { id: string }[]) => [
							{ id: entries[0].id, response: { shared: true } },
						]),
					dedupeKey: () => "key",
				};
			const coordinator = new BatchCoordinator();
			const [r1, r2, r3] = await Promise.all([
				coordinator.submit(config, { a: 1 }),
				coordinator.submit(config, { a: 2 }),
				coordinator.submit(config, { a: 3 }),
			]);
			expect(r1).toEqual({ shared: true });
			expect(r2).toEqual({ shared: true });
			expect(r3).toEqual({ shared: true });
		});
	});

	describe("abort", () => {
		it("aborts in-flight query", async () => {
			let capturedSignal: AbortSignal | undefined;
			const config: BatchDataSourceConfig<unknown, unknown> = {
				query: vi
					.fn()
					.mockImplementation(
						(_entries: unknown[], meta: { signal: AbortSignal }) => {
							capturedSignal = meta.signal;
							return new Promise((_, reject) => {
								meta.signal.addEventListener("abort", () =>
									reject(new DOMException("Aborted")),
								);
							});
						},
					),
			};
			const coordinator = new BatchCoordinator();
			const resultPromise = coordinator.submit(config, {});
			await new Promise((r) => setTimeout(r, 0));
			coordinator.abort();
			expect(capturedSignal?.aborted).toBe(true);
			await expect(resultPromise).rejects.toThrow();
		});

		it("does not abort completed successful queries", async () => {
			let capturedSignal: AbortSignal | undefined;
			const config: BatchDataSourceConfig<unknown, unknown> = {
				query: vi
					.fn()
					.mockImplementation(
						async (
							entries: { id: string }[],
							meta: { signal: AbortSignal },
						) => {
							capturedSignal = meta.signal;
							return [{ id: entries[0].id, response: "ok" }];
						},
					),
			};
			const coordinator = new BatchCoordinator();
			await coordinator.submit(config, {});
			coordinator.abort();
			expect(capturedSignal?.aborted).toBe(false);
		});

		it("remembers an abort issued before the channel flushes", async () => {
			let capturedSignal: AbortSignal | undefined;
			const config: BatchDataSourceConfig<unknown, unknown> = {
				query: vi
					.fn()
					.mockImplementation(
						async (
							entries: { id: string }[],
							meta: { signal: AbortSignal },
						) => {
							capturedSignal = meta.signal;
							return entries.map((e) => ({ id: e.id, response: "ok" }));
						},
					),
			};
			const coordinator = new BatchCoordinator();
			const p = coordinator.submit(config, {});
			// Abort synchronously, before the queued flush microtask runs and the
			// channel's AbortController is created.
			coordinator.abort();
			await p.catch(() => {});
			expect(capturedSignal?.aborted).toBe(true);
		});

		it("does not abort completed failed queries", async () => {
			let capturedSignal: AbortSignal | undefined;
			const config: BatchDataSourceConfig<unknown, unknown> = {
				query: vi
					.fn()
					.mockImplementation(
						async (_entries: unknown[], meta: { signal: AbortSignal }) => {
							capturedSignal = meta.signal;
							throw new Error("query error");
						},
					),
			};
			const coordinator = new BatchCoordinator();
			await expect(coordinator.submit(config, {})).rejects.toThrow(
				"query error",
			);
			coordinator.abort();
			expect(capturedSignal?.aborted).toBe(false);
		});
	});

	describe("batch failure handling", () => {
		it("rejects when query returns failure outcome", async () => {
			const error = new Error("batch failed");
			const config: BatchDataSourceConfig<unknown, unknown> = {
				query: vi
					.fn()
					.mockImplementation(async (entries: { id: string }[]) => [
						{ id: entries[0].id, error },
					]),
			};
			const coordinator = new BatchCoordinator();
			const resultPromise = coordinator.submit(config, {});
			await expect(resultPromise).rejects.toThrow("batch failed");
		});
	});

	describe("query throws", () => {
		it("rejects all pending submits when query throws", async () => {
			const config: BatchDataSourceConfig<unknown, unknown> = {
				query: vi.fn().mockRejectedValue(new Error("query error")),
			};
			const coordinator = new BatchCoordinator();
			const p1 = coordinator.submit(config, {});
			const p2 = coordinator.submit(config, {});
			await expect(p1).rejects.toThrow("query error");
			await expect(p2).rejects.toThrow("query error");
		});
	});

	describe("dedupeKey throws", () => {
		it("rejects all pending submits instead of hanging", async () => {
			const queryFn = vi.fn();
			const config: BatchDataSourceConfig<{ k: number }, string> = {
				query: queryFn as BatchDataSourceConfig<{ k: number }, string>["query"],
				dedupeKey: () => {
					throw new Error("bad key");
				},
			};
			const coordinator = new BatchCoordinator();
			const p1 = coordinator.submit(config, { k: 1 });
			const p2 = coordinator.submit(config, { k: 2 });
			await expect(p1).rejects.toThrow("bad key");
			await expect(p2).rejects.toThrow("bad key");
			expect(queryFn).not.toHaveBeenCalled();
		});
	});

	describe("channel keying", () => {
		it("keeps configs sharing a query fn but differing dedupeKey on separate channels", async () => {
			const query = vi
				.fn()
				.mockImplementation(async (entries: { id: string }[]) =>
					entries.map((e) => ({ id: e.id, response: "ok" })),
				);
			// Same query reference, different dedupeKey configuration.
			const deduped: BatchDataSourceConfig<{ k: string }, string> = {
				query: query as BatchDataSourceConfig<{ k: string }, string>["query"],
				dedupeKey: () => "same",
			};
			const notDeduped: BatchDataSourceConfig<{ k: string }, string> = {
				query: query as BatchDataSourceConfig<{ k: string }, string>["query"],
			};
			const coordinator = new BatchCoordinator();
			await Promise.all([
				coordinator.submit(deduped, { k: "a" }),
				coordinator.submit(deduped, { k: "b" }),
				coordinator.submit(notDeduped, { k: "c" }),
				coordinator.submit(notDeduped, { k: "d" }),
			]);
			// Two separate channels → two query calls; the deduped channel collapses
			// its two entries to one, the other keeps both.
			expect(query).toHaveBeenCalledTimes(2);
			const callSizes = query.mock.calls
				.map((c) => (c[0] as unknown[]).length)
				.sort();
			expect(callSizes).toEqual([1, 2]);
		});
	});
});
