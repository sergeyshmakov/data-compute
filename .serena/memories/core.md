# Core

- TS library package `data-compute`: typed reactive derived-state DAG with sync formulas, async data sources, microtask batching, stale protection, granular patches.
- Public API exports from `src/index.ts`; main factory in `src/graph/index.ts` (`createGraph` direct or builder overload).
- Core modules:
  - `src/graph/compute-graph.ts`: `ComputeGraph` runtime, graph construction, compute coalescing, execution, status/snapshot/introspection/trace.
  - `src/graph/flatten.ts`: nested formula/dataSource maps -> `FlatNode[]`, including `each()` wildcard paths.
  - `src/graph/deps-maps.ts`: dry-run dependency extraction and reverse deps.
  - `src/dag/index.ts`: path normalization, implicit parent deps, Kahn topological sort.
  - `src/tracking/proxy.ts`: runtime/dry-run proxy dependency tracking.
  - `src/batch/coordinator.ts`: microtask batch request coalescing, dedupe, abort.
  - `src/types.ts`: public types and node helpers (`each`, `request`, `batchRequest`).
- `ARCHITECTURE.md` is the best durable high-level design doc; `README.md` is user-facing API/use-case framing.
- Working tree may contain user changes; check `git status --short` before edits and do not revert unrelated changes.