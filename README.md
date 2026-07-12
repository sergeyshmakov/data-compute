# data-compute

**Consistent async-derived state for TypeScript — no mixed-state UI, no stale-overwrite races.**

When user input, computed values, and async lookups depend on each other, `data-compute` runs them as one typed graph and returns atomic *cycle patches*: the screen never shows a half-updated state, and a slow response can't overwrite newer input.

[![npm version](https://img.shields.io/npm/v/data-compute.svg)](https://www.npmjs.com/package/data-compute)
[![CI](https://github.com/sergeyshmakov/data-compute/actions/workflows/pr.yml/badge.svg)](https://github.com/sergeyshmakov/data-compute/actions/workflows/pr.yml)
[![Bundle size](https://img.shields.io/bundlephobia/minzip/data-compute)](https://bundlephobia.com/package/data-compute)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0+-3178c6.svg?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

**Documentation:** https://sergeyshmakov.github.io/data-compute/

---

## The problem

Derived state that mixes user input, computed values, and async lookups is where consistency bugs live — a slow response lands after newer input and overwrites it, and the UI flashes a half-updated (mixed) state.

```ts
// Before — useMemo/useEffect scatter. `pricing` for an OLD productId can resolve
// after the user changed it, overwriting fresh input; the UI shows a mixed state.
const subtotal = useMemo(() => quantity * basePrice, [quantity, basePrice]);
const { data: pricing } = useQuery(["pricing", productId]);
const finalPrice = useMemo(
  () => (pricing?.adjustedPrice ?? 0) * quantity,
  [pricing, quantity],
);
const total = useMemo(() => finalPrice + tax, [finalPrice, tax]);
```

```ts
// After — one typed DAG. Downstream formulas wait for async, every cycle applies
// atomically, and responses for superseded input are discarded. No mixed state.
const graph = createGraph<Form>({
  subtotal:   (f) => f.quantity * f.basePrice,
  finalPrice: (f) => (f.pricing?.adjustedPrice ?? 0) * f.quantity,
  total:      (f) => f.finalPrice + f.tax,
});

const result = await graph.compute({ quantity, basePrice, pricing });
```

## What it is

A framework-agnostic computation engine for state that mixes sync formulas with async lookups. You declare each value as a pure formula; `data-compute` auto-tracks dependencies, orders the graph, waits for async sources, and applies each cycle atomically with stale-response protection.

- **Sync + async in one graph** — downstream formulas wait for async data sources automatically; no manual coordination.
- **Consistency by construction** — every formula in a cycle sees the same snapshot and results apply atomically, so the UI never renders a half-updated state.
- **Stale-response protection** — when inputs change mid-flight, obsolete responses are discarded (or re-issued). Kills the new-count × old-price race.
- **Atomic cycle patches** — partial patch in, partial patch out, same shape as your root. No full snapshots cross the API.
- **Framework-agnostic** — plain objects in and out; composes with React, MobX, Zustand, and TanStack Query rather than replacing them.

## Is this for you?

**Reach for it when:**

- Derived state is **shared across components** and must stay consistent everywhere.
- Derived state comes from **multiple async sources** and mixed-state UI is unacceptable.
- Your backend expects **batched requests** — `batchRequest` coalesces N inputs into one call.
- You keep fighting **new-count × old-price** style races — `stalePolicy` eliminates the class.

**Skip it when:**

- It's **sync derived state in one component** — `useMemo` is fine.
- Your state is **purely async with no derivations** — use TanStack Query directly.
- You want **signals / reactivity primitives** — use Solid, Signals, or MobX. `data-compute` is not a reactivity engine; it's a computation engine consumed by your reactivity layer.

## Install

```bash
npm install data-compute
```

Requirements: Node `>=20`, TypeScript `>=5.0`.

> **TypeScript `lib` note:** the public types reference the standard `AbortSignal`
> global (via the batch query `meta.signal`). This is available by default in
> Node projects (`@types/node`) and browser projects (the `DOM` lib). If you
> compile with an explicit `lib` that excludes both, add `"DOM"` (or `@types/node`)
> to your `tsconfig`, or enable `skipLibCheck`.

## Quick start

### 1. Sync derived state

```ts
import { createGraph } from "data-compute";

interface OrderForm {
  quantity: number;
  unitPrice: number;
  taxRate: number;
  discount: number;
  subtotal: number;
  tax: number;
  total: number;
}

const graph = createGraph<OrderForm>({
  subtotal: (f) => f.quantity * f.unitPrice,
  tax:      (f) => f.subtotal * f.taxRate,
  total:    (f) => f.subtotal + f.tax - f.discount,
});

const result = await graph.compute({
  quantity: 5,
  unitPrice: 20,
  taxRate: 0.1,
  discount: 5,
});
// → { quantity: 5, unitPrice: 20, taxRate: 0.1, discount: 5,
//     subtotal: 100, tax: 10, total: 105 }
```

Dependencies are auto-tracked by Proxy at graph definition time. Execution is topologically sorted. The result is a cycle patch: the input fields for this cycle plus the computed outputs that ran.

### 2. Add an async data source

```ts
import { createGraph, request } from "data-compute";

const graph = createGraph<PricingForm>(
  {
    subtotal: (f) => f.quantity * f.basePrice,
    tax:      (f) => f.subtotal * (f.taxRate ?? 0),
    total:    (f) => f.subtotal + f.tax,
  },
  {
    taxRate: request(
      (f) => ({ productId: f.productId }),
      { query: async ({ productId }) => fetchTaxRate(productId) },
    ),
  },
);

const result = await graph.compute({ productId: "p_1", quantity: 5, basePrice: 20 });
```

The async node participates in the same DAG as the sync formulas. Downstream formulas wait automatically. If `productId` changes mid-flight, the in-flight request is handled per `stalePolicy`.

### 3. Wire into a state manager

Assume `applyPatch` is your framework or store helper that deep-merges patch paths into the current state.

```ts
const graph = createGraph<OrderForm>(
  { /* formulas */ },
  { /* data sources */ },
  {
    getState: () => store,
    setState: (patch) => applyPatch(store, patch),
  },
);

// Fire-and-forget — setState wires results into the store
graph.compute({ quantity: 2 });
```

Granular patches in, granular patches out. `applyPatch` should be your store's deep patch merge helper, so nested patches preserve unrelated siblings. See [Integrations](https://sergeyshmakov.github.io/data-compute/integrations/tanstack-query/) for MobX, Zustand, and React examples.

## Use with TanStack Query

`data-compute` and TanStack Query operate at different layers:

| Layer | TanStack Query | data-compute |
|---|---|---|
| Network cache, dedup, refetch, retry | ✅ | ❌ |
| Optimistic updates, mutations | ✅ | ❌ |
| Typed derived state with dep tracking | ❌ | ✅ |
| Sync + async unified in one DAG | ❌ | ✅ |

**TanStack Query is the cache layer; `data-compute` is the derivation layer.** Use both when query results feed into derived state with consistency requirements.

```ts
// TanStack Query handles the network
const pricingQuery = useQuery({
  queryKey: ["pricing", productId],
  queryFn: fetchPricing,
});

// data-compute consumes those results inside a typed DAG
const result = await graph.compute({
  quantity,
  basePrice,
  pricing: pricingQuery.data,
});
```

See the [TanStack Query integration guide](https://sergeyshmakov.github.io/data-compute/integrations/tanstack-query/) for the full pattern, including `queryClient.fetchQuery` inside a `data-compute` data source.

## Core concepts

- **Source fields** — values you provide (user input, API responses, props).
- **Computed fields** — values the graph produces from a pure formula.
- **Auto-tracked dependencies** — formulas run once against a recording Proxy; reads become the dependency set. No manual `deps: [...]` arrays.
- **Snapshot semantics** — every formula in one cycle sees the same immutable view of state. No mixed-state bugs.
- **Granular patches** — `compute()` accepts a partial patch and returns a partial patch. No full snapshots cross the API.

Full details: [Core concepts](https://sergeyshmakov.github.io/data-compute/guides/core-concepts/).

## Async and batching

| Helper | When to use |
|---|---|
| `request(deps, config)` | Single async lookup; executes immediately |
| `batchRequest(deps, config)` | Backend expects coalesced requests — N inputs → one POST |
| `stalePolicy: "discard"` | Drop stale responses; node stays pending until next cycle |
| `stalePolicy: "discard-and-retry"` | Drop and immediately re-issue with latest inputs |
| `graph.computeStatus(accessor)` | `"ready" \| "pending" \| "stale" \| "error"` for UI affordances |

Full guide: [Async and batching](https://sergeyshmakov.github.io/data-compute/guides/async-and-batching/).

## API reference

Full reference: [API cheatsheet](https://sergeyshmakov.github.io/data-compute/reference/api-cheatsheet/) and [Types](https://sergeyshmakov.github.io/data-compute/reference/types/).

| Method | Purpose |
|---|---|
| `createGraph(formulas, dataSources?, options?)` | Defines the graph. Dependencies extracted statically. |
| `graph.compute(patch)` | Runs one cycle. Granular patch in, granular patch out. |
| `graph.computeStatus(accessor)` | Status of a node. |
| `graph.computeResult(accessor)` | `{ value, status }` for a node. |
| `graph.deps(accessor)` | Direct dependencies of a node. |
| `graph.dependents(accessor)` | Nodes that depend on a field. |
| `graph.order` | Topological execution order. |
| `graph.toMermaid()` | Mermaid diagram of the graph. |
| `each(mapping)` | Per-item formula map for arrays. |
| `request(deps, config)` | Single async data source. |
| `batchRequest(deps, config)` | Coalesced async data source. |

## Comparison

Ordered by what sets `data-compute` apart — the differentiators are up top; the last two rows are table stakes it shares with mature incumbents.

| | `data-compute` | Reselect | MobX computed | Jotai derived | TanStack Query |
|---|---|---|---|---|---|
| Async nodes in same graph | ✅ | ❌ | Workaround | Async atoms | n/a |
| Snapshot consistency | ✅ | n/a | Per-tick | Per-render | n/a |
| Stale protection on inputs | ✅ | n/a | Manual | Manual | ✅ |
| Granular patch output | ✅ | ❌ | n/a | n/a | n/a |
| Request batching | ✅ | ❌ | ❌ | ❌ | ✅ |
| Framework-agnostic | ✅ | ✅ | ❌ MobX | ❌ React | ❌ React/Vue/Solid |
| Typed derived state | ✅ | Manual | ✅ | ✅ | ❌ |
| Auto-tracked deps | ✅ Proxy | Manual selectors | ✅ | ✅ | n/a |

## Links

- [Documentation](https://sergeyshmakov.github.io/data-compute/)
- [Architecture](ARCHITECTURE.md)
- [Contributing](CONTRIBUTING.md)
- [Changelog](CHANGELOG.md)
- [License](LICENSE)
