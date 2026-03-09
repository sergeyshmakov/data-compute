# data-compute

**TypeScript-first computation graph engine that keeps derived state consistent across sync and async updates.**

Sync derived state is easy — a few variables or `useMemo`. The real pain is **distributed async calculations**: multiple components need backend data, results arrive out of order, inputs change while waiting, and you must avoid mixed states. `data-compute` makes that first-class: declarative pure formulas, async data source nodes, auto-batching, stale protection, and atomic application.

## Installation

```bash
npm install data-compute
```

## The Problem: Distributed Async

You have pricing, tax, shipping — each from an API. Checkout, cart summary, and line items all trigger calculations. Backend expects batched requests. Responses arrive out of order. User edits while requests are in flight. Without coordination, you get **new count × old price**, flicker, and N re-renders. `data-compute` coordinates: one graph, one `compute()` call from anywhere, batched requests, consistent results.

## The Paradigm Shift: Separating Computation from Reactivity

**Legacy approach**: Your reactivity owns the updates. Logic is spread across your whole app (e.g., chained `useEffect`s, scattered `useMemo`s, reactive boundaries deep in the tree). It takes time to understand, test, and debug. When multiple async calculations interact, you get race conditions and cascading UI flickers.

**New approach**: Separate the computation graph from your reactivity and keep it in one place. `data-compute` **never owns state** and doesn't subscribe to it. It acts as a pure "number cruncher" and async coordinator.

1. **Trigger**: Your app explicitly calls `graph.compute(patch)` with a granular patch when a user types an input or a source value changes.
2. **Compute**: The graph merges the patch with `getState()` (if provided), runs declarative formulas in topological order, batches async data sources, and protects against stale data.
3. **Apply**: Your state manager receives the granular result via `setState` or the returned promise — only changed fields, same structure as root. `Object.assign(state, patch)` updates the UI atomically.

## Simplified Testing

Because the computation graph is entirely decoupled from your UI and state management, testing becomes remarkably simple. You don't need to mount React components, mock hooks, or set up complex store providers. You just instantiate the graph, call `compute()` with an initial state, and assert on the fully resolved output.

```ts
test('calculates correct total with tax and pricing API', async () => {
  const result = await graph.compute({
    productId: 'x',
    quantity: 2,
    customerTier: 'regular',
    basePrice: 10
  });
  
  // No need to wait for UI updates, just check the final snapshot
  expect(result.subtotal).toBe(20);
  expect(result.finalPrice).toBe(20); // Assuming no discount from pricing mock
  expect(result.total).toBeGreaterThan(20);
});
```

## Architecture

- Create the graph **once** at app top level (e.g. module scope or root component).
- The graph holds internal state (in-flight requests, coordination).
- Call `graph.compute(patch)` from any level — checkout, cart, line items, etc. How you provide the graph is your choice: React context, prop drilling, or global singleton.
- Pass **granular patches** (only changed fields). Multiple `compute()` calls in the same microtask are batched into one DAG execution.
- Either: `await compute()` and apply manually, or use `setState` to push results into your store. `setState` receives only changed fields in the same structure as root — `Object.assign(state, patch)` merges cleanly.

## Quick Start (Async)

```ts
import { createGraph, batchRequest } from "data-compute";

interface PricingForm {
  productId: string;
  quantity: number;
  customerTier: string;
  basePrice: number;
  subtotal: number;
  pricing: { adjustedPrice: number; taxRate: number };
  finalPrice: number;
  tax: number;
  total: number;
}

const graph = createGraph<PricingForm>(
  // 1. Pure Math Formulas (Synchronous)
  {
    subtotal: (f) => f.quantity * f.basePrice,
    finalPrice: (f) => (f.pricing?.adjustedPrice ?? 0) * f.quantity,
    tax: (f) => f.finalPrice * (f.pricing?.taxRate ?? 0),
    total: (f) => f.finalPrice + f.tax,
  },
  // 2. Data Sources (Asynchronous)
  {
    pricing: batchRequest(
      // Maps current state to a request payload
      (f) => ({
        productId: f.productId,
        quantity: f.quantity,
        customerTier: f.customerTier,
      }),
      {
        query: async (entries) => {
          const res = await fetch("/api/pricing/batch", {
            method: "POST",
            body: JSON.stringify(entries.map((e) => e.request)),
          });
          const data = await res.json();
          return entries.map((e, i) => ({ id: e.id, response: data[i] }));
        },
        stalePolicy: "discard-and-retry",
      }
    ),
  }
);

// Create graph once. Call compute() from anywhere — checkout, cart, line item.
const result = await graph.compute({ productId: "x", quantity: 5, customerTier: "gold", basePrice: 10 });
```

## When to Use

| Scenario | Use data-compute? |
|---------|-------------------|
| Sync only (subtotal, tax, total from local fields) | Overkill — plain variables or `useMemo` are fine |
| Async in one place | Consider — `useEffect` + `useState` may suffice |
| **Async in many places** (checkout, cart, line items, dashboards) | **Yes** — batching, coordination, stale protection pay off |
| Backend expects batched requests | **Yes** — declarative `batchRequest` coalesces automatically |
| Mixed stale + fresh is a bug you've hit | **Yes** — graph holds until consistent |

## Core Concepts

### Source vs Computed Fields

- **Source fields** — You provide these. They come from user input, API responses, or external state.
- **Computed fields** — The graph produces these. Each has a formula that reads from source fields or other computed fields.

### Declarative Nodes

Formulas are plain pure functions. Asynchronous tasks are defined via `batchRequest` or `request` data sources. Dependencies are auto-tracked via Proxy — no manual `deps: [...]` arrays. TypeScript catches field renames at compile time.

**Order doesn't matter** — define nodes in any order. The graph builds a DAG from the dependency graph and executes in topological order. `total` before `subtotal`? Fine.

### Snapshot Semantics

Formulas receive an **immutable snapshot** of state as of evaluation start. All reads within a formula (including across array iterations) see the same snapshot. This prevents mixed-state bugs when evaluating multiple derived nodes.

### Deep Structures and Native Arrays

The engine supports deep nested objects and arrays. When mapping formulas over an array, use the `each()` utility to preserve strong typing and native iteration tracking.

```ts
import { createGraph, each } from "data-compute";

const graph = createGraph<Order>({
  items: each({
    // Item-level formula. `item` is the array element, `root` is the full state
    tax: (item, root) => item.price * 0.2 + root.globalSurcharge
  }),
  total: (f) => {
    // Safely iterates and tracks item.price and tax natively
    return (f.items ?? []).reduce((sum, item) => sum + item.price + item.tax, 0);
  }
});
```

## API Reference

| Method / Property | Description |
|------------------|-------------|
| `createGraph(formulas, dataSources?, options?)` | Defines the computation graph. Dependencies extracted statically at definition time. |
| `graph.compute(patch)` | Accepts a granular patch (only changed fields). Batches multiple calls in a microtask into one DAG execution. Returns `Promise<DeepPartial<Root>>` — the granular result (inputs + computed fields that changed). |
| `graph.computeStatus(accessor)` | Returns `"ready" \| "pending" \| "stale" \| "error"` for a node path. |
| `graph.computeResult(accessor)` | Returns `{ value, status }` for a node path. |
| `graph.status(key)` | Path-based status (alternative to `computeStatus`). |
| `graph.snapshot(key)` | Path-based snapshot (alternative to `computeResult`). |
| `graph.nodes` | Computed node paths. |
| `graph.sources` | Source field paths. |
| `graph.order` | Topological execution order. |
| `graph.deps(accessor)` | Direct dependencies of a node. |
| `graph.dependents(accessor)` | Nodes that depend on a field. |
| `graph.toMermaid()` | Exports graph as Mermaid diagram source. |
| `graph.trace(input)` | Execution trace for debugging. |

### Data Source Utilities

| Helper | Description |
|--------|-------------|
| `batchRequest(deps, config)` | Returns a node that aggregates multiple inputs in a microtask before sending one batched query. |
| `request(deps, config)` | Returns a node that executes immediately, suitable for single queries. |
| `each(mapping)` | Wraps a deep formula map to be executed for every item in an array. |

### Options

| Option | Description |
|--------|-------------|
| `stalePolicy` | `"discard"` or `"discard-and-retry"` when inputs change during async. |
| `cyclic` | `"error"` (default) or `"freeze"` for cyclic graphs. |
| `consistency` | v1 supports only `"hold-until-ready"`. |
| `getState` | Called before compute() evaluates to get the latest full state. Prevents stale closures when inputs change between `compute()` call and microtask flush. |
| `setState` | Callback when a compute() finishes. Receives only changed fields in same structure as root — use `Object.assign(state, patch)` to merge. Fires only for non-stale results. |
| `onError` | Called when a node evaluation fails. |

## Async and Batching

- **`batchRequest`** — Submits async work; all identical requests submitted in a microtask are coalesced. Multiple components calling `compute()` from different places = one batched request when possible.
- **`request`** — Executes immediately, no batching.
- **`stalePolicy`** — When source inputs change while a request is in flight, `"discard"` drops the response; `"discard-and-retry"` re-requests with current values. No more new-count × old-price bugs.
- **`graph.computeStatus(x => x.total)`** — `"pending"` while async deps resolve. Use for spinners, disabled buttons, or faded values.

## Granular Updates: Philosophy and DX

`graph.compute()` uses **granular updates only**. You pass partial patches; the graph returns partial patches. No full-state snapshots in or out.

### Why granular?

- **Minimal updates** — Only changed fields flow through. Your state manager (Zustand, MobX, React) receives exactly what changed, so it can optimize re-renders and avoid overwriting unrelated fields.
- **Clear DX** — Call `graph.compute({ quantity: 2 })` when the user edits quantity. No need to spread the whole form. The graph merges with `getState()` internally and produces a patch with `quantity`, `subtotal`, `tax`, `total` — only what actually changed.
- **Predictable merging** — `setState` receives the same nested structure as your root. `Object.assign(state, patch)` updates only the paths present in the patch. No accidental overwrites of sibling fields in deep objects.

### How it works

1. **Input** — `compute(patch)` accepts `DeepPartial<Root>`. Pass only the fields you changed.
2. **Batching** — Multiple `compute()` calls in the same microtask are coalesced into one patch, then one DAG execution.
3. **Base state** — If you provide `getState`, the graph merges your patch with the latest state before evaluating. Prevents stale closures.
4. **Output** — The promise resolves to a granular patch: your inputs plus computed fields that were evaluated. `setState` receives this same patch — only changed paths, same structure as root.

### Example

```ts
// User edits quantity. You pass only that.
graph.compute({ quantity: 2 });

// setState receives: { quantity: 2, subtotal: 20, tax: 2, total: 22 }
// Object.assign(store, patch) — only those four fields change.
```

## State Layer Integration

`data-compute` never owns state. It takes a granular patch, merges with `getState()` internally if provided, computes, and returns a granular patch. You choose how to apply it — typically `Object.assign(state, patch)`. These patterns work for both sync and async graphs; the key is one atomic update with only changed fields.

### Push pattern (setState)

Create once at top level. Use `getState` and `setState` to sync results into your store. No await needed at the call site.

```ts
import { runInAction } from "mobx";
import { createGraph } from "data-compute";

const graph = createGraph<PricingForm>(
  { /* formulas */ },
  { /* data sources */ },
  {
    getState: () => store,
    setState: (patch) => {
      // patch contains only changed fields in same structure as root
      runInAction(() => Object.assign(store, patch));
    },
  }
);

// Pass granular patches — only what changed. setState receives the same.
graph.compute({ quantity: 2 });
```

### MobX

```ts
import { observable, runInAction } from "mobx";
import { createGraph } from "data-compute";

const form = observable({ quantity: 1, unitPrice: 20, taxRate: 0.1, discount: 0, subtotal: 0, tax: 0, total: 0 });
const graph = createGraph<typeof form>({
  subtotal: (f) => f.quantity * f.unitPrice,
  tax: (f) => f.subtotal * f.taxRate,
  total: (f) => f.subtotal + f.tax - f.discount,
});

async function recompute() {
  const result = await graph.compute(form);
  runInAction(() => Object.assign(form, result));
}
```

### Zustand

```ts
import { create } from "zustand";
import { createGraph } from "data-compute";

const graph = createGraph<OrderForm>({ /* ... */ });

const useOrderStore = create<OrderForm>((set, get) => ({
  quantity: 1, unitPrice: 20, taxRate: 0.1, discount: 0, subtotal: 0, tax: 0, total: 0,
  setField: async (field, value) => {
    const result = await graph.compute({ ...get(), [field]: value });
    set(result);
  },
}));
```

### React useState

```ts
import { useState, useCallback, useEffect } from "react";
import { createGraph, type Graph } from "data-compute";

function useComputedState<T>(graph: Graph<T>, initial: T) {
  const [state, setState] = useState<T | null>(null);

  useEffect(() => {
    graph.compute(initial).then(setState);
  }, []);

  const update = useCallback((patch: Partial<T>) => {
    setState((prev) => {
      if (!prev) return prev;
      void graph.compute({ ...prev, ...patch }).then(setState);
      return prev;
    });
  }, [graph]);

  return [state, update] as const;
}
```

## Links

- [Contributing](CONTRIBUTING.md)
- [License](LICENSE)
