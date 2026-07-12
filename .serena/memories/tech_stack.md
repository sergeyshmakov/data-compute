# Tech Stack

- TypeScript library, ESM package (`"type": "module"`) with CJS+ESM+DTS build output via `tsup`.
- Node engine `>=20`; Volta pins Node `24.14.0`.
- TS config: `module`/`moduleResolution` = `NodeNext`, target `ES2022`, `strict: true`.
- Testing: Vitest 4, includes runtime specs under `src/tests/**/*.spec.ts` plus type tests under `src/tests/**/*.test-d.ts` via Vitest typecheck.
- Formatting/linting: Biome 2.4.6, tab indentation, double quotes, recommended lint rules; `useArrowFunction` disabled.
- Release tooling: semantic-release, Conventional Commits, Husky + lint-staged hooks.
- Docs site has separate `docs/package.json` and `docs/tsconfig.json`.