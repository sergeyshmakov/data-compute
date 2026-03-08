Now I have a deep understanding of both packages, your real-world pain points, and your DX preferences. Let me craft a comprehensive updated vision.

---

# `data-compute` — Updated Vision

## The Name Question

**`data-compute`** is the right choice. Here's why:

- It fits your existing `data-*` family (`data-path`, `data-compute`) — this is a product line, not a standalone package
- `compute()` as the primary method feels natural and self-documenting
- `derived` is taken on npm, `deriven` is free but sounds like a misspelling, not a brand
- "Compute" is a verb that describes exactly what the package does — no ambiguity

**Recommendation:** Package name `data-compute`, primary export `createGraph()`, primary method `graph.compute()`.

---

## What `data-compute` Actually Is

> **`data-compute`** is a TypeScript-first computation graph engine that keeps derived state **consistent** across sync and async updates.
>
> Define formulas as lambdas. The graph tracks dependencies, batches async operations, prevents stale overwrites, and applies all changes atomically — whether your state lives in MobX, Zustand, React Hook Form, or a plain object.

That single paragraph captures three real differentiators:
1. Lambda-based dependency tracking (your existing strength)
2. Async batch consistency (the real-world problem you described)
3. State-layer agnostic with atomic application (the MobX story)

---

## The Three Problems This Package Solves

### Problem 1: Manual Dependency Wiring

Every non-trivial app has computed values that depend on other computed values. Today developers wire this with `useMemo` chains, `useEffect` cascades, or MobX `computed` decorators — all of which require manually declaring what depends on what.

```ts
// ❌ What people write today (React)
const subtotal = useMemo(() => quantity * unitPrice, [quantity, unitPrice]);
const tax = useMemo(() => subtotal * taxRate, [subtotal, taxRate]);
const total = useMemo(() => subtotal + tax - discount, [subtotal, tax, discount]);
// 3 hooks, 3 dependency arrays, all manual, all fragile
```

```ts
// ✅ data-compute
const graph = createGraph<OrderForm>({
  subtotal: (f) => f.quantity * f.unitPrice,
  tax:      (f) => f.subtotal * f.taxRate,
  total:    (f) => f.subtotal + f.tax - f.discount,
});

const result = graph.compute(formValues);
```

No dependency arrays. The Proxy sees what each formula reads. TypeScript catches field renames at compile time.

### Problem 2: Async Arrival & Data Inconsistency

Real world: `total = price × count`, but `price` comes from an API and `count` comes from user input. They arrive at different times. Between arrivals, your UI shows **inconsistent intermediate state**: new count × old price = wrong total.

Worse: your backend calculation API batches multiple queries, returns results for many fields at once, and responses can arrive out of order.

This is the problem nobody solves well today. `data-compute` makes it a first-class concern.

### Problem 3: Atomic State Application

When computed results are ready, you need to apply 15 field changes to MobX/Zustand/React state. If you apply them one by one, you trigger 15 re-renders or 15 MobX reactions. You need all changes applied as one atomic update.

---

## Package DNA

| # | Principle | Rule |
|---|-----------|------|
| 🧬1 | **Lambdas define the graph** | Dependencies extracted from typed functions via Proxy. No manual `deps: [...]` arrays |
| 🧬2 | **Plain data through, any state around** | Computation works on plain objects. State layer (MobX, Zustand, signals) wraps from outside — never stripped, never replaced |
| 🧬3 | **Consistency over speed** | Derived values are never computed from stale + fresh mixed inputs. The graph waits, batches, or rolls back — but never lies |
| 🧬4 | **Atomic application** | All computed changes from a single `compute()` call are collected and applied to state in one operation |
| 🧬5 | **Stack agnostic** | Zero coupling to React, Vue, MobX, or any framework. Adapters are thin, optional, separate |
| 🧬6 | **Zero dependencies** | No dependency on `data-path` or anything else. Compatible with `data-path` patterns by convention |

---

## Core API

### `createGraph<T>(formulas, options?)`

Defines the computation graph. Formulas are lambdas. Dependencies are auto-tracked.

```ts
import { createGraph } from "data-compute";

interface OrderForm {
  // source fields (you provide these):
  quantity: number;
  unitPrice: number;
  taxRate: number;
  discount: number;
  // computed fields (graph produces these):
  subtotal: number;
  tax: number;
  total: number;
}

const graph = createGraph<OrderForm>({
  subtotal: (f) => f.quantity * f.unitPrice,
  tax:      (f) => f.subtotal * f.taxRate,
  total:    (f) => f.subtotal + f.tax - f.discount,
});
```

Under the hood, `createGraph` executes each formula once against a recording Proxy to capture dependencies, then builds and topologically sorts the DAG. This happens once at definition time.

### `graph.compute(state)`

The daily driver. Takes your current state (with source fields populated), returns a new object with all computed fields filled in.

```ts
const result = graph.compute({
  quantity: 5,
  unitPrice: 20,
  taxRate: 0.1,
  discount: 5,
});
// → { quantity: 5, unitPrice: 20, taxRate: 0.1, discount: 5,
//     subtotal: 100, tax: 10, total: 105 }
```

**Key behaviors:**
- **Sync** when all formulas are sync
- **Returns `Promise`** when graph contains async formulas
- **Incremental**: only recomputes nodes whose dependencies changed (when called with a previous state reference)
- Multiple `compute()` calls from different parts of the app targeting the same graph are coordinated (see batching below)

### `graph.computeStatus(accessor)`

Check readiness of a specific computed value. Useful when async dependencies haven't resolved yet.

```ts
// After a compute() that's still waiting for async results:
graph.computeStatus(x => x.total)    // "pending" | "ready" | "stale" | "error"
graph.computeStatus(x => x.subtotal) // "ready" (sync deps were all present)
```

The accessor uses the same lambda-proxy pattern as `data-path` — typed, autocomplete-friendly, refactor-safe. But `data-compute` implements its own lightweight proxy for this, no dependency on `data-path`.

### `graph.computeResult(accessor)`

When you need both value and status together:

```ts
const { value, status } = graph.computeResult(x => x.total);
// status: "ready"  → value is current and consistent
// status: "stale"  → value exists but computed from outdated inputs
// status: "pending" → value is undefined, waiting for async deps
// status: "error"  → computation failed, value is undefined
```

---

## The Async Batching Problem (Real World)

This is based on your actual work project. Here's the full scenario:

```
1. Multiple UI components trigger calculations independently
2. Each calculation needs backend data (e.g., pricing, tax, eligibility)
3. Backend expects batched requests (array of queries)
4. Backend returns array of results (each result = many fields)
5. Results must be applied to state atomically
6. While waiting, source fields may change → stale response must be discarded
```

### How `data-compute` handles this

```ts
const graph = createGraph<PricingForm>({
  // Local sync computations
  subtotal: (f) => f.quantity * f.basePrice,

  // Async node that needs backend calculation
  // Multiple async nodes are automatically batched per microtask
  pricing: async (f, ctx) => {
    return ctx.batch("pricing-api", {
      productId: f.productId,
      quantity: f.quantity,
      customerTier: f.customerTier,
    });
  },

  // Depends on async result — won't compute until pricing resolves
  finalPrice: (f) => f.pricing.adjustedPrice * f.quantity,
  tax:        (f) => f.finalPrice * f.pricing.taxRate,
  total:      (f) => f.finalPrice + f.tax,
}, {
  batching: {
    "pricing-api": {
      // Collects all queries within a microtask, sends as array
      transport: async (queries) => {
        const response = await fetch("/api/pricing/batch", {
          method: "POST",
          body: JSON.stringify(queries),
        });
        return response.json(); // returns array of results, same order
      },
      // Optional: deduplicate identical queries within a batch
      dedupeKey: (query) => `${query.productId}-${query.quantity}`,
    },
  },
  // Stale response protection: if source fields changed while awaiting,
  // discard the response and re-request with current values
  stalePolicy: "discard-and-retry",
});
```

### What happens under the hood

```
Component A calls: graph.compute({ ...state, quantity: 5 })
Component B calls: graph.compute({ ...state, customerTier: "gold" })
                   ↓ (same microtask)
        ┌──────────────────────────────────┐
        │ Batch collects both queries:     │
        │  [{ productId, qty:5, gold },    │
        │   { productId, qty:5, gold }]    │
        │ Deduped → single query           │
        │ → POST /api/pricing/batch        │
        └──────────────────────────────────┘
                   ↓ (response arrives)
        ┌──────────────────────────────────┐
        │ Check: are source fields still   │
        │ the same as when we requested?   │
        │ YES → apply results              │
        │ NO  → discard, re-request        │
        └──────────────────────────────────┘
                   ↓
        ┌──────────────────────────────────┐
        │ Compute all downstream nodes:    │
        │ finalPrice, tax, total           │
        │ Collect all field changes        │
        │ Apply to state ONCE (atomic)     │
        └──────────────────────────────────┘
```

### The Consistency Model

The key insight: **while an async result is pending, downstream nodes must not mix fresh source fields with stale derived fields.**

```
Timeline:
  t0: state = { quantity: 5, basePrice: 10, pricing: { taxRate: 0.1 } }
  t1: user changes quantity to 10
  t2: graph.compute() triggered
      - subtotal recomputes immediately: 10 * 10 = 100 ✅
      - pricing: needs backend → pending
      - finalPrice: depends on pricing → BLOCKED (not computed with stale pricing)
      - tax, total: also blocked
  t3: pricing response arrives (for quantity=10)
      - finalPrice, tax, total all compute with consistent data ✅
```

**Without `data-compute`**, the typical bug is:

```
  t2: finalPrice = newQuantity(10) * oldPricing.adjustedPrice  ← WRONG
  t3: finalPrice = newQuantity(10) * newPricing.adjustedPrice  ← correct, but UI flickered
```

The `computeStatus` API lets your UI handle the pending state:

```tsx
function OrderTotal() {
  const form = useFormState();
  const result = graph.compute(form);

  const totalStatus = graph.computeStatus(x => x.total);

  if (totalStatus === "pending") return <Spinner />;
  if (totalStatus === "stale") return <FadedValue value={result.total} />;
  return <strong>{result.total}</strong>;
}
```

---

## State Layer Integration

### The Core Principle: We Compute, You Store

`data-compute` never owns state. It takes a snapshot, computes derived values, and gives you back data to apply. **How you apply it is your business**, and we make it easy for every state layer.

### MobX

MobX objects are Proxies. `data-compute` doesn't interfere because:
- It reads from the MobX object to get current values (triggering MobX tracking — which is fine, it's read-only)
- It computes derived values as plain data
- It writes results back inside a single `runInAction`, so MobX fires one reaction, not N

```ts
import { observable, runInAction } from "mobx";
import { createGraph } from "data-compute";

const form = observable({
  quantity: 1,
  unitPrice: 20,
  taxRate: 0.1,
  discount: 0,
  subtotal: 0,
  tax: 0,
  total: 0,
});

const graph = createGraph<typeof form>({
  subtotal: (f) => f.quantity * f.unitPrice,
  tax:      (f) => f.subtotal * f.taxRate,
  total:    (f) => f.subtotal + f.tax - f.discount,
});

// One function to recompute and apply atomically:
function recompute() {
  const result = graph.compute(form);
  runInAction(() => {
    // Apply all computed fields in one transaction
    Object.assign(form, result);
  });
}

// Call recompute() after any mutation. MobX fires ONE reaction.
```

**Why this works perfectly:**
- `graph.compute(form)` reads from the MobX proxy (triggering MobX's own tracking, which is harmless)
- `data-compute`'s recording proxy runs at `createGraph()` time against a throwaway object, not against MobX's proxy — zero conflict
- `Object.assign` inside `runInAction` applies 3 field changes as one MobX transaction

### Zustand

```ts
import { create } from "zustand";
import { createGraph } from "data-compute";

const graph = createGraph<OrderForm>({
  subtotal: (f) => f.quantity * f.unitPrice,
  tax:      (f) => f.subtotal * f.taxRate,
  total:    (f) => f.subtotal + f.tax - f.discount,
});

const useOrderStore = create<OrderForm>((set, get) => ({
  quantity: 1, unitPrice: 20, taxRate: 0.1, discount: 0,
  subtotal: 0, tax: 0, total: 0,

  setField: (field, value) => {
    // One set() call with all computed values — one render
    set(graph.compute({ ...get(), [field]: value }));
  },
}));
```

### React `useState`

```ts
function useComputedState<T>(graph: Graph<T>, initial: T) {
  const [state, setState] = useState(() => graph.compute(initial));

  const update = useCallback((patch: Partial<T>) => {
    setState(prev => graph.compute({ ...prev, ...patch }));
  }, [graph]);

  return [state, update] as const;
}

// Usage:
const [order, updateOrder] = useComputedState(graph, initialValues);
updateOrder({ quantity: 10 }); // recomputes subtotal, tax, total — one render
```

### React Hook Form

```ts
const { watch, reset, getValues } = useForm<OrderForm>({ defaultValues });

useEffect(() => {
  const subscription = watch((values) => {
    const computed = graph.compute(values as OrderForm);
    // reset with keepDirty so user edits aren't overwritten
    reset(computed, { keepDirty: true });
  });
  return () => subscription.unsubscribe();
}, []);
```

### TanStack Form

```ts
const form = useForm<OrderForm>({
  defaultValues,
  onSubmit: ({ value }) => console.log(value),
});

// Subscribe to store changes, recompute, apply
useEffect(() => {
  return form.store.subscribe(() => {
    const current = form.state.values;
    const computed = graph.compute(current);
    // Apply only computed fields, not source fields
    form.setFieldValues(computed);
  });
}, []);
```

---

## Introspection & Debugging

```ts
graph.nodes         // ["subtotal", "tax", "total"] — computed node names
graph.sources       // ["quantity", "unitPrice", "taxRate", "discount"] — source fields
graph.order         // topological execution order
graph.deps(x => x.total)       // ["subtotal", "tax", "discount"]
graph.dependents(x => x.taxRate) // ["tax"] — what recomputes when taxRate changes
graph.hasCycle      // boolean

// Visual export (copy-paste into mermaid.live)
graph.toMermaid()
// quantity --> subtotal
// unitPrice --> subtotal
// subtotal --> tax
// taxRate --> tax
// subtotal --> total
// tax --> total
// discount --> total

// Execution trace (for debugging)
const trace = graph.trace(inputData);
// [
//   { node: "subtotal", deps: { quantity: 5, unitPrice: 20 }, result: 100, ms: 0.01 },
//   { node: "tax",      deps: { subtotal: 100, taxRate: 0.1 }, result: 10, ms: 0.01 },
//   { node: "total",    deps: { subtotal: 100, tax: 10, discount: 5 }, result: 105, ms: 0.01 },
// ]
```

All introspection accessors use the lambda pattern for type safety:

```ts
graph.deps(x => x.total)         // typed, autocomplete
graph.dependents(x => x.taxRate) // typed, autocomplete
```

---

## Compatibility with `data-path`

`data-compute` has **zero dependency** on `data-path`. But they share the same lambda-proxy philosophy, and they compose naturally:

```ts
import { path } from "data-path";
import { createGraph } from "data-compute";

// data-path for deep access/update
const quantityPath = path<AppState>(p => p.order.lines[0].quantity);

// data-compute for derived values within a slice
const lineGraph = createGraph<OrderLine>({
  subtotal: (l) => l.quantity * l.unitPrice,
});

// Compose: read deep → compute → write deep
function updateLine(state: AppState, lineIdx: number, patch: Partial<OrderLine>) {
  const linePath = path<AppState>(p => p.order.lines[lineIdx]);
  const currentLine = linePath.get(state);
  const computed = lineGraph.compute({ ...currentLine, ...patch });
  return linePath.set(state, computed);
}
```

If a user has `data-path` installed, they can use `data-path` paths in `data-compute` introspection. But nothing requires it.

---

## Advanced: Cyclic Graphs

v1 ships with two modes:

| Mode | Behavior | Use Case |
|------|----------|----------|
| `"error"` (default) | Throws at `createGraph()` if cycle detected | Business logic, forms, dashboards — the safe default |
| `"freeze"` | Cyclic nodes read their value from the **previous** `compute()` call | Game loops, iterative UI updates, physics |

```ts
const physics = createGraph<Body>({
  velocity:     (b) => b.velocity + b.acceleration * b.dt,
  acceleration: (b) => b.force / b.mass + b.drag * b.velocity,
}, { cyclic: "freeze" });

// Each compute() advances one tick
let state = { velocity: 0, acceleration: 0, force: 10, mass: 2, drag: -0.1, dt: 0.016 };
state = physics.compute(state); // tick 1
state = physics.compute(state); // tick 2
```

`"iterate"` (convergence solver) and `"priority"` (explicit cycle-breaking) are deferred to v2 based on real-world demand.

---

## Advanced: Interceptors

Interceptors transform or validate node values. Kept minimal and deterministic — no timing logic (debounce/throttle belong at the call site).

```ts
const graph = createGraph<OrderForm>({
  subtotal: (f) => f.quantity * f.unitPrice,
  discount: (f) => f.promoCode ? applyPromo(f) : 0,
  total:    (f) => f.subtotal - f.discount,
}, {
  interceptors: [
    clamp({ discount: { min: 0, max: (f) => f.subtotal } }),
    validate({ total: (v) => v >= 0 || "Total cannot be negative" }),
  ],
});
```

Built-in:

| Interceptor | What it does |
|-------------|-------------|
| `clamp(rules)` | Bound values to min/max (static or derived from state) |
| `validate(rules)` | Assert constraints, attach error state |
| `log()` | Trace every node computation (dev only) |

Custom interceptors follow the same signature:
```ts
const audit: Interceptor<OrderForm> = (node, value, state, next) => {
  auditLog.record(node, value);
  return next(value);
};
```

---

## Full API Surface

```ts
// ─── Definition ──────────────────────────────────────────
createGraph<T>(
  formulas: { [K in ComputedKeys]: (state: T, ctx?: ComputeContext) => T[K] },
  options?: GraphOptions<T>
): Graph<T>

// ─── Computation ─────────────────────────────────────────
graph.compute(state: T): T                    // sync (returns Promise if async nodes)
graph.computeStatus(accessor: (x: T) => any): "ready" | "pending" | "stale" | "error"
graph.computeResult(accessor: (x: T) => V): { value: V | undefined, status: Status }

// ─── Introspection ───────────────────────────────────────
graph.nodes: string[]                          // computed node names
graph.sources: string[]                        // source field names
graph.order: string[]                          // topological execution order
graph.hasCycle: boolean
graph.deps(accessor: (x: T) => any): string[]
graph.dependents(accessor: (x: T) => any): string[]
graph.toMermaid(): string
graph.trace(state: T): TraceStep[]

// ─── Options ─────────────────────────────────────────────
{
  cyclic?: "error" | "freeze"
  interceptors?: Interceptor<T>[]
  batching?: Record<string, BatchConfig>
  stalePolicy?: "discard" | "discard-and-retry" | "keep"
  onError?: (node: string, error: Error) => void
}
```

---

## What Ships in v1 vs. Later

| v1 | v2+ (demand-driven) |
|----|---------------------|
| `createGraph` + `compute()` | Nested object / array-item formulas |
| Proxy-based dep tracking | `"iterate"` / `"priority"` cyclic modes |
| `computeStatus` / `computeResult` | `data-path` deep integration |
| Async nodes + microtask batching | DevTools UI (visual graph explorer) |
| Stale response protection | Partial graph composition (merge two graphs) |
| `"error"` + `"freeze"` cyclic modes | |
| `clamp`, `validate`, `log` interceptors | |
| `toMermaid()`, `trace()` | |
| Atomic application examples for MobX/Zustand/React/RHF/TanStack | |

---

## Summary

`data-compute` is not a reactive state library. It's the **computation layer** that sits between your state and your UI. You own the state (MobX, Zustand, useState, whatever). You own the rendering. `data-compute` owns exactly one thing: **given these inputs, what are the correct, consistent, derived outputs — and here they are, all at once.**
