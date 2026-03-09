/** A value that may be synchronous or asynchronous. */
export type Awaitable<T> = T | Promise<T>;

/** Flattens intersection types for better IntelliSense. */
export type Simplify<T> = {
	[K in keyof T]: T[K];
} & {};

/**
 * Defines the request/response contract for a batch channel.
 * Use with BatchSchema to type batch handlers and ctx.request().
 */
export interface BatchContract<Request = unknown, Response = unknown> {
	readonly request: Request;
	readonly response: Response;
}

/** Map of channel names to their request/response contracts. */
export type BatchSchema = Record<string, BatchContract>;

/** Empty batch schema for graphs without async channels. */
export type EmptyBatchSchema = Record<never, never>;

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

/**
 * Handles batched requests for a channel. All requests coalesced in a microtask
 * are passed to query; responses must be returned in the same order as entries.
 */
export interface BatchHandler<Request, Response> {
	readonly query: (
		entries: readonly BatchEntry<Request>[],
		meta: BatchQueryMeta,
	) => Promise<readonly BatchOutcome<Response>[]>;
	/**
	 * Optional deduplication key — identical keys within a batch collapse to one
	 * request. Also applies when multiple compute() calls are coalesced in the
	 * same microtask.
	 */
	readonly dedupeKey?: (request: Request) => string;
}

/** Map of channel names to their batch handlers. */
export type BatchHandlers<Batches extends BatchSchema> = {
	readonly [Key in keyof Batches]: BatchHandler<
		Batches[Key]["request"],
		Batches[Key]["response"]
	>;
};

/**
 * Defines the request/response contract for a regular (non-batched) channel.
 */
export interface RequestContract<Request = unknown, Response = unknown> {
	readonly request: Request;
	readonly response: Response;
}

/** Map of channel names to their request/response contracts for regular queries. */
export type RequestSchema = Record<string, RequestContract>;

/** Empty request schema for graphs without regular request channels. */
export type EmptyRequestSchema = Record<never, never>;

/**
 * Handles a single regular (non-batched) request. Executes immediately.
 */
export type RequestHandler<Request, Response> = (
	request: Request,
) => Promise<Response>;

/** Map of channel names to their regular request handlers. */
export type RequestHandlers<Requests extends RequestSchema> = {
	readonly [Key in keyof Requests]: RequestHandler<
		Requests[Key]["request"],
		Requests[Key]["response"]
	>;
};

/**
 * Context passed to formulas for async operations.
 *
 * - ctx.batch(channel, request) — For batch channels (batchRequests). When multiple
 *   compute() calls occur in the same microtask, requests for the same channel are
 *   coalesced. Use dedupeKey on the batch handler to collapse identical requests.
 * - ctx.request(channel, request) — For regular channels (requests). Executes
 *   immediately, no batching.
 */
export interface ComputeContext<
	Batches extends BatchSchema = EmptyBatchSchema,
	Requests extends RequestSchema = EmptyRequestSchema,
> {
	/**
	 * Submits a typed async request into a named batch channel.
	 * All requests for the same channel are coalesced in the current microtask.
	 * Identical keys within a batch collapse to one request. Also applies when
	 * multiple compute() calls are coalesced in the same microtask.
	 */
	batch<Key extends keyof Batches>(
		channel: Key,
		request: Batches[Key]["request"],
	): Promise<Batches[Key]["response"]>;
	/**
	 * Submits a typed async request into a regular (non-batched) channel.
	 * Executes immediately, no coalescing.
	 */
	request<Key extends keyof Requests>(
		channel: Key,
		request: Requests[Key]["request"],
	): Promise<Requests[Key]["response"]>;
	/**
	 * Safely branches execution.
	 * Dry-run: Executes BOTH functions to track all possible dependencies.
	 * Runtime: Evaluates the condition and executes ONLY the matching branch.
	 */
	branch<T, U = undefined>(
		condition: boolean,
		handlers: { then: () => T; else?: () => U },
	): T | U;
	/**
	 * Safely evaluates a value against multiple cases.
	 * Dry-run: Executes ALL case functions to track dependencies.
	 * Runtime: Executes ONLY the matching case or default.
	 */
	match<K extends string | number | symbol, T, U = undefined>(
		value: K,
		cases: Partial<Record<K, () => T>> & { default?: () => U },
	): T | U;
}

/**
 * Formula function for a computed node. Receives state and context.
 *
 * @param state - Immutable snapshot of Root as of formula evaluation start.
 *   All reads within a formula (including across awaits) see the same snapshot.
 *   The runtime must not pass a live reference that could change between async boundaries.
 * @param ctx - Context for async operations (ctx.batch for batched, ctx.request for regular).
 */
export type Formula<
	Root,
	Key extends keyof Root,
	Batches extends BatchSchema = EmptyBatchSchema,
	Requests extends RequestSchema = EmptyRequestSchema,
> = (
	state: Readonly<Root>,
	ctx: ComputeContext<Batches, Requests>,
) => Awaitable<Root[Key]>;

/** Map of computed keys to their formula functions. Dependencies are auto-tracked via Proxy. */
export type FormulaMap<
	Root,
	Batches extends BatchSchema = EmptyBatchSchema,
	Requests extends RequestSchema = EmptyRequestSchema,
> = {
	readonly [Key in keyof Root]?: Formula<Root, Key, Batches, Requests>;
};

/** A fragment of formulas that can be merged with other fragments. */
export type GraphFragment<
	Root,
	Batches extends BatchSchema = EmptyBatchSchema,
	Requests extends RequestSchema = EmptyRequestSchema,
> = FormulaMap<Root, Batches, Requests>;

/** Merges two batch schemas; Right overrides Left for overlapping keys. */
export type MergeBatchSchemas<
	Left extends BatchSchema,
	Right extends BatchSchema,
> = Simplify<Omit<Left, keyof Right> & Right>;

/** Merges two graph fragments; Right overrides Left for overlapping keys. */
export type MergeGraphFragments<
	Root,
	Left extends GraphFragment<Root, BatchSchema, RequestSchema>,
	Right extends GraphFragment<Root, BatchSchema, RequestSchema>,
> = Simplify<Omit<Left, keyof Right> & Right>;

/** Keys that are computed by formulas. */
export type ComputedKeys<Root, Formulas> = Extract<keyof Formulas, keyof Root>;

/** Keys that are provided as input (not computed). */
export type SourceKeys<Root, Formulas> = Exclude<
	keyof Root,
	ComputedKeys<Root, Formulas>
>;

/** Values of source keys only. */
export type SourceValues<Root, Formulas> = Pick<
	Root,
	SourceKeys<Root, Formulas>
>;

/** Values of computed keys only. */
export type ComputedValues<Root, Formulas> = Pick<
	Root,
	ComputedKeys<Root, Formulas>
>;

/** Partial update for source fields only. */
export type SourcePatch<Root, Formulas> = Partial<SourceValues<Root, Formulas>>;

/** Input with only source keys (computed keys omitted). */
export type SourceInput<Root, Formulas> = Simplify<
	Omit<Root, ComputedKeys<Root, Formulas>>
>;

/**
 * Input to compute(). Represents current state with source fields populated.
 * Computed keys may be partially provided as overrides or initial values.
 */
export type ComputeInput<Root, Formulas> = Simplify<
	SourceInput<Root, Formulas> &
		Partial<Pick<Root, ComputedKeys<Root, Formulas>>>
>;

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
export interface GraphError<Key extends PropertyKey = PropertyKey> {
	readonly key: Key;
	readonly cause: unknown;
}

/** How the graph behaves when async dependencies are pending. */
export type ConsistencyMode = "hold-until-ready";

/** What happens when an async response arrives after inputs have changed. */
export type StalePolicy = "discard" | "discard-and-retry";

/** How the graph handles cyclic dependencies. */
export type CyclicMode = "error" | "freeze";

/**
 * Interceptor for transforming or validating node values.
 * Implementation deferred; type stub for v1.
 */
export type Interceptor<Root> = (
	node: keyof Root,
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
 * Type-safe accessor for selecting a node. Used by computeStatus, computeResult,
 * deps, and dependents for refactor-safe, autocomplete-friendly access.
 */
export type NodeAccessor<Root, Key extends keyof Root> = (x: Root) => Root[Key];

export interface GraphOptions<
	Batches extends BatchSchema = EmptyBatchSchema,
	Requests extends RequestSchema = EmptyRequestSchema,
> {
	/**
	 * Defines how the graph behaves when async dependencies are pending.
	 * v1 supports only 'hold-until-ready' to prevent mixed states.
	 */
	readonly consistency?: ConsistencyMode;
	/**
	 * Defines what happens when an async response arrives after the source
	 * inputs for that computation have already changed.
	 */
	readonly stalePolicy?: StalePolicy;
	/**
	 * How to handle cyclic dependencies. "error" (default) throws at createGraph.
	 * "freeze" lets cyclic nodes read from the previous compute() call.
	 */
	readonly cyclic?: CyclicMode;
	/**
	 * Named batch handlers for requests submitted through ctx.batch().
	 */
	readonly batchRequests?: BatchHandlers<Batches>;
	/**
	 * Named handlers for regular (non-batched) requests via ctx.request().
	 * Each call executes immediately, no coalescing.
	 */
	readonly requests?: RequestHandlers<Requests>;
	/**
	 * Interceptors for transforming or validating node values.
	 * Implementation deferred; type stub for v1.
	 */
	readonly interceptors?: readonly Interceptor<unknown>[];
	/**
	 * Called when a compute() completes and the result is applied (not discarded).
	 * Use to push results into your state layer (MobX, Zustand, etc.) without
	 * awaiting compute() at the call site. Fires only for non-stale results.
	 */
	readonly onUpdate?: (result: unknown) => void;
	/**
	 * Called when a node evaluation fails after the runtime has handled
	 * cancellation, batching, and stale response protection.
	 */
	readonly onError?: (error: GraphError) => void;
}

export interface Graph<
	Root,
	Formulas extends FormulaMap<Root, Batches, Requests>,
	Batches extends BatchSchema = EmptyBatchSchema,
	Requests extends RequestSchema = EmptyRequestSchema,
> {
	/**
	 * Computes a fully consistent Root snapshot.
	 * The runtime must avoid exposing intermediate mixed states while async
	 * dependencies are pending, so this always resolves asynchronously.
	 */
	compute(input: ComputeInput<Root, Formulas>): Promise<Root>;

	/**
	 * Reads the current runtime status for a computed node (key-based).
	 */
	status<Key extends ComputedKeys<Root, Formulas>>(key: Key): NodeStatus;

	/**
	 * Reads the current runtime status for a computed node (accessor-based).
	 * Type-safe and refactor-friendly.
	 */
	computeStatus<Key extends ComputedKeys<Root, Formulas>>(
		accessor: NodeAccessor<Root, Key>,
	): NodeStatus;

	/**
	 * Reads the latest stable snapshot for a computed node (key-based).
	 */
	snapshot<Key extends ComputedKeys<Root, Formulas>>(
		key: Key,
	): NodeSnapshot<Root[Key]>;

	/**
	 * Reads value and status together (accessor-based).
	 * Type-safe and refactor-friendly.
	 */
	computeResult<Key extends ComputedKeys<Root, Formulas>>(
		accessor: NodeAccessor<Root, Key>,
	): { readonly value: Root[Key] | undefined; readonly status: NodeStatus };

	/** Computed node names. Alias: nodes. */
	readonly computedKeys: readonly ComputedKeys<Root, Formulas>[];
	/** Computed node names (vision alias). */
	readonly nodes: readonly ComputedKeys<Root, Formulas>[];
	/** Source field names. Alias: sources. */
	readonly sourceKeys: readonly SourceKeys<Root, Formulas>[];
	/** Source field names (vision alias). */
	readonly sources: readonly SourceKeys<Root, Formulas>[];
	/** Topological execution order of computed nodes. */
	readonly order?: readonly string[];
	/** Whether the graph contains a cycle. */
	readonly hasCycle?: boolean;

	/**
	 * Returns direct dependencies of the node selected by the accessor.
	 */
	deps<Key extends ComputedKeys<Root, Formulas>>(
		accessor: NodeAccessor<Root, Key>,
	): readonly string[];

	/**
	 * Returns nodes that depend on the field selected by the accessor.
	 */
	dependents<Key extends keyof Root>(
		accessor: NodeAccessor<Root, Key>,
	): readonly string[];

	/**
	 * Exports the graph as Mermaid diagram source (for mermaid.live).
	 */
	toMermaid(): string;

	/**
	 * Traces execution for the given input. Returns per-node timing and results.
	 */
	trace(input: ComputeInput<Root, Formulas>): readonly TraceStep[];
}

/**
 * Builder returned by createGraph<Root>() when called with no arguments.
 * Use for incremental graph definition with type inference.
 */
export type CreateGraphBuilder<Root> = <
	Batches extends BatchSchema = EmptyBatchSchema,
	Requests extends RequestSchema = EmptyRequestSchema,
	const Formulas extends FormulaMap<Root, Batches, Requests> = FormulaMap<
		Root,
		Batches,
		Requests
	>,
>(
	formulas: Formulas,
	options?: GraphOptions<Batches, Requests>,
) => Graph<Root, Formulas, Batches, Requests>;

/**
 * Creates a computation graph from formulas and options.
 *
 * Overload 1: createGraph(formulas, options?) — define graph in one call.
 * Overload 2: createGraph<Root>() — returns builder for incremental definition.
 */
export interface CreateGraph {
	<
		Root,
		Batches extends BatchSchema = EmptyBatchSchema,
		Requests extends RequestSchema = EmptyRequestSchema,
		const Formulas extends FormulaMap<Root, Batches, Requests> = FormulaMap<
			Root,
		Batches,
		Requests
	>,
>(
	formulas: Formulas,
	options?: GraphOptions<Batches, Requests>,
): Graph<Root, Formulas, Batches, Requests>;

	<Root>(): CreateGraphBuilder<Root>;
}
