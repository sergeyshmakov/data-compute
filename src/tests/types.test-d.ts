/**
 * Type tests using expectTypeOf and assertType.
 * Run with: vitest run --typecheck
 */
/// <reference types="vitest/globals" />

import { assertType, expectTypeOf } from "vitest";
import {
	batchRequest,
	createGraph,
	each,
	eachDataSource,
	request,
} from "../index.js";
import type {
	DataSourceMap,
	DeepFormulaMap,
	DeepPartial,
	GraphError,
	NodeSnapshot,
} from "../types.js";

// ── Schema types for tests ───────────────────────────────────────────────────

type Item = {
	id: number;
	price: number;
	tax: number;
};

type DeepRoot = {
	items: Item[];
	nested: {
		value: string;
		computedValue: string;
	};
	total: number;
	apiResponse: { data: string };
};

type ItemWithSource = Item & { itemResponse?: { data: string } };
type RootWithItemSources = Omit<DeepRoot, "items"> & {
	items: ItemWithSource[];
};

describe("DeepFormulaMap types", () => {
	it("allows deep mapping", () => {
		const _formulas: DeepFormulaMap<DeepRoot, DeepRoot, DeepRoot> = {
			nested: {
				computedValue: (f) => `${f.nested.value} computed`,
			},
			total: (f) => f.items.reduce((acc, i) => acc + i.price + i.tax, 0),
			items: each({
				tax: (item, root) => item.price * 0.2 + root.total * 0.01,
			}),
		};
		assertType<DeepFormulaMap<DeepRoot, DeepRoot, DeepRoot>>(_formulas);
	});

	it("requires correct return types for deep mapping", () => {
		const _formulas: DeepFormulaMap<DeepRoot, DeepRoot, DeepRoot> = {
			nested: {
				// @ts-expect-error - should return string
				computedValue: (_f) => 123,
			},
		};
	});

	it("requires correct return types for each mapping", () => {
		const _formulas: DeepFormulaMap<DeepRoot, DeepRoot, DeepRoot> = {
			items: each({
				// @ts-expect-error - should return number
				tax: (_item) => "not a number",
			}),
		};
	});

	it("rejects invalid keys in formula state parameter", () => {
		const _formulas: DeepFormulaMap<DeepRoot, DeepRoot, DeepRoot> = {
			// @ts-expect-error - 'typo' does not exist on DeepRoot
			total: (f) => f.typo,
		};
	});

	it("rejects invalid keys in each item parameter", () => {
		const _formulas: DeepFormulaMap<DeepRoot, DeepRoot, DeepRoot> = {
			items: each({
				// @ts-expect-error - 'wrongKey' does not exist on Item
				tax: (item) => item.wrongKey,
			}),
		};
	});

	it("rejects invalid keys in each root parameter", () => {
		const _formulas: DeepFormulaMap<DeepRoot, DeepRoot, DeepRoot> = {
			items: each({
				// @ts-expect-error - 'wrongKey' does not exist on DeepRoot
				tax: (_item, root) => root.wrongKey,
			}),
		};
	});
});

describe("DataSourceMap types", () => {
	it("allows batchRequest configuration", () => {
		const _sources: DataSourceMap<DeepRoot, DeepRoot, DeepRoot> = {
			apiResponse: batchRequest((f) => ({ total: f.total }), {
				query: async (entries) => {
					return entries.map((e) => ({
						id: e.id,
						response: { data: String(e.request.total) },
					}));
				},
			}),
		};
		assertType<DataSourceMap<DeepRoot, DeepRoot, DeepRoot>>(_sources);
	});

	it("enforces types on batchRequest dependencies", () => {
		batchRequest<DeepRoot, DeepRoot, { x: string }, { data: string }>(
			// @ts-expect-error - 'nonExistent' does not exist on DeepRoot
			(f) => ({ x: f.nonExistent }),
			{
				query: async (_entries) => [],
			},
		);
	});

	it("enforces types on batchRequest return", () => {
		const _sources: DataSourceMap<DeepRoot, DeepRoot, DeepRoot> = {
			// @ts-expect-error - apiResponse is { data: string }, not { wrong: string }
			apiResponse: batchRequest((f) => ({ total: f.total }), {
				query: async (entries) => {
					return entries.map((e) => ({
						id: e.id,
						response: { wrong: "type" },
					}));
				},
			}),
		};
	});

	it("allows request configuration", () => {
		const _sources: DataSourceMap<DeepRoot, DeepRoot, DeepRoot> = {
			apiResponse: request((f) => ({ total: f.total }), {
				query: async (req) => {
					return { data: String(req.total) };
				},
			}),
		};
		assertType<DataSourceMap<DeepRoot, DeepRoot, DeepRoot>>(_sources);
	});

	it("allows eachDataSource configuration", () => {
		const _sources: DataSourceMap<
			RootWithItemSources,
			RootWithItemSources,
			RootWithItemSources
		> = {
			items: eachDataSource({
				itemResponse: request((item) => ({ id: item.id }), {
					query: async () => ({ data: "x" }),
				}),
			}),
		};
		assertType<
			DataSourceMap<
				RootWithItemSources,
				RootWithItemSources,
				RootWithItemSources
			>
		>(_sources);
	});

	it("enforces types on request dependencies", () => {
		request<DeepRoot, DeepRoot, { x: string }, { data: string }>(
			// @ts-expect-error - 'nonExistent' does not exist on DeepRoot
			(f) => ({ x: f.nonExistent }),
			{
				query: async () => ({ data: "x" }),
			},
		);
	});
});

describe("createGraph integration", () => {
	it("returns Graph with correct root type", () => {
		const graph = createGraph<DeepRoot>({
			total: (_f) => 42,
		});

		expectTypeOf(graph.compute).toBeFunction();
		expectTypeOf(graph.compute).returns.resolves.toEqualTypeOf<
			DeepPartial<DeepRoot>
		>();
	});

	it("builder pattern returns Graph with correct root type", () => {
		const graph = createGraph<DeepRoot>()({
			total: (f) => f.items.length,
		});
		expectTypeOf(graph.compute).returns.resolves.toEqualTypeOf<
			DeepPartial<DeepRoot>
		>();
	});

	it("compute rejects invalid input keys", () => {
		const graph = createGraph<DeepRoot>({ total: (_f) => 42 });
		// @ts-expect-error - 'invalidKey' does not exist on DeepRoot
		graph.compute({ invalidKey: "x" });
	});

	it("trace rejects invalid input keys", () => {
		const graph = createGraph<DeepRoot>({ total: (_f) => 42 });
		// @ts-expect-error - 'invalidKey' does not exist on DeepRoot
		graph.trace({ invalidKey: "x" });
	});
});

describe("Graph NodeAccessor", () => {
	const graph = createGraph<DeepRoot>({ total: (f) => f.items.length });

	it("computeStatus accepts valid accessor", () => {
		const status = graph.computeStatus((x) => x.total);
		expectTypeOf(status).toEqualTypeOf<
			"ready" | "stale" | "pending" | "error"
		>();
	});

	it("computeStatus rejects invalid accessor", () => {
		// @ts-expect-error - 'typo' does not exist on DeepRoot
		graph.computeStatus((x) => x.typo);
	});

	it("computeResult accepts valid accessor", () => {
		const result = graph.computeResult((x) => x.total);
		expectTypeOf(result).toMatchTypeOf<{
			readonly value: number | undefined;
			readonly status: "ready" | "stale" | "pending" | "error";
		}>();
	});

	it("computeResult rejects invalid accessor", () => {
		// @ts-expect-error - 'typo' does not exist on DeepRoot
		graph.computeResult((x) => x.typo);
	});

	it("deps accepts valid accessor", () => {
		const deps = graph.deps((x) => x.total);
		expectTypeOf(deps).toEqualTypeOf<readonly string[]>();
	});

	it("deps rejects invalid accessor", () => {
		// @ts-expect-error - 'typo' does not exist on DeepRoot
		graph.deps((x) => x.typo);
	});

	it("dependents accepts valid accessor", () => {
		const dependents = graph.dependents((x) => x.total);
		expectTypeOf(dependents).toEqualTypeOf<readonly string[]>();
	});

	it("dependents rejects invalid accessor", () => {
		// @ts-expect-error - 'typo' does not exist on DeepRoot
		graph.dependents((x) => x.typo);
	});
});

describe("GraphOptions", () => {
	it("getState return type matches Root", () => {
		createGraph<DeepRoot>({ total: (_f) => 42 }, undefined, {
			getState: () =>
				({
					items: [],
					nested: { value: "", computedValue: "" },
					total: 0,
					apiResponse: { data: "" },
				}) as DeepRoot,
		});
	});

	it("getState rejects wrong return shape", () => {
		createGraph<DeepRoot>({ total: (_f) => 42 }, undefined, {
			// @ts-expect-error - return must match DeepRoot shape
			getState: () => ({ wrongShape: true }),
		});
	});

	it("setState patch type is DeepPartial<Root>", () => {
		createGraph<DeepRoot>({ total: (_f) => 42 }, undefined, {
			setState: (patch) => {
				expectTypeOf(patch).toMatchTypeOf<DeepPartial<DeepRoot>>();
			},
		});
	});

	it("setState rejects wrong patch shape", () => {
		createGraph<DeepRoot>({ total: (_f) => 42 }, undefined, {
			// @ts-expect-error - patch must be DeepPartial<DeepRoot>
			setState: (_patch: { invalidKey: string }) => {},
		});
	});

	it("onError receives GraphError", () => {
		createGraph<DeepRoot>({ total: (_f) => 42 }, undefined, {
			onError: (err) => {
				expectTypeOf(err).toMatchTypeOf<GraphError>();
				expectTypeOf(err.key).toEqualTypeOf<string>();
				expectTypeOf(err.cause).toEqualTypeOf<unknown>();
			},
		});
	});
});

describe("Graph snapshot", () => {
	const graph = createGraph<DeepRoot>({ total: (f) => f.items.length });

	it("snapshot<T> returns NodeSnapshot<T>", () => {
		const snap = graph.snapshot<number>("total");
		expectTypeOf(snap).toMatchTypeOf<NodeSnapshot<number>>();
	});
});
