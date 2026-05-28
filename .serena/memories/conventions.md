# Conventions

- Keep public API in `src/index.ts` as explicit exports/re-exports; implementation modules use `.js` extension in relative imports for NodeNext compatibility.
- Formulas and data-source deps use `(state, root)` signatures; root-level formulas pass root for both args, `each()` formulas pass item and root.
- Deep node paths are dotted strings; array templates use `*` (`items.*.price`). Normalize runtime numeric indices before graph dependency work.
- Dependency extraction is static at graph construction by running formulas/deps against `dryRunProxy`; runtime dependency tracking is separate (`trackingProxy`, `trace`).
- `compute()` returns granular patches, not full snapshots; avoid leaking `getState()` base-only fields into returned/setState patches.
- Multiple synchronous `compute()` calls coalesce in one microtask and resolve to the same coalesced patch promise.
- Stale handling relies on monotonic `version`; async/batch code must check staleness after awaits and avoid mutating stale results.
- Tests live near implementation under `src/tests/<module>/*.spec.ts`; public type behavior belongs in `src/tests/types.test-d.ts`.