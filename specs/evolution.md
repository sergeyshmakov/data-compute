Now let me compose the comprehensive expanded vision with all the topics you raised.

---

# `data-compute` — Expanded Vision v3

*A computation graph engine for consistent derived state across sync, async, and concurrent updates.*

---

## Naming Decision

**`data-compute`** — final answer. Here's the rationale:

- Fits the `data-*` product line (`data-path` → paths, `data-compute` → computation)
- `compute()` as the primary method is self-documenting
- "derive" / "derived" are taken on npm; "deriven" sounds like a typo
- "compute" is unambiguous — it doesn't promise reactivity (which it isn't) or state management (which it isn't)
- Googling "data-compute" doesn't collide with any major concept (unlike "derive" which collides with calculus, CSS, crypto derivation)

---

## The Full Problem Space

`data-compute` solves **six interconnected problems** that every complex app hits eventually:

| # | Problem | What goes wrong today |
|---|---------|----------------------|
| 1 | **Dependency wiring** | Manual `deps: [...]` arrays, `useMemo` chains, `useEffect` cascades |
| 2 | **Async inconsistency** | `total = newPrice × oldCount` while waiting for count to arrive |
| 3 | **Batch coordination** | 5 components each fire a backend query; should be 1 batched request |
| 4 | **Stale overwrites** | User changes country twice; first tax API response arrives last → wrong tax |
| 5 | **Atomic application** | 15 computed fields change → 15 re-renders instead of 1 |
| 6 | **Graph mutations at runtime** | Items added/removed from a list; computation graph must grow/shrink; in-flight requests for removed items must be cancelled |

---

## Core API

### `createGraph<T>(formulas, options?)`

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
```

### `graph.compute(state): T | Promise<T>`

The single entry point. Sync when all nodes are sync. Returns `Promise<T>` when async nodes exist. Multiple `compute()` calls from different parts of the app targeting the same graph instance are **coordinated** — batched, deduplicated, and applied atomically.

```ts
const result = graph.compute({
  quantity: 5, unitPrice: 20, taxRate: 0.1, discount: 5,
});
// → { ..., subtotal: 100, tax: 10, total: 105 }
```

### `graph.computeStatus(accessor): Status`

Check readiness of any computed node without mixing status into the value layer:

```ts
graph.computeStatus(x => x.total)     // "ready" | "pending" | "stale" | "error"
graph.computeStatus(x => x.subtotal)  // "ready"
```

### `graph.computeResult(accessor): { value, status }`

When you need both:

```ts
const { value, status } = graph.computeResult(x => x.total);
// status "ready"   → value is current, consistent
// status "stale"   → value exists but inputs changed since last full compute
// status "pending" → awaiting async dependencies
// status "error"   → computation failed
```

**Key DX decision:** value and status are **never mixed in the output object**. `compute()` always returns your clean `T`. Status lives in a separate query layer. Your business logic never has to check `if (total.status === "ready")` — that's a UI concern queried separately.

---

## Problem 1: Async Inconsistency (The Hard Problem)

### The scenario you described

```
total = price × count
price comes from API, count comes from user input
They arrive at different times
Between arrivals: total = newCount × oldPrice = WRONG
```

### How `data-compute` handles it

```ts
const graph = createGraph<PricingForm>({
  subtotal: (f) => f.quantity * f.unitPrice,
  pricing: async (f, ctx) => {
    return ctx.batch("pricing-api", {
      productId: f.productId,
      quantity: f.quantity,
    });
  },
  finalPrice: (f) => f.pricing.adjustedPrice * f.quantity,
  total:      (f) => f.finalPrice + f.tax,
}, {
  // While async deps are pending, downstream nodes use PREVIOUS consistent values
  // Never mix fresh source + stale derived
  consistency: "hold-until-ready",
});
```

**The consistency model:**

```
Timeline:
  t0: state = { quantity: 5, pricing: { adjustedPrice: 10, taxRate: 0.1 } }
      total = 5 × 10 + tax = consistent ✅

  t1: user changes quantity to 10
      graph.compute({ ...state, quantity: 10 })

  t2: What happens to "total" while pricing API is in-flight?

      ❌ WITHOUT data-compute:
         total = 10 × oldAdjustedPrice(10) = 100  ← WRONG, shows inconsistent value

      ✅ WITH data-compute (consistency: "hold-until-ready"):
         total stays at previous consistent value (50)
         computeStatus(x => x.total) === "stale"
         UI can show spinner or faded value

  t3: pricing response arrives (for quantity=10)
      total = 10 × newAdjustedPrice × ... = consistent ✅
      computeStatus(x => x.total) === "ready"
      All downstream values update atomically
```

### Real-world: your exact batch scenario

```ts
const graph = createGraph<ComplexForm>({
  // Multiple async nodes that each need backend calculation
  pricingResult: async (f, ctx) => ctx.batch("calc-api", {
    type: "pricing",
    productId: f.productId,
    quantity: f.quantity,
  }),

  eligibilityResult: async (f, ctx) => ctx.batch("calc-api", {
    type: "eligibility",
    customerId: f.customerId,
    region: f.region,
  }),

  taxResult: async (f, ctx) => ctx.batch("calc-api", {
    type: "tax",
    country: f.country,
    amount: f.subtotal,
  }),

  // Downstream sync nodes
  finalPrice: (f) => f.pricingResult.adjustedPrice * f.quantity,
  isEligible: (f) => f.eligibilityResult.approved,
  tax:        (f) => f.taxResult.taxAmount,
  total:      (f) => f.finalPrice + f.tax,
}, {
  batching: {
    "calc-api": {
      // All three async nodes above fire in same microtask
      // data-compute collects their queries, sends ONE request
      transport: async (queries) => {
        const res = await fetch("/api/calculations/batch", {
          method: "POST",
          body: JSON.stringify(queries),  // array of 3 queries
        });
        return res.json(); // array of 3 results, same order
      },
      // Each result is NOT one field — it's many fields
      // The transport returns the full result object per query
      // data-compute maps each result back to the node that requested it

      dedupeKey: (q) => JSON.stringify(q), // optional: collapse identical queries
    },
  },
  stalePolicy: "discard-and-retry",
});
```

**Under the hood:**

```
Component A: graph.compute({ ...state, quantity: 5 })    ← triggers pricingResult
Component B: graph.compute({ ...state, region: "EU" })   ← triggers eligibilityResult
Component C: (taxResult also needs recompute)
                          ↓
           ┌─── same microtask ───┐
           │ Batch collector:     │
           │ [pricing, eligibility, tax] queries │
           │ → ONE POST /api/calculations/batch  │
           └──────────────────────┘
                          ↓
           ┌─── response arrives ──┐
           │ Check: are source fields same as   │
           │ when we requested?                 │
           │ YES → distribute results to nodes  │
           │ NO  → discard, re-batch            │
           └───────────────────────┘
                          ↓
           ┌─── atomic application ─┐
           │ pricingResult = { adjustedPrice: 18, ... }  │
           │ eligibilityResult = { approved: true, ... } │
           │ taxResult = { taxAmount: 9, ... }           │
           │ finalPrice, isEligible, tax, total           │
           │ ALL computed + applied in ONE state update   │
           └────────────────────────┘
```

---

## Problem 2: Stale Response / Race Conditions

```ts
// User selects country "US" → tax API fires
// User quickly switches to "DE" → tax API fires again
// "US" response arrives AFTER "DE" response
// Without protection: tax shows US rate even though country is DE

const graph = createGraph<Form>({
  taxRate: async (f, ctx) => {
    return ctx.batch("tax", { country: f.country });
  },
  tax: (f) => f.subtotal * f.taxRate,
}, {
  stalePolicy: "discard-and-retry",
  // "discard"           → drop stale, keep current value
  // "discard-and-retry" → drop stale, re-request with current inputs
  // "keep"              → accept whatever arrives (no protection)
});
```

Each `compute()` call is tagged with a **version stamp** derived from the source fields that the async node depends on. When a response arrives, its stamp is compared against the current source state. Mismatch → discard.

---

## Problem 3: Graph Mutations (Items Added/Removed)

Real-world: an order form with dynamic line items.

### Template paths as graph nodes

This is where `data-compute` can leverage the `data-path` mental model (without depending on it):

```ts
interface Order {
  lines: Array<{
    productId: string;
    quantity: number;
    unitPrice: number;
    subtotal: number;       // computed per-line
    pricingResult: any;     // async per-line
  }>;
  grandTotal: number;       // computed from all lines
  taxTotal: number;
}

const graph = createGraph<Order>({
  // Template path: "lines.*.subtotal" — applies to every item
  "lines.*.subtotal": (line) => line.quantity * line.unitPrice,

  // Template path with async: each line gets its own backend query
  "lines.*.pricingResult": async (line, ctx) => ctx.batch("pricing", {
    productId: line.productId,
    quantity: line.quantity,
  }),

  // Aggregate across all lines
  grandTotal: (order) => order.lines.reduce((sum, l) => sum + l.subtotal, 0),
  taxTotal:   (order) => order.lines.reduce((sum, l) => sum + (l.pricingResult?.tax ?? 0), 0),
});
```

### What happens when items are added or removed?

```ts
// State at t0: 3 lines, all computed, pricing in-flight for line[2]
// User removes line[1]

const nextState = graph.compute({
  ...state,
  lines: state.lines.filter((_, i) => i !== 1),
});
```

**`data-compute` handles:**

| Scenario | Behavior |
|----------|----------|
| **Item removed** | In-flight async requests for that item are **cancelled** (via AbortSignal). Template nodes for that index are pruned from the active graph. No stale response will arrive for a deleted item |
| **Item added** | Template nodes are instantiated for the new index. Dependencies are traced. Async nodes fire immediately |
| **Index shift** | When item[1] is removed, item[2] becomes item[1]. `data-compute` tracks items by **identity** (configurable key), not by array index, so in-flight results map to the correct item regardless of reordering |

```ts
const graph = createGraph<Order>({
  "lines.*.subtotal": (line) => line.quantity * line.unitPrice,
}, {
  collections: {
    "lines": {
      // Track items by identity, not index position
      key: (item) => item.productId,  // or item.id
      // When an item is removed while async is in-flight:
      onOrphanedAsync: "cancel",      // "cancel" | "ignore" | "complete"
    },
  },
});
```

---

## Problem 4: Throttle

Throttling doesn't belong *inside* the computation (computation should be deterministic). It belongs at the **trigger boundary** — how often `compute()` is actually invoked.

```ts
const graph = createGraph<Dashboard>({
  conversionRate: (d) => d.purchases / d.visits,
  avgOrderValue: (d) => d.revenue / d.purchases,
  revenueGrowth: (d) => (d.revenue - d.prevRevenue) / d.prevRevenue,
}, {
  // Throttle the computation trigger, not individual nodes
  throttle: {
    compute: 100,   // max 1 compute() per 100ms, coalesces intermediate calls
    // The LAST state wins — intermediate states are dropped, not queued
    strategy: "trailing",  // "leading" | "trailing" | "both"
  },
});

// 50 rapid updates in 100ms → only 1 compute() executes with final state
```

Why this is better than per-node throttle: you never get a state where `subtotal` is throttled but `total` isn't — the entire graph is consistent at every computation.

---

## Problem 5: Conflict Resolution (CRDT-like)

When multiple concurrent `compute()` calls modify overlapping parts of the graph, you have a conflict problem. This matters in:

- **Collaborative editing** (two users change the same form)
- **Concurrent async** (two API responses arrive near-simultaneously, both affect `total`)
- **Optimistic updates** (UI shows optimistic value, server returns different value)

```ts
const graph = createGraph<CollaborativeForm>({
  total: (f) => f.price * f.quantity,
  displayPrice: (f) => formatCurrency(f.total, f.currency),
}, {
  conflicts: {
    // How to resolve when two compute() calls produce different values for same node
    strategy: "last-write-wins",  // default, simplest

    // Or: custom per-node resolution
    resolvers: {
      // Counter-like field: merge by adding deltas (CRDT-inspired)
      quantity: (local, remote, base) => base + (local - base) + (remote - base),

      // Timestamp-wins for price (whoever wrote last)
      price: "last-write-wins",

      // Custom merge function
      notes: (local, remote, base) => {
        if (local === base) return remote;    // only remote changed
        if (remote === base) return local;    // only local changed
        return `${local}\n---\n${remote}`;    // both changed: concatenate
      },
    },
  },
});
```

This doesn't make `data-compute` a full CRDT library — but it gives you a **resolution hook** at the graph level where conflicts naturally surface.

---

## Introspection & Debugging

```ts
graph.nodes           // ["subtotal", "tax", "total"]
graph.sources         // ["quantity", "unitPrice", "taxRate", "discount"]
graph.order           // topological execution order
graph.hasCycle        // boolean

// Lambda-based accessors (same pattern as data-path, zero dependency)
graph.deps(x => x.total)          // ["subtotal", "tax", "discount"]
graph.dependents(x => x.taxRate)  // ["tax"]

// Visual export
graph.toMermaid()
// ```mermaid
// graph TD
//   quantity --> subtotal
//   unitPrice --> subtotal
//   subtotal --> tax
//   taxRate --> tax
//   subtotal --> total
//   tax --> total
//   discount --> total
// ```

// Execution trace
const trace = graph.trace(inputData);
// [
//   { node: "subtotal", deps: { quantity: 5, unitPrice: 20 }, result: 100, ms: 0.01 },
//   { node: "tax", deps: { subtotal: 100, taxRate: 0.1 }, result: 10, ms: 0.01 },
//   ...
// ]
```

---

## State Layer Integration (We Compute, You Store)

### The principle

`data-compute` reads your state (even if it's a Proxy), computes derived values as plain data, and gives you the result. You apply it to your state layer however that layer expects. We never strip Proxies, never force immutability, never interfere.

### MobX

```ts
import { observable, runInAction } from "mobx";

const form = observable({ quantity: 1, unitPrice: 20, subtotal: 0, tax: 0, total: 0, taxRate: 0.1, discount: 0 });

function recompute() {
  const result = graph.compute(form);
  runInAction(() => Object.assign(form, result)); // 1 MobX transaction, 1 reaction
}
```

### Zustand

```ts
const useStore = create<OrderForm>((set, get) => ({
  ...initialValues,
  update: (patch) => set(graph.compute({ ...get(), ...patch })), // 1 render
}));
```

### React useState

```ts
const [state, setState] = useState(initialValues);
const update = (patch) => setState(prev => graph.compute({ ...prev, ...patch }));
```

### React Hook Form / TanStack Form

```ts
// RHF
watch((values) => reset(graph.compute(values), { keepDirty: true }));

// TanStack
form.store.subscribe(() => form.setValues(graph.compute(form.state.values)));
```

---

## `data-path` Compatibility (Zero Deps)

`data-compute` has **no dependency** on `data-path`. But they share the lambda-proxy philosophy and compose naturally:

```ts
import { path } from "data-path";
import { createGraph } from "data-compute";

// data-path for deep access
const linePath = path<AppState>(p => p.order.lines[idx]);

// data-compute for derived values within a slice
const lineGraph = createGraph<OrderLine>({
  subtotal: (l) => l.quantity * l.unitPrice,
});

// Compose
const currentLine = linePath.get(appState);
const computed = lineGraph.compute({ ...currentLine, ...patch });
const newState = linePath.set(appState, computed);
```

Template paths in `data-compute` (`"lines.*.subtotal"`) use the same `*` / `**` conventions as `data-path` templates, so if users know one, they know both.

---

## Applied Domains & Evolution Roadmap

Here's where it gets interesting. Enjoy the drive — this is the "where could this go" section.

### Tier 1: Core Business (v1 — ship this)

| Domain | Why it fits | Example |
|--------|-------------|---------|
| **Form computation** | The original use case. Every complex form has derived fields | Order totals, insurance quotes, loan calculators |
| **Pricing engines** | `finalPrice ← base × demand × season × loyalty × tax` — pure DAG | E-commerce, SaaS billing, configurators |
| **Dashboard metrics** | `conversionRate = purchases / visits`, cascading from raw counters | Analytics dashboards, KPI boards |
| **Permission graphs** | `canCheckout ← hasItems && isAuth && !isBlocked && quotaOk` | RBAC, feature flags, entitlement engines |
| **Config derivation** | `maxWorkers ← totalMemory / memoryPerWorker` | DevOps tooling, capacity planning |

### Tier 2: Complex State (v2 — async + batching)

| Domain | Why it fits | What's interesting |
|--------|-------------|--------------------|
| **Collaborative forms** | Multiple users editing same entity; conflict resolution at graph level | CRDT-like resolvers per node, not per character |
| **Multi-step wizards** | Step 3 depends on choices in step 1 + async validation in step 2 | Graph naturally models cross-step dependencies; `computeStatus` shows which steps are "resolved" |
| **Financial modeling** | P&L: change revenue → cascade through COGS, margins, taxes, EBITDA, 30+ derived cells | Like a typed spreadsheet engine; the graph IS the model; `trace()` is your audit trail |
| **Insurance/underwriting** | Premium calculation with 40+ factors, some from external APIs, many conditional | Template paths for policy riders; batch API for rate lookups |
| **ERP/inventory** | Available quantity = onHand - reserved - inTransit + incoming | Multiple async sources (warehouse API, logistics API); consistency model prevents selling phantom stock |

### Tier 3: Real-time & Simulation (v3 — ticks + cycles)

| Domain | Why it fits | Graph theory angle |
|--------|-------------|--------------------|
| **Animation engines** | `position(t) = position(t-1) + velocity × dt` — cyclic with freeze mode | This is literally **discrete dynamical systems on graphs**. Each tick advances the system. Springs, easing, physics — all expressible as node formulas with `cyclic: "freeze"` |
| **Game state** | RPG: `attackDmg = (strength + gear) × crit × buffs`, where buffs depend on HP which depends on damage taken | Cyclic graphs with freeze = game tick. The graph IS the game rules engine |
| **Simulation** | Agent-based models, cellular automata, epidemiological models (SIR) | Each agent is a subgraph; template paths = agent populations; ticks = `compute()` calls |
| **Digital twins** | Physical system modeled as a graph; sensor data feeds source nodes; derived nodes predict failure | Async sources (IoT sensors), template paths (multiple identical machines), conflict resolution (sensor disagreement) |
| **Audio/music** | Signal chain: `output = reverb(delay(gain(input, volume), delayMs), roomSize)` | DAG of audio processors. `compute()` per audio buffer. Throttle = buffer size |

### Tier 4: Theoretical & Research (future / papers)

| Concept | Connection to `data-compute` | Why it matters |
|---------|------------------------------|----------------|
| **Incremental computation** (Adapton, self-adjusting computation) | `data-compute`'s "only recompute affected nodes" is a practical implementation of Acar et al.'s self-adjusting computation theory (2002-2006) | Theoretical backing for efficiency claims. You can benchmark against naive full-recompute and show O(affected) vs O(total) |
| **Dataflow programming** (Lustre, Esterel) | Synchronous dataflow languages compile to exactly this: a dependency graph evaluated per tick | `data-compute` is essentially an **embedded dataflow language in TypeScript** |
| **Functional reactive programming** (FRP) | Classic FRP (Conal Elliott, 1997) defines behaviors as time-varying values. `compute()` with ticks IS discrete FRP | Position `data-compute` as "FRP without the monad tax" |
| **Topological sorting + transitive reduction** | The graph engine needs Kahn's algorithm or DFS-based topo sort; transitive reduction optimizes away redundant edges | Benchmark: for a 1000-node graph, topo sort is O(V+E); show that incremental recompute touches only the affected subgraph |
| **Fixed-point computation** | `cyclic: "iterate"` is Kleene's fixed-point theorem applied to finite graphs | Theoretical guarantee: if all node functions are monotone on a lattice, iteration converges. Can detect non-convergence |
| **Graph coloring / partitioning** | Independent subgraphs can compute in parallel (Web Workers) | Future: auto-parallelize independent branches. Graph coloring identifies which nodes can run concurrently |
| **CRDTs on graphs** | Conflict resolution per node is a restricted form of state-based CRDTs | For collaborative scenarios: each node's merge function defines a join-semilattice. If it does, convergence is guaranteed |
| **Differential dataflow** (Naiad, Frank McSherry) | Instead of recomputing values, propagate **deltas** through the graph | Future optimization: `update(prev, { quantity: +5 })` propagates the delta, not the absolute value. O(1) per node in the best case |

### Key insight: efficiency claims you can make

The theoretical work that backs `data-compute`'s efficiency:

1. **Acar's self-adjusting computation** (Cornell, 2005): proves that incremental recomputation over a dependency graph is optimal — you only recompute nodes reachable from changed inputs. `data-compute` implements this directly.

2. **Demers et al. on incremental evaluation** (1981): the foundational paper showing that DAG-based incremental evaluation is O(|affected|) per update, not O(|total|).

3. **Practical benchmark**: for a 200-node pricing graph where 1 source field changes, naive recomputation touches 200 nodes. `data-compute` touches only the ~15 downstream nodes. That's **13× fewer computations**. For async nodes, it's even more dramatic: you avoid re-fetching unchanged async queries entirely.

You can ship a `/benchmarks` folder that demonstrates this with measurable numbers.

---

## Animation / Tick Use Case (Detailed)

Since you asked specifically — yes, `data-compute` can power animation-like systems:

```ts
interface SpringState {
  // Source (updated externally)
  target: number;
  stiffness: number;
  damping: number;
  dt: number;

  // Computed (cyclic with freeze)
  position: number;
  velocity: number;
  acceleration: number;
  isSettled: boolean;
}

const spring = createGraph<SpringState>({
  acceleration: (s) => s.stiffness * (s.target - s.position) - s.damping * s.velocity,
  velocity:     (s) => s.velocity + s.acceleration * s.dt,
  position:     (s) => s.position + s.velocity * s.dt,
  isSettled:    (s) => Math.abs(s.velocity) < 0.01 && Math.abs(s.target - s.position) < 0.01,
}, { cyclic: "freeze" });

// Animation loop
let state: SpringState = { target: 100, stiffness: 200, damping: 10, dt: 0.016,
                           position: 0, velocity: 0, acceleration: 0, isSettled: false };

function tick() {
  state = spring.compute(state);
  element.style.transform = `translateX(${state.position}px)`;
  if (!state.isSettled) requestAnimationFrame(tick);
}
tick();
```

This works because `cyclic: "freeze"` means each `compute()` call reads **previous tick's** values for cyclic nodes, producing the **next tick's** values. It's a discrete-time dynamical system — exactly what animation is.

**Why this matters for positioning:** "data-compute can animate" is a demo that makes people go "wait, really?" — and instantly communicates the power of the graph model.

---

## Full API Surface (Final)

```ts
// ─── Definition ──────────────────────────────────────────
createGraph<T>(
  formulas: GraphFormulas<T>,
  options?: GraphOptions<T>
): Graph<T>

// ─── Computation ─────────────────────────────────────────
graph.compute(state: T): T | Promise<T>
graph.computeStatus(accessor: (x: T) => any): "ready" | "pending" | "stale" | "error"
graph.computeResult(accessor: (x: T) => V): { value: V | undefined; status: Status }

// ─── Introspection ───────────────────────────────────────
graph.nodes: string[]
graph.sources: string[]
graph.order: string[]
graph.hasCycle: boolean
graph.deps(accessor: (x: T) => any): string[]
graph.dependents(accessor: (x: T) => any): string[]
graph.toMermaid(): string
graph.trace(state: T): TraceStep[]

// ─── Options ─────────────────────────────────────────────
interface GraphOptions<T> {
  // Cyclic resolution
  cyclic?: "error" | "freeze"                          // v1
  // cyclic?: "iterate" | "priority"                   // v2

  // Async behavior
  consistency?: "hold-until-ready" | "compute-partial"
  stalePolicy?: "discard" | "discard-and-retry" | "keep"
  batching?: Record<string, BatchConfig>

  // Collections (template paths)
  collections?: Record<string, CollectionConfig>

  // Throttling (at compute trigger level)
  throttle?: { compute: number; strategy: "leading" | "trailing" }

  // Conflict resolution
  conflicts?: {
    strategy: "last-write-wins" | "custom"
    resolvers?: Partial<Record<keyof T, ConflictResolver>>
  }

  // Interceptors
  interceptors?: Interceptor<T>[]
  onError?: (node: string, error: Error) => void
}
```

---

## What Ships When

| v1 | v2 | v3 (demand-driven) |
|----|----|----|
| `createGraph` + `compute()` | Async batching + `ctx.batch()` | CRDT-like conflict resolvers |
| Proxy-based dep tracking | `stalePolicy` (race protection) | Graph partitioning / parallel compute |
| `computeStatus` / `computeResult` | Template paths (`lines.*.subtotal`) | Differential dataflow (delta propagation) |
| `"error"` + `"freeze"` cyclic | Collection config (add/remove/reorder items) | `"iterate"` / `"priority"` cyclic modes |
| `clamp`, `validate`, `log` interceptors | Throttle at compute level | DevTools UI (visual graph explorer) |
| `toMermaid()`, `trace()` | `consistency: "hold-until-ready"` | `data-path` deep integration package |
| State layer examples (MobX/Zustand/RHF/TanStack) | Benchmark suite | |

---

## The One-Line Pitch

> **`data-compute`** — typed computation graphs from plain lambdas. Handles async batching, stale responses, and index shifts so your derived state is always consistent.

Have a good drive! 🚗
