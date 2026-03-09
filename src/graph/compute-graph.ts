import { BatchCoordinator } from "../batch/coordinator";
import { topoSort } from "../dag";
import { resolveAccessor } from "../tracking/accessor";
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
	TraceStep,
} from "../types";
import { buildDepsMap, buildReverseDepsMap } from "./deps-maps";
import { type FlatNode, flattenGraph } from "./flatten";

function isPlainObject(item: unknown): item is Record<string, unknown> {
	return (
		item !== null &&
		typeof item === "object" &&
		!Array.isArray(item) &&
		!(item instanceof Date) &&
		!(item instanceof Set) &&
		!(item instanceof Map)
	);
}

function deepMerge<T>(target: unknown, source: unknown): T {
	if (!isPlainObject(target) || !isPlainObject(source)) {
		return source as T;
	}

	const output = { ...target };
	for (const key of Object.keys(source)) {
		if (isPlainObject(source[key])) {
			if (!(key in target)) {
				output[key] = source[key];
			} else {
				output[key] = deepMerge(target[key], source[key]);
			}
		} else {
			output[key] = source[key];
		}
	}
	return output as T;
}

function getByPath(obj: unknown, path: string): unknown {
	const parts = path.split(".");
	let curr: unknown = obj;
	for (const p of parts) {
		if (curr === null || curr === undefined) return undefined;
		curr = (curr as Record<string, unknown>)[p];
	}
	return curr;
}

function setByPath(
	obj: Record<string, unknown>,
	path: string,
	value: unknown,
): void {
	const parts = path.split(".");
	let curr: Record<string, unknown> = obj;
	for (let i = 0; i < parts.length - 1; i++) {
		const p = parts[i];
		if (curr[p] === undefined || curr[p] === null) {
			curr[p] = /^\d+$/.test(parts[i + 1]) ? [] : {};
		}
		curr = curr[p] as Record<string, unknown>;
	}
	curr[parts[parts.length - 1]] = value;
}

class ComputeGraph<Root> implements Graph<Root> {
	readonly computedKeys: readonly string[];
	readonly nodes: readonly string[];
	readonly order: readonly string[];
	readonly hasCycle: boolean;

	private _sourceKeys: string[] = [];

	private readonly depsMap: ReadonlyMap<string, ReadonlySet<string>>;
	private readonly reverseMap: ReadonlyMap<string, ReadonlySet<string>>;
	private readonly flatNodes: FlatNode[];

	// Runtime node state
	private readonly nodeStatus = new Map<string, NodeStatus>();
	private readonly nodeSnap = new Map<string, NodeSnapshot<unknown>>();

	// Versioning for stale detection
	private version = 0;

	// Microtask batching state
	private pendingPatches: DeepPartial<Root>[] = [];
	private computePromise: Promise<DeepPartial<Root>> | null = null;

	constructor(
		formulas: DeepFormulaMap<Root, Root, Root>,
		dataSources?: DataSourceMap<Root, Root, Root>,
		private readonly options: GraphOptions<Root> = {},
	) {
		this.flatNodes = flattenGraph(formulas, dataSources);

		// Static dependency extraction
		this.depsMap = buildDepsMap(this.flatNodes);
		this.reverseMap = buildReverseDepsMap(this.depsMap);

		const allPaths = this.flatNodes.map((n) => n.path);
		const { order, hasCycle } = topoSort(allPaths, this.depsMap);
		this.hasCycle = hasCycle;

		if (hasCycle && (options.cyclic ?? "error") === "error") {
			throw new Error(
				"Cyclic dependency detected. Use { cyclic: 'freeze' } to allow cycles with frozen values.",
			);
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
			this.computePromise = Promise.resolve().then(() => this.flushCompute());
		}

		return this.computePromise;
	}

	private async flushCompute(): Promise<DeepPartial<Root>> {
		const currentVersion = this.version;
		const stalePolicy = this.options.stalePolicy ?? "discard";

		// Coalesce all patches into a single patch
		const granularPatch = this.pendingPatches.reduce(
			(acc, patch) => deepMerge(acc, patch),
			// biome-ignore lint/suspicious/noExplicitAny: dynamic value traversal
			{} as any,
		);
		this.pendingPatches = [];
		this.computePromise = null;

		// Fetch full state if provided, otherwise assume granularPatch is the base
		const baseState = this.options.getState?.() ?? granularPatch;

		// Create the current full state to use for formulas
		const state = deepMerge<Record<string, unknown>>(
			JSON.parse(JSON.stringify(baseState)),
			granularPatch,
		);

		const batchCoordinator = new BatchCoordinator();

		// Populate source keys lazily
		if (this._sourceKeys.length === 0) {
			const computedSet = new Set(this.order);
			this._sourceKeys = Object.keys(state).filter((k) => !computedSet.has(k));
		}

		for (const key of this.order) {
			this.setNodePending(key);
		}

		for (const templatePath of this.order) {
			if (this.isStale(currentVersion)) {
				batchCoordinator.abort();
				if (stalePolicy === "discard-and-retry")
					return this.compute(granularPatch as ComputeInput<Root>);
				this.markRemainingStale(templatePath);
				break;
			}

			const node = this.flatNodes.find((n) => n.path === templatePath);
			if (!node) continue;

			// If it's an each node, we need to iterate runtime arrays
			if (node.isEach) {
				const parts = node.path.split(".");
				const parentTemplatePath = parts.slice(0, -1).join(".");
				const leafProp = parts[parts.length - 1];

				// We need to find all actual arrays matching the parentTemplatePath in the state
				// For simplicity, we assume single-level wildcards like "items.*.tax"
				const arrayPath = parentTemplatePath.replace(".*", "");
				const arr = getByPath(state, arrayPath);

				if (Array.isArray(arr)) {
					const promises = arr.map(async (item, i) => {
						const frozenState = Object.freeze({ ...state });
						const frozenItem = Object.freeze({ ...item });
						const runtimePath = `${arrayPath}.${i}.${leafProp}`;

						try {
							// biome-ignore lint/suspicious/noExplicitAny: dynamic value traversal
							let result: any;
							if (node.type === "formula") {
								result = await node.fn(frozenItem, frozenState);
							} else if (node.type === "batch" && node.config) {
								const req = node.fn(frozenItem, frozenState);
								result = await batchCoordinator.submit(
									node.config as BatchDataSourceConfig<unknown, unknown>,
									req,
								);
							} else if (node.type === "request" && node.config) {
								const req = node.fn(frozenItem, frozenState);
								result = await (
									node.config as RequestDataSourceConfig<unknown, unknown>
								).query(req);
							}

							if (this.isStale(currentVersion)) {
								batchCoordinator.abort();
								// Cannot easily break a map loop, but we can prevent mutation
								return;
							}

							setByPath(state, runtimePath, result);
							setByPath(granularPatch, runtimePath, result);
							this.setNodeReady(templatePath, result);
						} catch (cause) {
							this.setNodeError(templatePath, cause);
							this.options.onError?.({ key: runtimePath, cause });
						}
					});

					await Promise.all(promises);
				}
			} else {
				// Normal flat node
				const frozenState = Object.freeze({ ...state });

				try {
					// biome-ignore lint/suspicious/noExplicitAny: dynamic value traversal
					let result: any;
					if (node.type === "formula") {
						result = await node.fn(frozenState, frozenState);
					} else if (node.type === "batch" && node.config) {
						const req = node.fn(frozenState, frozenState);
						result = await batchCoordinator.submit(
							node.config as BatchDataSourceConfig<unknown, unknown>,
							req,
						);
					} else if (node.type === "request" && node.config) {
						const req = node.fn(frozenState, frozenState);
						result = await (
							node.config as RequestDataSourceConfig<unknown, unknown>
						).query(req);
					}

					if (this.isStale(currentVersion)) {
						batchCoordinator.abort();
						if (stalePolicy === "discard-and-retry")
							return this.compute(granularPatch as ComputeInput<Root>);
						this.markRemainingStale(node.path);
						break;
					}

					setByPath(state, node.path, result);
					setByPath(granularPatch, node.path, result);
					this.setNodeReady(node.path, result);
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
		const state: Record<string, unknown> = {
			...(input as Record<string, unknown>),
		};
		const steps: TraceStep[] = [];

		for (const path of this.order) {
			const node = this.flatNodes.find((n) => n.path === path);
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

	private isStale(version: number): boolean {
		return version !== this.version;
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
