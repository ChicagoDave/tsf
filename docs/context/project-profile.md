# Project Profile

**Generated**: 2026-07-25
**Repository**: tsf (@davidcornelson/tsf)

## Domains

- CLI / Tooling — `src/cli/` with `bin.tsf` entry (`dist/cli/index.js`), subcommands for detect/init/list/publish/version/changed/gh-action
- Library / Package — published to npm as `@davidcornelson/tsf`, `main`/`types` exports in `package.json`, `src/index.ts` barrel
- Build Tooling / Compiler Orchestration — `src/compilers/` (tsc, esbuild, rollup adapters), `src/orchestrator/` (dependency ordering, parallel scheduling), `src/transform/` (import and `.d.ts` rewriting) — this is the project's core domain, not one of the standard template categories
- Data Storage (lightweight, file-based) — `src/cache/` reads/writes JSON build-cache entries to disk (`.tsf-cache/`); no database or ORM

## Tech Stack

- **Language**: TypeScript (target ES2022)
- **Runtime**: Node.js >=18
- **Framework**: None (CLI/library — no web framework)
- **Data layer**: None (filesystem-based JSON cache in `src/cache/index.ts`, no DB/ORM)
- **Messaging**: None
- **Test framework**: Vitest (`vitest.config.ts`, `fileParallelism: false`, 30s test timeout)
- **Build tool**: tsc (project's own `tsf` config also self-hosts via `ts-forge.config.json`); esbuild and rollup used as pluggable compiler/bundler backends
- **Package manager**: pnpm (`pnpm-workspace.yaml`, `pnpm-lock.yaml`)
- **CI/CD**: None detected (`.github/workflows/` absent) — though the tool itself generates GitHub Actions workflows for consumers via `src/cli/gh-action.ts`
- **Monorepo**: No (single-package repo); the tool itself is designed to build *other* monorepos, and `tests/fixture/` contains a synthetic pnpm workspace fixture used for integration tests

## Conventions

- **Test location**: Separate top-level `tests/` directory (not co-located with `src/`)
- **Test naming**: `*.test.ts` (e.g., `resolver.test.ts`, `integration.test.ts`, `integration-phase4.test.ts`)
- **Source structure**: Layer/feature-based by pipeline stage — `cli/`, `config/`, `resolver/`, `orchestrator/`, `compilers/`, `transform/`, `cache/`, `sync/`, `validate/`, `watcher/`, `utils/`
- **TypeScript strict mode**: Yes — `strict: true` in `tsconfig.json` (also `esModuleInterop`, `forceConsistentCasingInFileNames`, `skipLibCheck`)
- **Import style**: CommonJS output (`module: commonjs`); source uses ES module `import`/`export` syntax compiled by tsc
- **Documentation style**: JSDoc `@fileoverview`/`@module` header comments on source files (see `src/resolver/workspace.ts`), consistent with CLAUDE.md's documentation standard

## Mutation Signatures

### Build Tooling / Compiler Orchestration
- **Mutation calls**: `fs.writeFileSync`, `fs.mkdirSync(..., { recursive: true })`, `fs.rmSync(..., { recursive: true })` — found in `src/compilers/tsc.ts`, `src/compilers/esbuild-bundler.ts`, `src/compilers/rollup-bundler.ts`, `src/orchestrator/index.ts`, `src/transform/imports.ts`, `src/transform/declarations.ts`
- **Reporting without mutation**: A compiler/transform/orchestrator function that logs "built", "transformed", or "wrote N files" without a corresponding `fs.writeFileSync`/`fs.mkdirSync`/`fs.rmSync` call on the actual output path
- **Test assertions — verify**: Test reads the emitted file from disk (or the `tests/fixture/` output tree) after the call and asserts on its actual contents — e.g., rewritten import paths in `.js` output, correct `.d.ts` declaration content, cache JSON shape in `.tsf-cache/`
- **Test assertions — insufficient**: Asserting only that the compiler function returned a success object/exit code without reading back the written file; asserting a mock/stub compiler was "called" without checking real file output

### CLI / Tooling
- **Mutation calls**: `fs.writeFileSync` on `ts-forge.config.json` (`src/cli/init.ts`), `package.json` (`src/cli/version.ts`, `src/sync/package-json.ts`), and generated workflow YAML (`src/cli/gh-action.ts`)
- **Reporting without mutation**: CLI command prints a success message ("Initialized config", "Bumped version") without the target file actually changing on disk
- **Test assertions — verify**: Test invokes the CLI command (or its underlying function) against a temp/fixture directory and re-reads the resulting file to assert on its new content (e.g., `tests/init.test.ts`, `tests/gh-action.test.ts`, `tests/sync.test.ts`)
- **Test assertions — insufficient**: Asserting only on captured stdout/console output or a returned string, without confirming the file on disk was actually created/modified

### Data Storage (file-based cache)
- **Mutation calls**: `src/cache/index.ts` — `fs.mkdirSync` + `fs.writeFileSync` to persist cache entries, `fs.rmSync` to clear the cache dir
- **Reporting without mutation**: Cache "hit"/"miss" logic that never writes an updated entry back after a build, or a `clean`/`invalidate` path that claims to clear the cache without `fs.rmSync` on `.tsf-cache/`
- **Test assertions — verify**: Test reads back `.tsf-cache/<mode>/<pkg>/cache.json` after a cache-write operation and asserts on its structure/content (see `tests/cache.test.ts`, `tests/fixture/.tsf-cache/`)
- **Test assertions — insufficient**: Asserting only the in-memory cache object without confirming the on-disk JSON file was written or removed

## Notes

- tsf is a build-tool-for-build-tools: it does not fit neatly into the standard web/service domain template. Its core value proposition (per `CLAUDE.md`) is rewriting `@scope/package` workspace imports to relative paths for npm publish while preserving them for local dev — this is the central mutation to watch across `src/transform/imports.ts` and `src/sync/package-json.ts`.
- The repo self-hosts: it uses its own `ts-forge.config.json` to build itself (`targets.cli` bundles the CLI entry with esbuild and a `#!/usr/bin/env node` banner).
- `tests/fixture/` contains a full synthetic pnpm workspace (two packages, `app` and `core`, with prebuilt `dist/` and `.tsf-cache/`) used as a stable integration-test target — treat changes to fixture output shape as a signal to check `tests/integration.test.ts` and `tests/integration-phase4.test.ts`.
- No lint/format config (ESLint/Prettier/Biome) was found — style is currently unenforced by tooling.
- No CI pipeline exists in this repo yet, though the tool generates GitHub Actions workflows for its *consumers* (`src/cli/gh-action.ts`, `tests/gh-action.test.ts`).
- An `extensions/` directory exists at the repo root (VS Code extension per `docs/architecture/001-vscode-extension.md`) but was not deep-scanned here — worth a follow-up profile note if that becomes an active workstream.
