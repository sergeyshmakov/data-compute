import { BatchCoordinator } from "../batch/coordinator.js";
import {
	buildWildcardPrefixes,
	pathDependencies,
	topoSort,
} from "../dag/index.js";
import { resolveAccessor } from "../tracking/accessor.js";
import { enumeratedPaths } from "../tracking/enumeration.js";
import { readonlyTrackedSnapshot } from "../tracking/readonly-snapshot.js";
import type {
	BatchDataSourceConfig,
	ComputeInput,
	DataSourceMap,
	DeepFormulaMap,
	DeepPartial,
	Graph,
	GraphError,
	GraphOptions,
	NodeAccessor,
	NodeSnapshot,
	NodeStatus,
	RequestDataSourceConfig,
	StalePolicy,
	TraceStep,
} from "../types.js";
import {
	buildDepsMap,
	buildReverseDepsMap,
	containerDescendants,
} from "./deps-maps.js";
import { type FlatNode, flattenGraph } from "./flatten.js";
import {
	deleteByPath,
	expandRuntimePaths,
	getByPath,
	setByPath,
} from "./path-utils.js";
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
			readonly shouldRetry: boolean;
	  }
	| {
			readonly status: "error";
			readonly runtimePath: string;
			readonly cause: unknown;
	  };

interface ExecutionResult {
	readonly result: unknown;
	readonly shouldRetry: boolean;
}

/**
 * Per-run topology state, threaded through a run instead of stored on the graph
 * so overlapping (superseded) runs never corrupt each other's ordering.
 * `working` maps each node to the deps it actually read this run (seeded from
 * the static superset for nodes that haven't run yet); `ran` is the set of
 * nodes that have recorded their real reads this run.
 */
interface RunTopology {
	readonly working: Map<string, Set<string>>;
	readonly ran: Set<string>;
}

function cloneDeps(deps: Map<string, Set<string>>): Map<string, Set<string>> {
	return new Map([...deps].map(([key, set]) => [key, new Set(set)]));
}

function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
	if (a.size !== b.size) return false;
	for (const value of a) if (!b.has(value)) return false;
	return true;
}

type StaleAction<Root> =
	| { readonly status: "fresh" }
	| { readonly status: "stale" }
	| {
			readonly status: "retry";
			readonly promise: Promise<DeepPartial<Root>>;
	  };

type CommitResult<Root> =
	| { readonly status: "applied" }
	| Exclude<StaleAction<Root>, { readonly status: "fresh" }>;

class RuntimeDependencyCycleError extends Error {
	constructor() {
		super("Cyclic dependency detected.");
	}
}

class ComputeGraph<Root> implements Graph<Root> {
	readonly computedKeys: readonly string[];
	readonly nodes: readonly string[];

	private _sourceKeys: string[] = [];
	private _order: readonly string[];
	private _hasCycle: boolean;

	// Static (dry-run) deps, frozen at construction. Each run seeds its working
	// topology from here so cross-run discoveries never accumulate into a false
	// cycle across mutually-exclusive branches.
	private readonly staticDeps: Map<string, Set<string>>;
	// Accumulated discovered deps — the superset surfaced by introspection
	// (deps/dependents/toMermaid/trace). Not used for per-run ordering.
	private depsMap: Map<string, Set<string>>;
	private reverseMap: Map<string, Set<string>>;
	private readonly flatNodes: FlatNode[];
	private readonly flatNodeByPath: ReadonlyMap<string, FlatNode>;
	private readonly wildcardPrefixes: ReadonlySet<string>;

	// Coordinators of in-flight runs, aborted when a newer compute() supersedes
	// them so their pending batch queries can cancel via the AbortSignal.
	private readonly liveCoordinators = new Set<BatchCoordinator>();

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

		// A root-level formula/data source flattens to an empty node path, which
		// would be committed under a "" key rather than as the root value. The
		// graph models named fields, so reject this up front with a clear message.
		if (this.flatNodes.some((node) => node.path === "")) {
			throw new Error(
				"Root-level formulas and data sources are not supported; wrap them in a named field.",
			);
		}

		// A path must have exactly one producer. If the same path is defined by
		// both a formula and a data source, the Map below would silently keep only
		// the last-flattened one, making the result depend on argument order.
		const seenPaths = new Set<string>();
		for (const node of this.flatNodes) {
			if (seenPaths.has(node.path)) {
				throw new Error(
					`Duplicate producer for "${node.path}": a node path may be defined by only one formula or data source.`,
				);
			}
			seenPaths.add(node.path);
		}

		this.flatNodeByPath = new Map(
			this.flatNodes.map((node) => [node.path, node]),
		);

		// Static dependency extraction
		this.staticDeps = buildDepsMap(this.flatNodes);
		this.depsMap = cloneDeps(this.staticDeps);
		this.reverseMap = buildReverseDepsMap(this.depsMap);

		const allPaths = this.flatNodes.map((n) => n.path);
		this.wildcardPrefixes = buildWildcardPrefixes(allPaths);
		const { order, hasCycle } = topoSort(allPaths, this.depsMap);
		this._hasCycle = hasCycle;

		if (hasCycle) {
			throw new Error("Cyclic dependency detected.");
		}

		this._order = order;
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

	get order(): readonly string[] {
		return this._order;
	}

	get hasCycle(): boolean {
		return this._hasCycle;
	}

	compute(input: ComputeInput<Root>): Promise<DeepPartial<Root>> {
		this.version++;
		// Any run still in flight is now superseded; abort its pending batch
		// queries so signal-aware data sources can cancel instead of running to
		// completion (their results would be discarded anyway).
		for (const coordinator of this.liveCoordinators) {
			coordinator.abort();
		}
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

	/**
	 * Removes computed-node values from the output patch seed. Computed fields
	 * are produced by the graph; a value a caller happened to pass for one must
	 * not survive in the returned patch (or setState) when its node errors, is
	 * skipped, or is discarded as stale. Only the output patch is stripped — the
	 * working state keeps the input, since a node may read its own input (e.g. a
	 * scalar `each` maps `item` to a new value at the same path).
	 */
	private stripComputedFromOutput(patch: Record<string, unknown>): void {
		for (const key of this.computedKeys) {
			for (const { runtimePath } of expandRuntimePaths(key, patch)) {
				deleteByPath(patch, runtimePath);
			}
		}
	}

	private async flushCompute(runId: number): Promise<DeepPartial<Root>> {
		const currentVersion = this.version;
		const graphStalePolicy = this.options.stalePolicy ?? "discard";

		// Coalesce all patches into a single patch
		const inputPatch = this.pendingPatches.reduce(
			(acc, patch) => mergeDeepPartial(acc, patch),
			// biome-ignore lint/suspicious/noExplicitAny: dynamic value traversal
			{} as any,
		);
		this.pendingPatches = [];
		if (this.computePromise === this.latestRunPromise) {
			this.computePromise = null;
		}

		// Fetch full state if provided, otherwise assume granularPatch is the base
		const baseState = this.options.getState?.() ?? inputPatch;

		// Populate source keys lazily
		if (this._sourceKeys.length === 0) {
			const initialState = mergeDeepPartial<Record<string, unknown>>(
				cloneForCompute(baseState),
				inputPatch,
			);
			const computedSet = new Set(this.computedKeys);
			this._sourceKeys = Object.keys(initialState).filter(
				(k) => !computedSet.has(k),
			);
		}

		// Each retry discovers at least one new computed-dependency edge, and the
		// number of such edges is bounded by n*(n-1), so allow that many retries
		// before declaring the graph unable to converge.
		const nodeCount = this.computedKeys.length;
		const maxRuntimeDependencyRetries = Math.max(
			1,
			nodeCount * (nodeCount - 1),
		);
		const runCoordinators = new Set<BatchCoordinator>();
		try {
			return await this.runAttempts(
				runId,
				currentVersion,
				graphStalePolicy,
				inputPatch,
				baseState,
				maxRuntimeDependencyRetries,
				runCoordinators,
			);
		} finally {
			// This run has finished; its coordinators can no longer be superseded.
			for (const coordinator of runCoordinators) {
				this.liveCoordinators.delete(coordinator);
			}
		}
	}

	private async runAttempts(
		runId: number,
		currentVersion: number,
		graphStalePolicy: StalePolicy,
		inputPatch: Record<string, unknown>,
		baseState: unknown,
		maxRuntimeDependencyRetries: number,
		runCoordinators: Set<BatchCoordinator>,
	): Promise<DeepPartial<Root>> {
		let runtimeDependencyRetries = 0;
		// Per-run topology, seeded from the static superset. Persists across this
		// run's attempts (so reads discovered on attempt N inform attempt N+1) but
		// never leaks into another run. Reset the shared order to the static order
		// so this run's first attempt doesn't inherit a prior run's branch order.
		const topo: RunTopology = {
			working: cloneDeps(this.staticDeps),
			ran: new Set<string>(),
		};
		this._order = topoSort([...this.computedKeys], topo.working).order;
		while (true) {
			let shouldRetryForRuntimeDeps = false;
			// Effective stale policy of the node that triggered a runtime-dependency
			// retry, used if that retry turns out to be stale.
			let retryStalePolicy: StalePolicy = graphStalePolicy;
			let stoppedForStale = false;
			const granularPatch = cloneForCompute(inputPatch) as Record<
				string,
				unknown
			>;

			// Create the current full state to use for formulas
			const state = mergeDeepPartial<Record<string, unknown>>(
				cloneForCompute(baseState),
				granularPatch,
			);

			// The working state keeps the full input; the output patch drops any
			// caller-supplied computed values so only produced ones are returned.
			this.stripComputedFromOutput(granularPatch);

			const batchCoordinator = new BatchCoordinator();
			this.liveCoordinators.add(batchCoordinator);
			runCoordinators.add(batchCoordinator);
			const attemptOrder = [...this.order];
			const attemptIndex = new Map(
				attemptOrder.map((path, index) => [path, index]),
			);
			const stopForStale = (
				action: CommitResult<Root> | StaleAction<Root>,
			): Promise<DeepPartial<Root>> | "stale" | undefined => {
				if (action.status === "retry") return action.promise;
				if (action.status === "stale") {
					stoppedForStale = true;
					return "stale";
				}
			};

			for (const key of attemptOrder) {
				this.setNodePending(key);
			}

			for (let orderIndex = 0; orderIndex < attemptOrder.length; orderIndex++) {
				const templatePath = attemptOrder[orderIndex];
				const node = this.flatNodeByPath.get(templatePath);
				if (!node) continue;

				const stalePolicy = this.effectiveStalePolicy(node, graphStalePolicy);
				const staleBeforeNode = stopForStale(
					this.handleStale(
						currentVersion,
						runId,
						stalePolicy,
						templatePath,
						batchCoordinator,
					),
				);
				if (staleBeforeNode) {
					if (staleBeforeNode !== "stale") return staleBeforeNode;
					break;
				}

				if (node.isEach) {
					// No template-level pre-gate: each item flows through the actual-
					// reads gate in executeNode, so an item that reads a failed dep
					// errors on its own and an unread alternate-branch dep never gates.
					const expansions = expandRuntimePaths(templatePath, state);
					const outcomes = await Promise.all(
						expansions.map(async ({ runtimePath, item, itemPath }) => {
							try {
								const execution = await this.executeNode(
									node,
									state,
									batchCoordinator,
									item,
									itemPath,
									attemptIndex,
									orderIndex,
									topo,
								);
								return {
									status: "ready",
									runtimePath,
									result: execution.result,
									shouldRetry: execution.shouldRetry,
								} as const;
							} catch (cause) {
								if (cause instanceof RuntimeDependencyCycleError) throw cause;
								return { status: "error", runtimePath, cause } as const;
							}
						}),
					);

					const staleAfterEach = stopForStale(
						this.handleStale(
							currentVersion,
							runId,
							stalePolicy,
							templatePath,
							batchCoordinator,
						),
					);
					if (staleAfterEach) {
						if (staleAfterEach !== "stale") return staleAfterEach;
						break;
					}

					if (
						outcomes.some(
							(outcome) => outcome.status === "ready" && outcome.shouldRetry,
						)
					) {
						batchCoordinator.abort();
						shouldRetryForRuntimeDeps = true;
						retryStalePolicy = stalePolicy;
						break;
					}

					const eachStatus = await this.applyEachOutcomes(
						templatePath,
						outcomes,
						state,
						granularPatch,
						currentVersion,
					);

					if (eachStatus === "stale") {
						const staleAfterInterceptors = stopForStale(
							this.handleStale(
								currentVersion,
								runId,
								stalePolicy,
								templatePath,
								batchCoordinator,
							),
						);
						if (staleAfterInterceptors && staleAfterInterceptors !== "stale")
							return staleAfterInterceptors;
						break;
					}
				} else {
					try {
						const execution = await this.executeNode(
							node,
							state,
							batchCoordinator,
							undefined,
							undefined,
							attemptIndex,
							orderIndex,
							topo,
						);

						if (execution.shouldRetry) {
							batchCoordinator.abort();
							shouldRetryForRuntimeDeps = true;
							retryStalePolicy = stalePolicy;
							break;
						}

						const staleAfterExecution = stopForStale(
							this.handleStale(
								currentVersion,
								runId,
								stalePolicy,
								node.path,
								batchCoordinator,
							),
						);
						if (staleAfterExecution) {
							if (staleAfterExecution !== "stale") return staleAfterExecution;
							break;
						}

						const commit = await this.commitNodeResult(
							node.path,
							execution.result,
							state,
							granularPatch,
							currentVersion,
							runId,
							stalePolicy,
							batchCoordinator,
						);
						const commitStop = stopForStale(commit);
						if (commitStop) {
							if (commitStop !== "stale") return commitStop;
							break;
						}
					} catch (cause) {
						if (cause instanceof RuntimeDependencyCycleError) throw cause;
						const staleAfterError = stopForStale(
							this.handleStale(
								currentVersion,
								runId,
								stalePolicy,
								node.path,
								batchCoordinator,
							),
						);
						if (staleAfterError) {
							if (staleAfterError !== "stale") return staleAfterError;
							break;
						}
						this.setNodeError(node.path, cause);
						this.options.onError?.({ key: node.path, cause });
					}
				}
			}

			if (shouldRetryForRuntimeDeps) {
				// A newer compute() may have superseded this run while it awaited an
				// async node. Re-entering the attempt loop would run setNodePending
				// over every node and clobber the fresh run's already-published
				// statuses, so honor the stale policy before retrying.
				if (this.isStale(currentVersion)) {
					const staleAction = this.handleStale(
						currentVersion,
						runId,
						retryStalePolicy,
						attemptOrder[0] ?? "",
						batchCoordinator,
					);
					if (staleAction.status === "retry") return staleAction.promise;
					return granularPatch as DeepPartial<Root>;
				}
				runtimeDependencyRetries++;
				if (runtimeDependencyRetries > maxRuntimeDependencyRetries) {
					throw new Error("Runtime dependency retry limit exceeded.");
				}
				continue;
			}

			if (!stoppedForStale && !this.isStale(currentVersion)) {
				this.options.setState?.(granularPatch as DeepPartial<Root>);
			}

			return granularPatch as DeepPartial<Root>;
		}
	}

	/**
	 * Resolves a path to the node key that actually stores state for it. Falls
	 * back to the `<path>.*` each-template so a scalar `each()` array is
	 * reachable via its natural accessor (e.g. `(x) => x.list`).
	 */
	private resolveNodeKey(path: string): string {
		if (this.flatNodeByPath.has(path)) return path;
		const wildcard = path ? `${path}.*` : "*";
		if (this.flatNodeByPath.has(wildcard)) return wildcard;
		return path;
	}

	status(path: string): NodeStatus {
		return this.nodeStatus.get(this.resolveNodeKey(path)) ?? "pending";
	}

	computeStatus<T>(accessor: NodeAccessor<Root, T>): NodeStatus {
		return this.status(this.resolveAccessorKey(accessor));
	}

	snapshot<T = unknown>(path: string): NodeSnapshot<T> {
		return (this.nodeSnap.get(this.resolveNodeKey(path)) ?? {
			status: "pending",
		}) as NodeSnapshot<T>;
	}

	computeSnapshot<T>(accessor: NodeAccessor<Root, T>): NodeSnapshot<T> {
		return this.snapshot<T>(this.resolveAccessorKey(accessor));
	}

	computeResult<T>(accessor: NodeAccessor<Root, T>): {
		readonly value: T | undefined;
		readonly status: NodeStatus;
	} {
		const snap = this.snapshot<T>(this.resolveAccessorKey(accessor));
		return {
			value: "value" in snap ? snap.value : undefined,
			status: snap.status,
		};
	}

	deps<T>(accessor: NodeAccessor<Root, T>): readonly string[] {
		const key = this.resolveNodeKey(this.resolveAccessorKey(accessor));
		const d = this.depsMap.get(key);
		return d ? [...d] : [];
	}

	dependents<T>(accessor: NodeAccessor<Root, T>): readonly string[] {
		const key = this.resolveNodeKey(this.resolveAccessorKey(accessor));
		const d = this.reverseMap.get(key);
		return d ? [...d] : [];
	}

	private resolveAccessorKey<T>(accessor: NodeAccessor<Root, T>): string {
		return resolveAccessor(accessor, this.wildcardPrefixes) as string;
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
				// trace() is synchronous and does not await async nodes; swallow any
				// eventual rejection so tracing a rejecting formula cannot surface
				// as an unhandled rejection.
				Promise.resolve(result as PromiseLike<unknown>).catch(() => {});
				steps.push({
					node: path,
					deps: depValues,
					result: "[async]",
					ms,
				});
			} else {
				setByPath(state, path, result, this.wildcardPrefixes);
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
		itemPath: string | undefined,
		attemptIndex: ReadonlyMap<string, number>,
		orderIndex: number,
		topo: RunTopology,
	): Promise<ExecutionResult> {
		const accessed = new Set<string>();
		const rootSnapshot = cloneForCompute(state);
		const snapshotCache = new WeakMap<object, Map<string, unknown>>();
		const rootState = readonlyTrackedSnapshot(
			rootSnapshot,
			accessed,
			"",
			snapshotCache,
		);
		const localState = node.isEach
			? readonlyTrackedSnapshot(
					cloneForCompute(item),
					accessed,
					itemPath ?? "",
					snapshotCache,
				)
			: rootState;

		if (node.type === "formula") {
			// A formula reads its inputs throughout its (possibly async) body, so
			// dependencies can only be finalized after it settles.
			let didThrow = false;
			let caught: unknown;
			let result: unknown;
			try {
				result = await node.fn(localState, rootState);
				// Materialize the result before recording dependencies. If the
				// formula returned a snapshot object directly (e.g. `f.nested`), this
				// deep-clone deproxies it — so no readonly tracking proxy leaks into
				// state/output — and, by reading through the returned container, it
				// records dependencies on any computed children it aliases.
				result = cloneForCompute(result);
			} catch (cause) {
				didThrow = true;
				caught = cause;
			}
			const shouldRetry = this.recordRuntimeDependencies(
				node,
				accessed,
				attemptIndex,
				orderIndex,
				topo,
			);
			if (!shouldRetry) {
				// Gate on the deps ACTUALLY read this run, not the accumulated
				// superset, so an alternate-branch dependency that errored but was
				// not read this run cannot suppress this node's valid output. Prefer
				// the dependency error over the formula's own throw (which may be a
				// downstream symptom of reading the failed dep's stale value).
				const depError = this.dependencyErrorFrom(
					node.path,
					this.actualDeps(node, accessed),
				);
				if (depError) throw depError;
			}
			if (didThrow && !shouldRetry) throw caught;
			return { result, shouldRetry };
		}

		// Data source: the deps function builds the request synchronously, so all
		// state reads happen now. Record dependencies and decide on a retry BEFORE
		// issuing the query — otherwise a runtime-discovered dependency would fire
		// a query built from stale/undefined inputs and only retry after it (and
		// any backend side effect) settled.
		let request: unknown;
		let requestThrew = false;
		let requestError: unknown;
		try {
			request = node.fn(localState, rootState);
			// Materialize before recording dependencies (same reasoning as formula
			// results above): if the deps function returned a snapshot container
			// directly (e.g. `f.filters`), cloning deproxies it — so the query
			// receives a plain request object, not a readonly tracking proxy — and
			// reading through the container records dependencies on any computed
			// children it aliases (so a listed-before child triggers a retry).
			request = cloneForCompute(request);
		} catch (cause) {
			requestThrew = true;
			requestError = cause;
		}

		const shouldRetry = this.recordRuntimeDependencies(
			node,
			accessed,
			attemptIndex,
			orderIndex,
			topo,
		);
		if (shouldRetry) return { result: undefined, shouldRetry: true };
		if (requestThrew) throw requestError;
		// Gate on the deps actually read while building the request, before
		// issuing the query — a failed dependency must not fire a network call on
		// garbage inputs, and an unread alternate-branch dep must not gate at all.
		const depError = this.dependencyErrorFrom(
			node.path,
			this.actualDeps(node, accessed),
		);
		if (depError) throw depError;

		let result: unknown;
		if (node.type === "batch" && node.config) {
			result = await batchCoordinator.submit(
				node.config as BatchDataSourceConfig<unknown, unknown>,
				request,
			);
		} else if (node.type === "request" && node.config) {
			result = await (
				node.config as RequestDataSourceConfig<unknown, unknown>
			).query(request);
		}
		return { result, shouldRetry: false };
	}

	/**
	 * The dependency nodes a node actually read on this run, derived from its
	 * tracked accesses. Branch-aware: reflects the branch taken this run, unlike
	 * the accumulated `depsMap` superset.
	 */
	private actualDeps(node: FlatNode, accessed: Set<string>): Set<string> {
		const deps = pathDependencies(accessed, node.path, this.wildcardPrefixes);
		// Mirror the build-time container expansion: a container read discovered
		// only at runtime (e.g. an async formula that awaits, then spreads
		// f.nested) must still depend on computed descendants so it reorders and
		// retries instead of committing stale/empty container data.
		for (const descendant of containerDescendants(
			enumeratedPaths(accessed),
			node.path,
			this.computedKeys,
			this.wildcardPrefixes,
		)) {
			deps.add(descendant);
		}
		return deps;
	}

	private recordRuntimeDependencies(
		node: FlatNode,
		accessed: Set<string>,
		attemptIndex: ReadonlyMap<string, number>,
		orderIndex: number,
		topo: RunTopology,
	): boolean {
		const actual = this.actualDeps(node, accessed);

		// Introspection: accumulate the discovered superset (deps/dependents/…).
		const introCurrent = this.depsMap.get(node.path) ?? new Set<string>();
		let introChanged = false;
		for (const dep of actual) {
			if (!introCurrent.has(dep)) {
				introChanged = true;
				break;
			}
		}
		if (introChanged) {
			this.depsMap.set(node.path, new Set([...introCurrent, ...actual]));
			this.reverseMap = buildReverseDepsMap(this.depsMap);
		}

		// Execution topology: record what this node actually read this run
		// (branch-aware), then re-sort. Unlike the accumulated map, this never
		// unions mutually-exclusive branches into a false cycle.
		const wasRan = topo.ran.has(node.path);
		const prevWorking = topo.working.get(node.path) ?? new Set<string>();
		// Non-each nodes replace their edges with this run's reads. An each
		// template runs once per item under one node.path: the first item this run
		// replaces the static seed, later items union, so the template's edges
		// reflect every producer any item read — not just the last item to finish.
		const nextWorking =
			node.isEach && wasRan ? new Set([...prevWorking, ...actual]) : actual;
		topo.working.set(node.path, nextWorking);
		topo.ran.add(node.path);
		// Re-sort when the edges changed, or when this node's reads are newly
		// confirmed: entering `ran` changes which edges the cycle check treats as
		// confirmed, so a freshly-formed confirmed cycle is surfaced right away.
		if (!wasRan || !sameSet(prevWorking, nextWorking)) {
			this.refreshRunTopology(topo);
		}

		// Retry if a computed dep was read before it was produced this run. Errored
		// deps are not retried here — the actual-reads gate raises the dependency
		// error once ordering has settled.
		for (const dep of actual) {
			if (!this.flatNodeByPath.has(dep)) continue;
			const depIndex = attemptIndex.get(dep);
			if (depIndex === undefined || depIndex > orderIndex) return true;
		}
		return false;
	}

	private refreshRunTopology(topo: RunTopology): void {
		let { order, hasCycle } = topoSort([...this.computedKeys], topo.working);
		if (hasCycle) {
			// A cycle in the working map may be a false union of mutually-exclusive
			// branches: edges from nodes that haven't run this run are still the
			// static superset and may belong to an untaken branch. Drop those and
			// re-sort. A cycle that survives among confirmed (already-run) edges is
			// a genuine runtime cycle.
			const confirmed = new Map<string, Set<string>>();
			for (const key of this.computedKeys) {
				confirmed.set(
					key,
					topo.ran.has(key)
						? (topo.working.get(key) ?? new Set<string>())
						: new Set<string>(),
				);
			}
			({ order, hasCycle } = topoSort([...this.computedKeys], confirmed));
			if (hasCycle) throw new RuntimeDependencyCycleError();
		}
		this._order = order;
	}

	private handleStale(
		version: number,
		runId: number,
		stalePolicy: StalePolicy,
		fromPath: string,
		batchCoordinator: BatchCoordinator,
	): StaleAction<Root> {
		if (!this.isStale(version)) return { status: "fresh" };

		batchCoordinator.abort();
		if (stalePolicy === "discard-and-retry") {
			return { status: "retry", promise: this.retryLatest(runId) };
		}

		this.markRemainingStale(fromPath);
		return { status: "stale" };
	}

	private async commitNodeResult(
		nodePath: string,
		result: unknown,
		state: Record<string, unknown>,
		granularPatch: Record<string, unknown>,
		version: number,
		runId: number,
		stalePolicy: StalePolicy,
		batchCoordinator: BatchCoordinator,
	): Promise<CommitResult<Root>> {
		const interceptedResult = await this.applyInterceptors(
			nodePath,
			result,
			state,
		);
		const staleAction = this.handleStale(
			version,
			runId,
			stalePolicy,
			nodePath,
			batchCoordinator,
		);
		if (staleAction.status !== "fresh") return staleAction;

		setByPath(state, nodePath, interceptedResult, this.wildcardPrefixes);
		setByPath(
			granularPatch,
			nodePath,
			interceptedResult,
			this.wildcardPrefixes,
		);
		this.setNodeReady(nodePath, interceptedResult);
		return { status: "applied" };
	}

	private applyInterceptors(
		nodePath: string,
		value: unknown,
		state: Record<string, unknown>,
	): unknown {
		const interceptors = this.options.interceptors;
		if (!interceptors?.length) return value;

		const snapshot = deepFreezeSnapshot(
			cloneForCompute(state),
		) as Readonly<Root>;
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
		version: number,
	): Promise<"applied" | "stale"> {
		const successes: unknown[] = [];
		const readyOutcomes: { runtimePath: string; result: unknown }[] = [];
		const errors: GraphError[] = [];
		let firstError: unknown;

		for (const outcome of outcomes) {
			if (outcome.status === "ready") {
				try {
					const interceptedResult = await this.applyInterceptors(
						outcome.runtimePath,
						outcome.result,
						state,
					);
					if (this.isStale(version)) return "stale";
					successes.push(interceptedResult);
					readyOutcomes.push({
						runtimePath: outcome.runtimePath,
						result: interceptedResult,
					});
				} catch (cause) {
					if (this.isStale(version)) return "stale";
					if (firstError === undefined) firstError = cause;
					errors.push({ key: outcome.runtimePath, cause });
				}
			} else {
				if (firstError === undefined) firstError = outcome.cause;
				errors.push({ key: outcome.runtimePath, cause: outcome.cause });
			}
		}

		// Only surface results and errors once the run is confirmed fresh, so a
		// superseded run never fires onError or commits partial results.
		if (this.isStale(version)) return "stale";

		for (const error of errors) {
			this.options.onError?.(error);
		}

		for (const outcome of readyOutcomes) {
			setByPath(
				state,
				outcome.runtimePath,
				outcome.result,
				this.wildcardPrefixes,
			);
			setByPath(
				granularPatch,
				outcome.runtimePath,
				outcome.result,
				this.wildcardPrefixes,
			);
		}

		if (firstError !== undefined) {
			this.setNodeError(templatePath, firstError);
		} else {
			this.setNodeReady(templatePath, successes);
		}

		return "applied";
	}

	private dependencyErrorFrom(
		path: string,
		deps: Iterable<string>,
	): Error | undefined {
		for (const dep of deps) {
			if (!this.flatNodeByPath.has(dep)) continue;
			const snap = this.nodeSnap.get(dep);
			if (snap?.status !== "error") continue;

			const error = new Error(
				`Dependency "${dep}" failed before "${path}" could run.`,
			);
			Object.defineProperty(error, "cause", {
				value: snap.error,
				configurable: true,
			});
			return error;
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
				// "stale" means a prior result was invalidated, so it must carry that
				// value. A node with no prior value stays "pending" — keeping status
				// and snapshot consistent (a stale snapshot always has a value).
				if (value !== undefined) {
					this.nodeStatus.set(key, "stale");
					this.nodeSnap.set(key, { status: "stale", value });
				}
			}
		}
	}
}

export { ComputeGraph };
