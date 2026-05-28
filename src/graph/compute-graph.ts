import { BatchCoordinator } from "../batch/coordinator.js";
import { topoSort } from "../dag/index.js";
import { resolveAccessor } from "../tracking/accessor.js";
import type {
	BatchDataSourceConfig,
	ComputeInput,
	DataSourceMap,
	DeepFormulaMap,
	DeepPartial,
	Graph,
	GraphOptions,
	NodeAccessor,
	NodeSnapshot,
	NodeStatus,
	RequestDataSourceConfig,
	StalePolicy,
	TraceStep,
} from "../types.js";
import { buildDepsMap, buildReverseDepsMap } from "./deps-maps.js";
import { type FlatNode, flattenGraph } from "./flatten.js";
import { expandRuntimePaths, getByPath, setByPath } from "./path-utils.js";
import {
	cloneForCompute,
	deepFreezeSnapshot,
	mergeDeepPartial,
} from "./state-utils.js";

type RuntimeOutcome =
	| {
			readonly status: "ready";
			readonly runtimePath: string;
			readonly result: unknown;
	  }
	| {
			readonly status: "error";
			readonly runtimePath: string;
			readonly cause: unknown;
	  };

class ComputeGraph<Root> implements Graph<Root> {
	readonly computedKeys: readonly string[];
	readonly nodes: readonly string[];
	readonly order: readonly string[];
	readonly hasCycle: boolean;

	private _sourceKeys: string[] = [];

	private readonly depsMap: ReadonlyMap<string, ReadonlySet<string>>;
	private readonly reverseMap: ReadonlyMap<string, ReadonlySet<string>>;
	private readonly flatNodes: FlatNode[];
	private readonly flatNodeByPath: ReadonlyMap<string, FlatNode>;

	// Runtime node state
	private readonly nodeStatus = new Map<string, NodeStatus>();
	private readonly nodeSnap = new Map<string, NodeSnapshot<unknown>>();

	// Versioning for stale detection
	private version = 0;

	// Microtask batching state
	private pendingPatches: DeepPartial<Root>[] = [];
	private computePromise: Promise<DeepPartial<Root>> | null = null;
	private nextRunId = 0;
	private latestRunId = 0;
	private latestRunPromise: Promise<DeepPartial<Root>> | null = null;

	constructor(
		formulas: DeepFormulaMap<Root, Root, Root>,
		dataSources?: DataSourceMap<Root, Root, Root>,
		private readonly options: GraphOptions<Root> = {},
	) {
		if (
			options.cyclic !== undefined &&
			(options.cyclic as string | undefined) !== "error"
		) {
			throw new Error(
				`Unsupported cyclic mode "${String(options.cyclic)}"; cyclic graphs currently throw.`,
			);
		}

		this.flatNodes = flattenGraph(formulas, dataSources);
		this.flatNodeByPath = new Map(
			this.flatNodes.map((node) => [node.path, node]),
		);

		// Static dependency extraction
		this.depsMap = buildDepsMap(this.flatNodes);
		this.reverseMap = buildReverseDepsMap(this.depsMap);

		const allPaths = this.flatNodes.map((n) => n.path);
		const { order, hasCycle } = topoSort(allPaths, this.depsMap);
		this.hasCycle = hasCycle;

		if (hasCycle) {
			throw new Error("Cyclic dependency detected.");
		}

		this.order = order;
		this.computedKeys = allPaths;
		this.nodes = this.computedKeys;

		for (const path of allPaths) {
			this.nodeStatus.set(path, "pending");
			this.nodeSnap.set(path, { status: "pending" });
		}
	}

	get sourceKeys(): readonly string[] {
		return this._sourceKeys;
	}

	get sources(): readonly string[] {
		return this._sourceKeys;
	}

	compute(input: ComputeInput<Root>): Promise<DeepPartial<Root>> {
		this.version++;
		this.pendingPatches.push(input as DeepPartial<Root>);

		if (!this.computePromise) {
			const runId = ++this.nextRunId;
			const promise = Promise.resolve().then(() => this.flushCompute(runId));
			this.computePromise = promise;
			this.latestRunId = runId;
			this.latestRunPromise = promise;
		}

		return this.computePromise;
	}

	private async flushCompute(runId: number): Promise<DeepPartial<Root>> {
		const currentVersion = this.version;
		const graphStalePolicy = this.options.stalePolicy ?? "discard";

		// Coalesce all patches into a single patch
		const granularPatch = this.pendingPatches.reduce(
			(acc, patch) => mergeDeepPartial(acc, patch),
			// biome-ignore lint/suspicious/noExplicitAny: dynamic value traversal
			{} as any,
		);
		this.pendingPatches = [];
		if (this.computePromise === this.latestRunPromise) {
			this.computePromise = null;
		}

		// Fetch full state if provided, otherwise assume granularPatch is the base
		const baseState = this.options.getState?.() ?? granularPatch;

		// Create the current full state to use for formulas
		const state = mergeDeepPartial<Record<string, unknown>>(
			cloneForCompute(baseState),
			granularPatch,
		);

		const batchCoordinator = new BatchCoordinator();

		// Populate source keys lazily
		if (this._sourceKeys.length === 0) {
			const computedSet = new Set(this.computedKeys);
			this._sourceKeys = Object.keys(state).filter((k) => !computedSet.has(k));
		}

		for (const key of this.order) {
			this.setNodePending(key);
		}

		for (const templatePath of this.order) {
			const node = this.flatNodeByPath.get(templatePath);
			if (!node) continue;

			const stalePolicy = this.effectiveStalePolicy(node, graphStalePolicy);
			if (this.isStale(currentVersion)) {
				batchCoordinator.abort();
				if (stalePolicy === "discard-and-retry") return this.retryLatest(runId);
				this.markRemainingStale(templatePath);
				break;
			}

			if (node.isEach) {
				const expansions = expandRuntimePaths(templatePath, state);
				const outcomes = await Promise.all(
					expansions.map(async ({ runtimePath, item }) => {
						try {
							const result = await this.executeNode(
								node,
								state,
								batchCoordinator,
								item,
							);
							return { status: "ready", runtimePath, result } as const;
						} catch (cause) {
							return { status: "error", runtimePath, cause } as const;
						}
					}),
				);

				if (this.isStale(currentVersion)) {
					batchCoordinator.abort();
					if (stalePolicy === "discard-and-retry")
						return this.retryLatest(runId);
					this.markRemainingStale(templatePath);
					break;
				}

				await this.applyEachOutcomes(
					templatePath,
					outcomes,
					state,
					granularPatch,
				);
			} else {
				try {
					const result = await this.executeNode(
						node,
						state,
						batchCoordinator,
						undefined,
					);

					if (this.isStale(currentVersion)) {
						batchCoordinator.abort();
						if (stalePolicy === "discard-and-retry")
							return this.retryLatest(runId);
						this.markRemainingStale(node.path);
						break;
					}

					const interceptedResult = await this.applyInterceptors(
						node.path,
						result,
						state,
					);
					setByPath(state, node.path, interceptedResult);
					setByPath(granularPatch, node.path, interceptedResult);
					this.setNodeReady(node.path, interceptedResult);
				} catch (cause) {
					this.setNodeError(node.path, cause);
					this.options.onError?.({ key: node.path, cause });
				}
			}
		}

		if (!this.isStale(currentVersion)) {
			this.options.setState?.(granularPatch);
		}

		return granularPatch as DeepPartial<Root>;
	}

	status(path: string): NodeStatus {
		return this.nodeStatus.get(path) ?? "pending";
	}

	computeStatus<T>(accessor: NodeAccessor<Root, T>): NodeStatus {
		return this.status(resolveAccessor(accessor) as string);
	}

	snapshot<T = unknown>(path: string): NodeSnapshot<T> {
		return (this.nodeSnap.get(path) ?? {
			status: "pending",
		}) as NodeSnapshot<T>;
	}

	computeResult<T>(accessor: NodeAccessor<Root, T>): {
		readonly value: T | undefined;
		readonly status: NodeStatus;
	} {
		const path = resolveAccessor(accessor) as string;
		const snap = this.snapshot<T>(path);
		return {
			value: "value" in snap ? snap.value : undefined,
			status: snap.status,
		};
	}

	deps<T>(accessor: NodeAccessor<Root, T>): readonly string[] {
		const key = resolveAccessor(accessor);
		const d = this.depsMap.get(key as string);
		return d ? [...d] : [];
	}

	dependents<T>(accessor: NodeAccessor<Root, T>): readonly string[] {
		const key = resolveAccessor(accessor);
		const d = this.reverseMap.get(key as string);
		return d ? [...d] : [];
	}

	toMermaid(): string {
		const lines: string[] = ["graph TD"];
		for (const [node, deps] of this.depsMap) {
			if (deps.size === 0) {
				lines.push(`  ${node}`);
			}
			for (const dep of deps) {
				lines.push(`  ${dep} --> ${node}`);
			}
		}
		return lines.join("\n");
	}

	trace(input: ComputeInput<Root>): readonly TraceStep[] {
		const state = cloneForCompute(input) as Record<string, unknown>;
		const steps: TraceStep[] = [];

		for (const path of this.order) {
			const node = this.flatNodeByPath.get(path);
			if (!node || node.isEach) continue;

			// We don't trace each nodes for now
			const start = performance.now();
			let result: unknown;
			try {
				result = node.fn(state, state);
			} catch (err) {
				result = err;
			}
			const ms = performance.now() - start;

			const depValues: Record<string, unknown> = {};
			for (const dep of this.depsMap.get(path) ?? []) {
				depValues[dep] = getByPath(state, dep);
			}

			if (
				result !== null &&
				typeof result === "object" &&
				"then" in result &&
				typeof (result as PromiseLike<unknown>).then === "function"
			) {
				steps.push({
					node: path,
					deps: depValues,
					result: "[async]",
					ms,
				});
			} else {
				setByPath(state, path, result);
				steps.push({ node: path, deps: depValues, result, ms });
			}
		}
		return steps;
	}

	private async executeNode(
		node: FlatNode,
		state: Record<string, unknown>,
		batchCoordinator: BatchCoordinator,
		item: unknown,
	): Promise<unknown> {
		const frozenState = deepFreezeSnapshot(cloneForCompute(state));
		const localState = node.isEach
			? deepFreezeSnapshot(cloneForCompute(item))
			: frozenState;

		if (node.type === "formula") {
			return await node.fn(localState, frozenState);
		}

		if (node.type === "batch" && node.config) {
			const request = node.fn(localState, frozenState);
			return await batchCoordinator.submit(
				node.config as BatchDataSourceConfig<unknown, unknown>,
				request,
			);
		}

		if (node.type === "request" && node.config) {
			const request = node.fn(localState, frozenState);
			return await (
				node.config as RequestDataSourceConfig<unknown, unknown>
			).query(request);
		}

		return undefined;
	}

	private applyInterceptors(
		nodePath: string,
		value: unknown,
		state: Record<string, unknown>,
	): unknown {
		const interceptors = this.options.interceptors;
		if (!interceptors?.length) return value;

		const snapshot = deepFreezeSnapshot(cloneForCompute(state));
		const dispatch = (index: number, nextValue: unknown): unknown => {
			const interceptor = interceptors[index];
			if (!interceptor) return nextValue;

			let nextCalled = false;
			return interceptor(nodePath, nextValue, snapshot, (value) => {
				if (nextCalled) {
					throw new Error(
						`Interceptor for "${nodePath}" called next() multiple times.`,
					);
				}
				nextCalled = true;
				return dispatch(index + 1, value);
			});
		};

		return dispatch(0, value);
	}

	private async applyEachOutcomes(
		templatePath: string,
		outcomes: readonly RuntimeOutcome[],
		state: Record<string, unknown>,
		granularPatch: Record<string, unknown>,
	): Promise<void> {
		const successes: unknown[] = [];
		let firstError: unknown;

		for (const outcome of outcomes) {
			if (outcome.status === "ready") {
				try {
					const interceptedResult = await this.applyInterceptors(
						outcome.runtimePath,
						outcome.result,
						state,
					);
					successes.push(interceptedResult);
					setByPath(state, outcome.runtimePath, interceptedResult);
					setByPath(granularPatch, outcome.runtimePath, interceptedResult);
				} catch (cause) {
					if (firstError === undefined) firstError = cause;
					this.options.onError?.({
						key: outcome.runtimePath,
						cause,
					});
				}
			} else {
				if (firstError === undefined) firstError = outcome.cause;
				this.options.onError?.({
					key: outcome.runtimePath,
					cause: outcome.cause,
				});
			}
		}

		if (firstError !== undefined) {
			this.setNodeError(templatePath, firstError);
		} else {
			this.setNodeReady(templatePath, successes);
		}
	}

	private effectiveStalePolicy(
		node: FlatNode,
		graphStalePolicy: StalePolicy,
	): StalePolicy {
		return node.config?.stalePolicy ?? graphStalePolicy;
	}

	private isStale(version: number): boolean {
		return version !== this.version;
	}

	private retryLatest(runId: number): Promise<DeepPartial<Root>> {
		if (this.latestRunId !== runId && this.latestRunPromise) {
			return this.latestRunPromise;
		}

		return this.compute({} as ComputeInput<Root>);
	}

	private setNodePending(key: string): void {
		this.nodeStatus.set(key, "pending");
		this.nodeSnap.set(key, { status: "pending" });
	}

	private setNodeReady(key: string, value: unknown): void {
		this.nodeStatus.set(key, "ready");
		this.nodeSnap.set(key, { status: "ready", value });
	}

	private setNodeError(key: string, error: unknown): void {
		this.nodeStatus.set(key, "error");
		this.nodeSnap.set(key, { status: "error", error });
	}

	private markRemainingStale(fromKey: string): void {
		let found = false;
		for (const key of this.order) {
			if (key === fromKey) found = true;
			if (found && this.nodeStatus.get(key) === "pending") {
				const prev = this.nodeSnap.get(key);
				const value = prev && "value" in prev ? prev.value : undefined;
				this.nodeStatus.set(key, "stale");
				this.nodeSnap.set(
					key,
					value !== undefined
						? { status: "stale", value }
						: { status: "pending" },
				);
			}
		}
	}
}

export { ComputeGraph };
