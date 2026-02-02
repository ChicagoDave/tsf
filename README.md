# tsf

Multi-target TypeScript build tool for monorepos.

Compiles one TypeScript source into multiple output targets with per-target import resolution, module format, and declaration handling.

## The Problem

TypeScript monorepos need different builds for different consumers:
- **Local development**: workspace imports (`@scope/pkg`) resolved via symlinks
- **npm publish**: workspace imports rewritten to relative paths or peer dependencies
- **Bundling**: all imports resolved and inlined into a single file
- **Browser**: ESM output with bundled or mapped imports

No existing tool handles the full matrix. tsf does.

## Install

```bash
pnpm add -D tsf
# or
npm install -D tsf
```

## Quick Start

```bash
tsf init          # Generate ts-forge.config.json from existing project
tsf build         # Build default target
tsf build --all   # Build all targets
tsf version 1.0.0 --condition publish  # Set version on npm packages
tsf info          # Show resolved build plan
```

## Configuration

`ts-forge.config.json`:

```json
{
  "projects": ["packages/*/tsconfig.json"],
  "targets": {
    "local": {
      "module": "commonjs",
      "outDir": "dist",
      "imports": "preserve",
      "declarations": true
    },
    "npm": {
      "module": "commonjs",
      "outDir": "dist-npm",
      "imports": "relative",
      "declarations": true,
      "condition": "publish"
    }
  }
}
```

### Target Options

| Option | Description |
|---|---|
| `module` | Output module format: `commonjs`, `esnext`, `es2020`, `es2022`, `node16`, `nodenext` |
| `format` | Bundler format: `cjs`, `esm`, `iife`, `umd` |
| `outDir` | Output directory (relative to each package) |
| `outFile` | Single output file (alternative to outDir) |
| `imports` | Import resolution strategy (see below) |
| `declarations` | Generate `.d.ts` files |
| `condition` | Conditional target — `"publish"` only applies to packages with `publishConfig` |
| `transpiler` | Compiler: `tsc` (default), `esbuild`, `swc` |
| `bundler` | Bundler: `esbuild`, `rollup` (requires `imports: "bundle"`) |
| `banner` | Prepend to output (e.g., `"#!/usr/bin/env node"` for CLI tools) |
| `external` | Dependencies to exclude from bundling |

### Per-Package Overrides

Add `ts-forge.json` in any package directory:

```json
{
  "targets": {
    "local": { "skip": true }
  }
}
```

## Import Resolution Strategies

| Strategy | Use Case | What Happens |
|---|---|---|
| `preserve` | Local dev | Imports left as-is |
| `relative` | npm publish | `@scope/pkg` → relative paths |
| `bundle` | Browser/CLI | All imports inlined |
| `specifier-map` | Deno | Rewritten per import map |

## Commands

### `tsf build [options]`

Build targets across all packages in dependency order.

```bash
tsf build                       # Build default (unconditional) targets
tsf build --all                 # Build all targets
tsf build --target npm          # Build specific target
tsf build --condition publish   # Build targets matching condition
tsf build --all --clean         # Clean output dirs first
tsf build --all --no-check      # Skip type checking
tsf build --watch               # Watch mode
tsf build --parallel 4          # Limit concurrency
tsf build --all --sync-package-json  # Sync package.json after build
```

### `tsf check`

Type-check all projects without emitting.

### `tsf info`

Display the resolved build plan: packages, dependency order, and targets with per-target package counts.

### `tsf init`

Generate `ts-forge.config.json` by detecting existing project structure. Reads `package.json`, `tsconfig.json`, and workspace configuration. Safe to re-run — merges new targets without overwriting existing config.

### `tsf sync`

Generate `main`, `types`, and `exports` fields in each package's `package.json` from target configuration. Preserves all other fields. Publish-conditioned targets are preferred for field values.

### `tsf validate`

Verify build outputs:
- Entry points declared in `package.json` exist on disk
- Declaration files (`.d.ts`) exist alongside JavaScript files
- No workspace specifiers (`@scope/pkg`) leaked into non-preserve output

Exit code 1 if any errors found.

### `tsf version <version> | --bump <level> [options]`

Set or bump `version` in `package.json` for workspace packages.

```bash
tsf version 0.9.64-beta                     # Set all packages to explicit version
tsf version 0.9.64-beta --condition publish  # Only npm-published packages
tsf version --bump patch                     # Increment patch version
tsf version --bump prerelease --preid beta   # Bump prerelease suffix
tsf version 0.9.64-beta --filter @scope/pkg  # Specific package(s)
tsf version 0.9.64-beta --dry-run           # Preview without writing
```

| Option | Description |
|---|---|
| `<version>` | Explicit version string (mutually exclusive with `--bump`) |
| `--bump <level>` | Semver increment: `major`, `minor`, `patch`, `prerelease` |
| `--preid <tag>` | Prerelease identifier (default: `beta`) |
| `--condition <name>` | Only packages matching target condition (e.g., `publish`) |
| `--filter <name>` | Restrict to specific package(s), repeatable |
| `--dry-run` | Show changes without writing |

### `tsf gh-action`

Generate `.github/workflows/tsf.yml` with auto-detected package manager setup and Node.js version matrix.

## Workspace Support

tsf detects pnpm, npm, and yarn workspaces. It respects `pnpm-workspace.yaml` exclusion patterns (e.g., `!packages/forge`).

### Publish Target Scoping

Targets with `condition: "publish"` automatically apply only to packages that have `publishConfig` in their `package.json`. Other packages are skipped.

```
$ tsf info
Targets:
  local: commonjs → dist, imports=preserve
  npm: commonjs → dist-npm, imports=relative [condition: publish] (18 packages)
```

## Caching

tsf caches builds based on source content, target config, and dependency cache keys. Unchanged packages are skipped on subsequent builds. Use `--clean` to bypass the cache. Cache is stored in `.tsf-cache/` at the workspace root.

## Development

```bash
pnpm install
pnpm build
pnpm test
```

## License

MIT
