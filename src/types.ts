/** A value that may be synchronous or asynchronous. */
export type Awaitable<T> = T | Promise<T>;

/** Flattens intersection types for better IntelliSense. */
export type Simplify<T> = {
	[K in keyof T]: T[K];
} & {};

/** A single entry in a batch query, identified by id for response matching. */
export interface BatchEntry<Request> {
	readonly id: string;
	readonly request: Request;
}

/** Successful outcome for a batch entry. */
export interface BatchSuccess<Response> {
	readonly id: string;
	readonly response: Response;
}

/** Failed outcome for a batch entry. */
export interface BatchFailure {
	readonly id: string;
	readonly error: unknown;
}

/** Result of a batch entry — either success or failure. */
export type BatchOutcome<Response> = BatchSuccess<Response> | BatchFailure;

/** Metadata passed to BatchHandler.query (e.g. AbortSignal for cancellation). */
export interface BatchQueryMeta {
	readonly signal: AbortSignal;
}

export interface BatchDataSourceConfig<Request, Response> {
	readonly query: (
		entries: readonly BatchEntry<Request>[],
		meta: BatchQueryMeta,
	) => Promise<readonly BatchOutcome<Response>[]>;
	readonly dedupeKey?: (request: Request) => string;
	readonly stalePolicy?: StalePolicy;
}

export interface BatchDataSourceNode<State, Root, Request, Response> {
	readonly __isDataSource: true;
	readonly type: "batch";
	readonly deps: (state: Readonly<State>, root: Readonly<Root>) => Request;
	readonly config: BatchDataSourceConfig<Request, Response>;
}

export interface RequestDataSourceConfig<Request, Response> {
	readonly query: (request: Request) => Promise<Response>;
	readonly dedupeKey?: (request: Request) => string;
	readonly stalePolicy?: StalePolicy;
}

export interface RequestDataSourceNode<State, Root, Request, Response> {
	readonly __isDataSource: true;
	readonly type: "request";
	readonly deps: (state: Readonly<State>, root: Readonly<Root>) => Request;
	readonly config: RequestDataSourceConfig<Request, Response>;
}

/**
 * Data source node for resolving data asynchronously.
 * Request is `any` because the union must accept nodes with specific Request types
 * (config is invariant in Request).
 */
export type DataSourceNode<State, Root, Response> =
	| BatchDataSourceNode<State, Root, any, Response>
	| RequestDataSourceNode<State, Root, any, Response>;

/**
 * Formula function for a computed node. Receives state.
 *
 * @param state - Immutable snapshot of current context (Root or Item).
 * @param root - Immutable snapshot of Root as of formula evaluation start.
 */
export type Formula<State, Root, T> = (
	state: Readonly<State>,
	root: Readonly<Root>,
) => Awaitable<T>;

/** Marker interface for arrays mapped via each() */
export interface EachNode<_State, Root, ItemState> {
	readonly __isEach: true;
	readonly mapping: DeepFormulaMap<ItemState, Root, ItemState>;
}

export interface EachDataSourceNode<_State, Root, ItemState> {
	readonly __isEachDataSource: true;
	readonly mapping: DataSourceMap<ItemState, Root, ItemState>;
}

/**
 * Deep formula map mapping Target's shape to formulas.
 */
export type DeepFormulaMap<State, Root, Target> = [Target] extends [
	readonly unknown[],
]
	? EachNode<State, Root, Target[number]> | Formula<State, Root, Target>
	: [Target] extends [Date | ((...args: never[]) => unknown)]
		? Formula<State, Root, Target>
		: [Target] extends [object]
			?
					| {
							readonly [K in keyof Target]?: DeepFormulaMap<
								State,
								Root,
								Target[K]
							>;
					  }
					| Formula<State, Root, Target>
			: Formula<State, Root, Target>;

/**
 * Deep data source map mapping Target's shape to data sources.
 */
export type DataSourceMap<State, Root, Target> = [Target] extends [
	readonly unknown[],
]
	?
			| EachDataSourceNode<State, Root, Target[number]>
			| DataSourceNode<State, Root, Target>
	: [Target] extends [Date | ((...args: never[]) => unknown)]
		? DataSourceNode<State, Root, Target>
		: [Target] extends [object]
			?
					| {
							readonly [K in keyof Target]?: DataSourceMap<
								State,
								Root,
								Target[K]
							>;
					  }
					| DataSourceNode<State, Root, Target>
			: DataSourceNode<State, Root, Target>;

/** Deep partial to allow any fields to be omitted in inputs */
export type DeepPartial<T> = T extends (...args: never[]) => unknown
	? T
	: T extends Array<infer U>
		? _DeepPartialArray<U>
		: T extends object
			? _DeepPartialObject<T>
			: T | undefined;

interface _DeepPartialArray<T> extends Array<DeepPartial<T>> {}
type _DeepPartialObject<T> = { [P in keyof T]?: DeepPartial<T[P]> };

/**
 * Input to compute(). Represents current state.
 * Computed/Source keys logic is simplified to DeepPartial for deep structures.
 */
export type ComputeInput<Root> = DeepPartial<Root>;

/** Status of a computed node. */
export type NodeStatus = "ready" | "stale" | "pending" | "error";

/** Snapshot of a computed node's value and status. */
export type NodeSnapshot<Value> =
	| {
			readonly status: "ready";
			readonly value: Value;
	  }
	| {
			readonly status: "stale";
			readonly value: Value;
	  }
	| {
			readonly status: "pending";
	  }
	| {
			readonly status: "error";
			readonly error: unknown;
	  };

/** Error emitted when a node evaluation fails after runtime handling. */
export interface GraphError {
	/** Runtime node path that failed (may contain `*` for each templates). */
	readonly key: string;
	readonly cause: unknown;
}

/** How the graph behaves when async dependencies are pending. */
export type ConsistencyMode = "hold-until-ready";

/** What happens when an async response arrives after inputs have changed. */
export type StalePolicy = "discard" | "discard-and-retry";

/** How the graph handles cyclic dependencies. */
export type CyclicMode = "error";

/**
 * Interceptor for transforming or validating node values.
 */
export type Interceptor<Root> = (
	nodePath: string,
	value: unknown,
	state: Readonly<Root>,
	next: (value: unknown) => unknown,
) => unknown;

/**
 * One step in an execution trace. Used by graph.trace() for debugging.
 */
export interface TraceStep {
	readonly node: string;
	readonly deps: Record<string, unknown>;
	readonly result: unknown;
	readonly ms: number;
}

/**
 * Type-safe accessor for selecting a node.
 */
export type NodeAccessor<Root, T> = (x: Root) => T;

export interface GraphOptions<Root> {
	/**
	 * Defines how the graph behaves when async dependencies are pending.
	 */
	readonly consistency?: ConsistencyMode;
	/**
	 * Defines what happens when an async response arrives after the source
	 * inputs for that computation have already changed.
	 */
	readonly stalePolicy?: StalePolicy;
	/**
	 * How to handle cyclic dependencies. "error" (default) throws at createGraph.
	 */
	readonly cyclic?: CyclicMode;
	/**
	 * Interceptors for transforming or validating node values.
	 */
	readonly interceptors?: readonly Interceptor<Root>[];
	/**
	 * Called before a compute() evaluates to get the latest full state.
	 */
	readonly getState?: () => Root;
	/**
	 * Called when a compute() completes and the result is applied (not discarded).
	 */
	readonly setState?: (patch: DeepPartial<Root>) => void;
	/**
	 * Called when a node evaluation fails after the runtime has handled
	 * cancellation, batching, and stale response protection.
	 */
	readonly onError?: (error: GraphError) => void;
}

export interface Graph<Root> {
	/**
	 * Runs one compute cycle for the given input patch.
	 *
	 * Returns a granular patch (`DeepPartial<Root>`) containing the input fields
	 * for this cycle plus the computed outputs that actually ran. Nodes that are
	 * still pending, or discarded under the active `stalePolicy`, are omitted —
	 * the result is not a full `Root` snapshot.
	 */
	compute(input: ComputeInput<Root>): Promise<DeepPartial<Root>>;

	/**
	 * Reads the current runtime status for a computed node by path.
	 */
	status(path: string): NodeStatus;

	/**
	 * Reads the current runtime status for a computed node (accessor-based).
	 */
	computeStatus<T>(accessor: NodeAccessor<Root, T>): NodeStatus;

	/**
	 * Reads the latest stable snapshot for a computed node by path.
	 */
	snapshot<T = unknown>(path: string): NodeSnapshot<T>;

	/**
	 * Reads the latest stable snapshot for a computed node (accessor-based).
	 * Returns the full discriminated union, including the `error` branch.
	 */
	computeSnapshot<T>(accessor: NodeAccessor<Root, T>): NodeSnapshot<T>;

	/**
	 * Reads value and status together (accessor-based).
	 */
	computeResult<T>(accessor: NodeAccessor<Root, T>): {
		readonly value: T | undefined;
		readonly status: NodeStatus;
	};

	/** Computed node names (paths). Alias: nodes. */
	readonly computedKeys: readonly string[];
	readonly nodes: readonly string[];

	/** Source field names (paths). Alias: sources. */
	readonly sourceKeys: readonly string[];
	readonly sources: readonly string[];

	/** Topological execution order of computed nodes. */
	readonly order: readonly string[];
	/**
	 * Whether the graph contains a cycle. Always `false` for a successfully
	 * constructed graph — `createGraph` throws on cyclic dependencies — but
	 * exposed for introspection and forward compatibility.
	 */
	readonly hasCycle: boolean;

	/**
	 * Returns direct dependencies of the node selected by the accessor.
	 */
	deps<T>(accessor: NodeAccessor<Root, T>): readonly string[];

	/**
	 * Returns nodes that depend on the field selected by the accessor.
	 */
	dependents<T>(accessor: NodeAccessor<Root, T>): readonly string[];

	/**
	 * Exports the graph as Mermaid diagram source (for mermaid.live).
	 */
	toMermaid(): string;

	/**
	 * Traces execution for the given input. Returns per-node timing and results.
	 */
	trace(input: ComputeInput<Root>): readonly TraceStep[];
}

/**
 * Builder returned by createGraph<Root>() when called with no arguments.
 */
export type CreateGraphBuilder<Root> = (
	formulas: DeepFormulaMap<Root, Root, Root>,
	dataSources?: DataSourceMap<Root, Root, Root>,
	options?: GraphOptions<Root>,
) => Graph<Root>;

/**
 * Creates a computation graph.
 */
export interface CreateGraph {
	<Root>(
		formulas: DeepFormulaMap<Root, Root, Root>,
		dataSources?: DataSourceMap<Root, Root, Root>,
		options?: GraphOptions<Root>,
	): Graph<Root>;

	<Root>(): CreateGraphBuilder<Root>;
}

export function each<State, Root, ItemState>(
	mapping: DeepFormulaMap<ItemState, Root, ItemState>,
): EachNode<State, Root, ItemState> {
	return { __isEach: true, mapping };
}

export function eachDataSource<State, Root, ItemState>(
	mapping: DataSourceMap<ItemState, Root, ItemState>,
): EachDataSourceNode<State, Root, ItemState> {
	return { __isEachDataSource: true, mapping };
}

export function batchRequest<State, Root, Request, Response>(
	deps: (state: Readonly<State>, root: Readonly<Root>) => Request,
	config: BatchDataSourceConfig<Request, Response>,
): BatchDataSourceNode<State, Root, Request, Response> {
	return { __isDataSource: true, type: "batch", deps, config };
}

export function request<State, Root, Request, Response>(
	deps: (state: Readonly<State>, root: Readonly<Root>) => Request,
	config: RequestDataSourceConfig<Request, Response>,
): RequestDataSourceNode<State, Root, Request, Response> {
	return { __isDataSource: true, type: "request", deps, config };
}
