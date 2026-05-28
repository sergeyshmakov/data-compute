# Backlog

Implementation backlog for algorithmic and theoretical improvements that fit the
current `data-compute` DAG architecture.

The current engine is already strong enough for small and medium typed derived
state graphs: static dependency extraction, topological execution, async data
sources, request batching, stale protection, node status snapshots, tracing, and
granular patches are all in place. The ideas below are worth considering only
where they preserve that simple public model.

## P0: Selective Dirty-Subgraph Recompute

Current state:

- `ComputeGraph.flushCompute()` marks every computed node pending and iterates
  through every path in `this.order`.
- `depsMap` and `reverseMap` already exist, but runtime execution does not yet
  use them to skip unaffected nodes.

Goal:

- For each `compute(patch)`, run only computed nodes that depend on changed input
  paths, plus downstream dependents of recomputed computed nodes.
- Keep the public API unchanged.
- Preserve microtask coalescing, stale protection, async batching, granular patch
  output, and `setState` semantics.

Implementation sketch:

- Add a path collector for granular patches:
  - `{ a: { b: { c: 1 } } }` should produce `a`, `a.b`, `a.b.c` or at least
    enough normalized paths to match `reverseMap`.
  - Numeric array indices should normalize to `*` via existing `normalizePath`.
- Seed dirty nodes from `reverseMap`:
  - For every changed path, get direct computed dependents.
  - Walk computed dependents transitively.
  - Intersect the final dirty set with `this.order` to preserve topo order.
- In `flushCompute()`:
  - Mark only dirty nodes pending.
  - Execute only dirty nodes.
  - Leave skipped nodes' previous snapshots/statuses intact.
- Conservative first version:
  - If a dirty computed node runs, mark all computed dependents dirty even if the
    value later proves equal.
  - Equality/backdating can be a separate feature.
- Each-node handling:
  - Start conservative: if a changed path touches an array, recompute matching
    wildcard each nodes for the whole array.
  - Later improve with keyed per-item recompute.

Acceptance tests:

- Updating source `a` in a diamond graph recomputes only `a` dependents, not
  independent branches.
- Nested patch `pricing.taxRate` invalidates formulas depending on `pricing` and
  `pricing.taxRate`.
- Multiple same-microtask patches coalesce before dirty-set calculation.
- Skipped nodes keep previous `snapshot()` values and do not become `pending`.
- `setState` receives only the input patch plus recomputed computed fields.
- Stale async runs still discard or retry correctly when a later compute arrives.
- `each()` wildcard nodes remain correct for array updates.

Why this is worth doing:

- It moves the library from `O(all computed nodes)` per update toward
  `O(changed subgraph)`.
- It uses data structures the project already builds.
- It is visible to users with large forms, pricing models, table rows, or
  multi-source async graphs.

Risks:

- Path matching must be carefully defined for parent paths, child paths, and
  wildcard array paths.
- Status semantics for skipped nodes need explicit tests.
- Async retry paths should not accidentally replay older granular patches.

## P1: Red-Green Memoization and Backdating

Modern anchor:

- Salsa-style incremental computation tracks database revisions, dependency
  revisions, memoized values, and "changed at" revisions. If an input changes but
  a recomputed intermediate value is equal to the previous value, downstream
  dependents can often be skipped.

Goal:

- Avoid recomputing downstream nodes when an upstream node was dirtied but its
  value did not actually change.

Implementation sketch:

- Add per-node runtime metadata:
  - `value`
  - `verifiedAtVersion`
  - `changedAtVersion`
  - dependency changed-at snapshot from the last successful evaluation
- On compute:
  - Dirty nodes are candidates.
  - Before executing a candidate, check whether any dependency changed since the
    node was last verified.
  - After executing, compare new value with previous value using an equality
    strategy.
  - If equal, keep the old `changedAtVersion` ("backdate" the node).
  - If not equal, set `changedAtVersion` to current version.
- Equality strategy:
  - Default: `Object.is`.
  - Optional later: `equals?: (path, a, b) => boolean` in `GraphOptions`.
  - Avoid deep equality by default; it can be expensive and surprising.

Acceptance tests:

- Source input changes, intermediate formula recomputes to the same value, final
  dependent does not execute.
- `Object.is` edge cases are covered: `NaN`, `0`, `-0`.
- Async node equal response backdates and skips downstream formulas.
- Errors do not update memo metadata as successful values.

Why this is worth doing:

- Dirty-subgraph recompute skips unrelated work; red-green memoization skips
  unchanged downstream work inside the affected subgraph.
- It helps common cases such as rounding, clamping, normalization, filtering, or
  API responses that are semantically unchanged.

Risks:

- Requires crisp equality semantics.
- More runtime metadata means more memory.
- Must be introduced after P0, otherwise complexity lands without the main win.

## P1: Parallel Topological Levels

Current state:

- The execution loop walks `this.order` sequentially.
- `each()` items are parallelized with `Promise.all`, but independent top-level
  nodes are not scheduled as a level.

Goal:

- Run independent nodes in the same topological layer concurrently, especially
  independent async data sources.

Implementation sketch:

- During construction, compute topo levels from `depsMap`:
  - Level 0: computed nodes with no computed dependencies.
  - Level N: nodes whose computed dependencies are all in earlier levels.
- In `flushCompute()`, after applying dirty filtering:
  - For each level, run dirty nodes in that level with `Promise.all`.
  - Await the level before moving to the next level.
- Add a concurrency option only if needed:
  - `maxConcurrency?: number`
  - Default can be unlimited for async I/O, or omitted for the first version.
- Batch coordination:
  - Reuse the same `BatchCoordinator` per flush so same-level batch requests
    coalesce naturally.

Acceptance tests:

- Two independent async request nodes start before either resolves.
- Dependent node waits until all upstream level nodes finish.
- Error handling remains per-node and does not prevent independent nodes in the
  same level from completing unless the current semantics require it.
- Stale detection aborts in-flight batch work and prevents stale mutations.

Why this is worth doing:

- It improves wall-clock time for graphs with multiple independent async sources.
- It preserves glitch-free topological semantics.

Risks:

- Formula functions are user code. Parallel async scheduling can expose hidden
  side effects even though formulas are intended to be pure.
- Shared state mutation must remain isolated through frozen snapshots and staged
  writes.

## P1: Keyed Incremental `each()`

Current state:

- `each()` uses wildcard paths such as `items.*.tax`.
- Runtime execution maps over the whole matching array.

Goal:

- Allow item-level recompute when array items have stable identities.

Potential API:

```ts
eachKeyed((item) => item.id, {
  tax: (item) => item.price * item.taxRate,
});
```

Implementation sketch:

- Track previous item key order and per-key snapshots.
- On compute:
  - Match old/new items by key.
  - Recompute changed keys.
  - Reuse previous computed values for unchanged keys.
  - Treat inserted and removed keys explicitly.
- Returned patch shape should stay compatible with normal array output.

Acceptance tests:

- Updating one item recomputes only that key's derived fields.
- Reordering items preserves per-key computed values.
- Insert/delete behavior is deterministic.
- Duplicate keys throw or fall back to full-array recompute by documented rule.

Why this is worth doing:

- This is the practical, library-sized version of differential incremental
  collection processing.
- It helps table/grid/pricing-row use cases without importing the complexity of a
  full differential dataflow engine.

Risks:

- Array patch semantics can become subtle.
- Key stability and duplicate handling must be documented.

## P2: Request Cache and Cross-Cycle Deduplication

Current state:

- `BatchCoordinator` deduplicates within one microtask batch.
- `request()` has a `dedupeKey` type field but single-request execution does not
  currently use it as a cross-cycle cache.
- The README positions TanStack Query as the network cache layer, so this feature
  must stay modest.

Goal:

- Avoid duplicate in-flight requests and optionally reuse fresh responses across
  nearby compute cycles.

Potential API:

```ts
request(
  (state) => ({ productId: state.productId }),
  {
    query,
    dedupeKey: (req) => req.productId,
    cacheTimeMs: 5_000,
  },
);
```

Implementation sketch:

- Maintain an internal map per data source config:
  - key -> in-flight promise
  - key -> value with expiry
- Share in-flight promises across computes when key matches.
- Respect stale policy before writing a resolved value into graph state.
- Keep caching opt-in and small.

Acceptance tests:

- Two computes with the same request key share one in-flight request.
- Different request keys do not share.
- Expired cache entries refetch.
- Stale response sharing does not write old values into newer state.

Why this is worth doing:

- It reduces duplicate async work without requiring every user to bring a query
  library for small cases.

Risks:

- Too much caching overlaps with TanStack Query and expands project scope.
- Cache invalidation policy can become a product in itself; keep the API narrow.

## P2: Demand-Driven Targets

Goal:

- Let callers compute only selected outputs for large graphs.

Potential API:

```ts
await graph.compute(input, { targets: [(x) => x.total] });
```

Implementation sketch:

- Resolve targets to paths.
- Compute required ancestors by walking `depsMap` backwards.
- Execute only target ancestors in topo order.
- Still include input patch in returned patch.
- Consider whether `setState` should apply partial target patches by default.

Acceptance tests:

- Targeting `total` computes `subtotal` and `tax` if needed.
- Untargeted independent outputs are not executed.
- Async ancestors still wait correctly.
- `computeStatus` for untargeted nodes remains previous status.

Why this is worth doing:

- Useful for large graphs where only one UI panel or one backend field is needed.

Risks:

- The current API implies `compute()` updates the graph consistently for all
  computed fields. Targeted compute weakens that mental model.
- Probably wait until there is real user demand.

## P2: Explicit Branch Dependencies

Current state:

- Static dependency extraction dry-runs each formula once.
- Plain JavaScript conditionals record only the branch that runs during that
  dry-run. They cannot reliably record both arbitrary branches without a
  dedicated API.

Goal:

- Give users an explicit, type-safe way to declare dependencies that are hidden
  behind runtime branches.
- Keep the normal formula API simple for common cases.

Potential API:

```ts
dependsOn(["standardDiscount"], (f) =>
  f.isPremium ? f.premiumDiscount : f.standardDiscount,
);
```

Alternative:

```ts
branch(
  (f) => f.isPremium,
  {
    true: (f) => f.premiumDiscount,
    false: (f) => f.standardDiscount,
  },
);
```

Recommendation:

- Prefer explicit dependency overrides first. They are simpler, easier to type,
  and easier to explain than a magical branch helper.
- Consider a branch helper later only if real examples show repeated boilerplate.

Acceptance tests:

- A formula whose false branch depends on another computed node runs after that
  dependency when the explicit dependency is declared.
- Missing explicit dependencies remain documented as a limitation for plain
  conditionals.

## P2: Runtime Profiling and Debug Metrics

Goal:

- Make optimization decisions evidence-driven.

Potential API:

```ts
graph.trace(input);
graph.stats();
```

Useful metrics:

- Node execution count.
- Node skipped count after dirty filtering.
- Node skipped count after memo equality.
- Per-node duration.
- Async wait duration.
- Batch size and dedupe hit count.
- Stale abort/retry count.

Acceptance tests:

- Metrics are deterministic enough for assertions.
- Disabled metrics have near-zero overhead.
- Trace remains safe for async nodes.

Why this is worth doing:

- It will show whether P0/P1 are actually paying rent.
- It helps users find expensive formulas and accidental broad dependencies.

Risks:

- Public diagnostics APIs tend to ossify quickly.
- Keep unstable details behind `trace()` or an explicitly experimental API.

## P3: Durability Hints

Modern anchor:

- Salsa uses durability levels to avoid traversing dependency edges for data that
  rarely changes.

Potential API:

```ts
createGraph(formulas, dataSources, {
  durability: {
    countryTaxTable: "high",
    quantity: "low",
  },
});
```

Why this is lower priority:

- Dirty-subgraph recompute and memoization should solve most near-term needs.
- Durability is most useful when graphs and dependency metadata get large.

## P3: Dynamic Graph Updates and Incremental Topological Ordering

Modern anchor:

- Incremental topological ordering matters when edges/nodes are inserted into an
  existing graph and users need fast reordering or early schedule output.

Why this is probably overhead:

- `data-compute` creates the graph up front with `createGraph()`.
- Rebuilding topo order at construction is simple and cheap for the expected
  graph sizes.
- Dynamic topology would complicate dependency extraction, status semantics, and
  type inference.

Only consider if:

- A future API supports adding/removing formulas after graph creation.
- Graph construction cost appears in real benchmarks.

## P3: Full Differential Dataflow

Modern anchor:

- Differential dataflow maintains indexed traces of collection updates and can
  reuse arrangements across dataflows.

Why this is probably overhead:

- The project is a typed derived-state DAG, not a streaming relational engine.
- Full differential semantics would add concepts like timestamps, diffs,
  arrangements, and compaction that do not fit the current API.

Useful subset:

- Implement keyed incremental `each()` instead.

## P3: General Cyclic Fixpoint Evaluation

Current state:

- Cycles throw by default.
- `{ cyclic: "freeze" }` is not part of the public v1 contract. It was deferred
  because accepting it without a scheduler can silently skip cyclic nodes.

Potential simpler feature:

- A future frozen-cycle mode would need strongly connected component scheduling
  and previous-snapshot reads for intra-component dependencies.

Why this is probably overhead:

- General cycles need fixed-point iteration, convergence criteria, widening, or
  domain-specific lattice semantics.
- This would move the library away from predictable DAG execution.

Only consider if:

- A concrete domain needs monotone fixpoint computation and can define the
  convergence contract explicitly.

## Suggested Implementation Order

1. Add benchmarks and trace counters for current full-order recompute.
2. Implement P0 dirty-subgraph recompute.
3. Add topo-level scheduling for independent async nodes.
4. Re-benchmark.
5. Implement red-green memoization only if dirty recompute still leaves meaningful
   wasted work.
6. Add keyed `each()` if array-heavy use cases become central.

## Research Anchors

- Salsa red-green algorithm, revisions, backdating, durability:
  https://salsa-rs.github.io/salsa/reference/algorithm.html
- Salsa durability:
  https://salsa-rs.github.io/salsa/reference/durability.html
- Buck2 DICE incremental computation:
  https://buck2.build/docs/insights_and_knowledge/modern_dice/
- Turbopack incremental computation:
  https://en.nextjs.im/docs/pages/api-reference/turbopack/
- Differential dataflow arrangements:
  https://docs.rs/differential-dataflow/latest/differential_dataflow/operators/arrange/index.html
- Static topological ordering for glitch freedom in reactive systems:
  https://researchportal.vub.be/en/publications/reactive-programming-on-the-bare-metal-a-formal-model-for-a-low-l/
- Incremental ordering for scheduling problems:
  https://ojs.aaai.org/index.php/ICAPS/article/view/31500
