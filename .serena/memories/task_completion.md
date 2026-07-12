# Task Completion

- For code changes, normally run:
  - `npm run typecheck`
  - `npm run lint`
  - `npm test`
- Run `npm run build` when exports, package output, declarations, or build config may be affected.
- Prefer focused Vitest specs during iteration, then full `npm test` before final when feasible.
- If onboarding/memories were touched, user can run `serena memories check` from the project root.