# Contributing

## Before you start

**Bugs and typos:** open a pull request directly.

**New features and significant changes:** open an issue first. Features need to fit the scope of the project and use an approach we agree on before significant implementation work begins.

## Local development

```bash
git clone https://github.com/sergeyshmakov/data-compute.git
cd data-compute
npm ci
npm run dev          # watch mode — rebuilds on save
npm test             # run tests and type checks
```

## Code style

[Biome](https://biomejs.dev/) handles formatting and linting. The pre-commit hook runs automatically on `git commit`. To run it manually:

```bash
npm run lint:fix
```

## Commits

This project uses [Conventional Commits](https://www.conventionalcommits.org/). The commit prefix determines the version bump:

| Prefix | Release |
|--------|---------|
| `feat:` | Minor (0.2.0) |
| `fix:` | Patch (0.1.1) |
| `docs:`, `chore:`, `test:` | No release |

Breaking changes use `feat!:` or a `BREAKING CHANGE:` footer in the commit body.

The commit message format is validated on commit. If the format is wrong, the commit is rejected with a helpful message.

## Release

Merging to `main` triggers the publish workflow.

The first release is published manually from `package.json` so the package starts in the 0.x line instead of semantic-release's default first release of `1.0.0`. Publish the current package version (`0.1.0`) first. On the next workflow run, CI verifies that `data-compute@0.1.0` exists on npm and creates the matching `v0.1.0` tag.

The npm package should be configured for trusted publishing from `.github/workflows/publish.yml`; the workflow has `id-token: write` permission for npm provenance.

After that tag exists, `semantic-release` takes over: it determines future versions from commit history, updates `CHANGELOG.md`, publishes to npm, commits the changelog/version metadata, and creates GitHub releases. No manual version bumps or changelog edits are needed after the bootstrap.

## Code of Conduct

By participating you agree to abide by the [Code of Conduct](.github/CODE_OF_CONDUCT.md).
