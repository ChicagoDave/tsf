# Architecture: Multi-Target TypeScript Build Tool

## Problem Statement

TypeScript monorepos with multiple consumers face a build target matrix that no existing tool handles completely:

| Consumer | Module Format | Import Resolution | Output |
|---|---|---|---|
| Local workspace (tsc) | CJS or ESM | `@scope/pkg` → workspace symlink | `dist/` |
| esbuild/webpack bundle | Any (bundled) | Resolved at bundle time | Single file |
| Browser client | ESM | Relative or bundled | `dist/web/` |
| npm publish | CJS, ESM, or dual | `@scope/pkg` → npm registry | `dist-npm/` |
| Deno / edge runtime | ESM | URL or specifier map | `dist-deno/` |

**The core tension**: a single `tsc` invocation produces one module format with one import resolution strategy. Every additional consumer requires either a separate build, a post-processing step, or a hack.

### What Exists Today

| Tool | Strengths | Gaps |
|---|---|---|
| `tsc` | Type checking, declaration emit | Single target per invocation |
| `tsc-multi` | Parallel multi-target tsc | Rewrites extensions, not package specifiers |
| `tsup` | Fast bundling, dual CJS/ESM | Bundles (loses internal package boundaries), no monorepo-aware import rewriting |
| `tshy` | Dual CJS/ESM with live dev | Single-package focus, no cross-package import rewriting |
| `unbuild` | Auto-infers config, dual output | No monorepo import resolution |
| `publishConfig` (pnpm) | Swaps entry points at publish | Doesn't solve the build itself |

**None of these rewrite `@scope/package` imports to relative paths for npm publish while preserving them for local development.** This is the gap.

## Design Goals

1. **One source, N outputs** — define targets declaratively; the tool builds all of them
2. **Import resolution per target** — workspace imports stay as `@scope/pkg` for local dev, get rewritten to relative paths (or bundled) for npm publish
3. **Type declarations per target** — `.d.ts` files with correct import paths for each target
4. **Monorepo-aware** — understands workspace topology, builds in dependency order
5. **Incremental** — only rebuilds what changed (per-target cache)
6. **No lock-in** — uses standard `tsconfig.json`, augmented by a small config file
7. **Fast** — uses `esbuild` or `swc` for transpilation where type checking isn't needed

## Configuration

### `tsf.config.json` (project root)

```json
{
  "$schema": "https://ts-forge.dev/schema.json",
  "projects": ["packages/*/tsconfig.json", "stories/*/tsconfig.json"],
  "targets": {
    "local": {
      "module": "commonjs",
      "outDir": "dist",
      "imports": "preserve",
      "declarations": true
    },
    "npm-cjs": {
      "module": "commonjs",
      "outDir": "dist-npm",
      "imports": "relative",
      "declarations": true,
      "condition": "publish"
    },
    "npm-esm": {
      "module": "esnext",
      "outDir": "dist-esm",
      "imports": "relative",
      "declarations": true,
      "extensionMap": { ".js": ".mjs", ".d.ts": ".d.mts" },
      "condition": "publish"
    },
    "bundle": {
      "format": "iife",
      "outFile": "dist/bundle.js",
      "imports": "bundle",
      "bundler": "esbuild",
      "external": [],
      "condition": "browser"
    }
  },
  "defaults": {
    "transpiler": "tsc",
    "typeCheck": true,
    "sourceMap": true,
    "clean": false
  }
}
```

### Per-Package Override (`packages/core/tsf.json`)

```json
{
  "targets": {
    "npm-cjs": {
      "banner": "/* @sharpee/core v${version} */",
      "external": ["lz-string"]
    }
  }
}
```

## Core Concepts

### Import Resolution Strategies

The key differentiator. Each target specifies how `@scope/pkg` imports are handled:

#### `"preserve"` (default, local dev)

Imports left as-is. Workspace symlinks or `node_modules` handle resolution at runtime.

```typescript
// Source
import { WorldModel } from '@sharpee/world-model';

// Output (unchanged)
import { WorldModel } from '@sharpee/world-model';
```

#### `"relative"`  (npm publish)

Workspace imports rewritten to relative paths based on the monorepo topology. The tool resolves `@sharpee/world-model` → `../../world-model/dist-npm/index.js` (or the target's outDir).

```typescript
// Source
import { WorldModel } from '@sharpee/world-model';

// Output (rewritten for npm)
import { WorldModel } from '../../world-model/dist-npm/index.js';
```

For npm packages that will be installed flat in `node_modules`, the strategy can also rewrite to bare specifiers that assume peer/dependency installation:

```json
{
  "imports": "relative",
  "relativeMode": "peer"
}
```

```typescript
// Output (assumes @sharpee/world-model installed as dependency)
import { WorldModel } from '@sharpee/world-model';
// But .d.ts paths are rewritten to resolve correctly
```

#### `"bundle"` (browser/CLI bundle)

All workspace imports are resolved and inlined by the bundler. No import statements remain for workspace packages.

#### `"specifier-map"` (Deno / import maps)

Imports rewritten according to a provided import map.

```json
{
  "imports": "specifier-map",
  "importMap": "./import_map.json"
}
```

### Declaration Handling

Type declarations (`.d.ts`) need the same import rewriting as runtime code. This is the part most tools get wrong.

For each target with `"declarations": true`:
1. Run `tsc --emitDeclarationOnly` (or reuse from a type-check pass)
2. Apply the same import resolution transform to `.d.ts` files
3. Apply extension mapping (`.d.ts` → `.d.mts` for ESM targets)

### IDE Support: BUILD vs EDITOR Mode

ts-forge operates in two distinct modes that govern how tsconfig files and import resolution are presented to consumers.

#### The Problem

IDEs run `tsserver` continuously. tsserver reads `tsconfig.json` to resolve imports, provide completions, power go-to-definition, and report errors. During a build, ts-forge overrides `paths`, changes `outDir`, and may generate temporary tsconfig overlays (see Resolved Question 2). If these overlays leak into the IDE's view — or if ts-forge's workspace `paths` stripping breaks tsserver resolution — the developer sees red squiggles, broken navigation, and phantom errors.

The fundamental tension: **the IDE needs a stable, source-pointing tsconfig at all times**, while ts-forge needs per-target output-pointing configs during builds.

#### Two Modes

**EDITOR mode** (default when no build is running):
- The user's `tsconfig.json` files are authoritative. ts-forge does not touch them.
- Workspace `paths` entries point at **source** (`../core/src/index.ts`), giving the IDE go-to-definition into `.ts` files, live type checking across packages, and accurate completions.
- If workspace `paths` are missing (e.g., the project relies on pnpm symlinks alone), ts-forge can generate them: `ts-forge init --editor` writes a `tsconfig.json` with correct `paths` for IDE resolution.
- No temporary overlays exist on disk.

**BUILD mode** (during `ts-forge build`):
- ts-forge generates temporary tsconfig overlays in `.ts-forge-tmp/` (gitignored).
- These overlays strip workspace `paths` (ts-forge handles resolution via the import transformer) and set per-target `outDir`, `module`, etc.
- Overlays are passed to tsc/esbuild/swc via `--project` or equivalent.
- Overlays are cleaned up after the build completes (or on `SIGINT`).

The user's `tsconfig.json` files are **never modified** by either mode.

#### How It Works in Practice

```
Developer editing in VS Code
  └─ tsserver reads tsconfig.json (EDITOR mode)
       └─ paths: { "@sharpee/core": ["../core/src/index.ts"] }
       └─ Go-to-definition → lands on source .ts files ✓
       └─ Autocomplete from workspace packages ✓
       └─ Errors reflect real type issues ✓

Developer runs: ts-forge build
  └─ ts-forge enters BUILD mode
       └─ Generates .ts-forge-tmp/npm-cjs/packages/core/tsconfig.json
            └─ extends user tsconfig
            └─ strips workspace paths
            └─ sets outDir, module format for target
       └─ Invokes tsc --project .ts-forge-tmp/...
       └─ Runs import transformer on output
       └─ Cleans up .ts-forge-tmp/
  └─ tsserver is unaffected (still reading original tsconfig.json)
```

#### `ts-forge init --editor`

For projects that don't yet have workspace `paths` configured (relying on symlinks alone), this command generates the correct `paths` entries by reading the workspace topology:

```bash
ts-forge init --editor
```

This updates each package's `tsconfig.json` to add `paths` entries for its workspace dependencies, pointing at source entry points. It's idempotent — running it again updates entries if the workspace topology changed.

```json
// Generated paths in packages/engine/tsconfig.json
{
  "compilerOptions": {
    "paths": {
      "@sharpee/core": ["../core/src/index.ts"],
      "@sharpee/core/*": ["../core/src/*"],
      "@sharpee/world-model": ["../world-model/src/index.ts"],
      "@sharpee/world-model/*": ["../world-model/src/*"]
    }
  }
}
```

#### Watch Mode Interaction

`ts-forge build --watch` stays in BUILD mode continuously but still doesn't touch the user's tsconfig files. The temporary overlays persist for the duration of the watch session. If the IDE and watch mode run simultaneously (the common case), they see different configs:

- IDE → user's `tsconfig.json` → source-pointing paths → full intellisense
- ts-forge watch → `.ts-forge-tmp/` overlays → per-target output

This is the correct separation. The IDE shows the developer's view of the code; ts-forge produces the consumer's view of the output.

#### Explicit Mode Switch

For tooling that needs to programmatically know which mode is active (e.g., custom scripts, CI checks):

```typescript
// ts-forge API
import { getMode } from 'ts-forge';

getMode(); // 'editor' | 'build'
```

```bash
# CLI
ts-forge info --mode  # prints "editor" or "build"
```

This is primarily useful for monorepo tooling scripts that need to behave differently depending on whether a build is in flight.

### Build Order

The tool reads `references` from `tsconfig.json` (or infers from workspace `dependencies`) to determine build order. Within a dependency level, packages build in parallel.

```
Level 0: core
Level 1: if-domain, world-model (depend on core)
Level 2: stdlib, parser-en-us (depend on world-model)
Level 3: engine (depends on stdlib)
Level 4: stories (depend on engine)
```

Each level builds all its packages in parallel, for all targets in parallel.

### Incremental Builds

Per-target file hashes stored in `.tsf-cache/`:

```
.tsf-cache/
  local/
    packages/core/hash.json
    packages/world-model/hash.json
  npm-cjs/
    packages/core/hash.json
```

A package+target is skipped if:
- All source file hashes match
- All dependency output hashes match
- The target config hasn't changed

### Conditional Targets

Targets with `"condition"` only build when explicitly requested:

```bash
# Build only local target (default)
ts-forge build

# Build local + npm targets
ts-forge build --condition publish

# Build everything
ts-forge build --all

# Build specific target
ts-forge build --target npm-esm
```

### Type Checking Strategy

Type checking is slow. The tool separates it from transpilation:

```bash
# Full type check + build (CI)
ts-forge build --check

# Transpile only (fast iteration)
ts-forge build --no-check

# Type check without emitting
ts-forge check
```

When `--no-check` is used, the tool uses `esbuild` or `swc` for transpilation (configurable via `"transpiler"`), skipping tsc entirely for speed.

## CLI Interface

```
ts-forge build [options]
  --target <name>       Build specific target(s), comma-separated
  --condition <name>    Build targets matching condition
  --all                 Build all targets
  --check / --no-check  Enable/disable type checking
  --watch               Watch mode
  --clean               Remove output dirs before build
  --verbose             Show detailed output
  --parallel <n>        Max parallel builds (default: CPU count)

ts-forge check
  Run type checking only (no emit)

ts-forge init
  Generate tsf.config.json from existing tsconfig.json files

ts-forge info
  Show resolved build plan (dependency order, targets, paths)
```

## Architecture

### Components

```
┌─────────────────────────────────────────────────┐
│                   CLI Layer                       │
│  (argument parsing, config loading, reporting)    │
├─────────────────────────────────────────────────┤
│                  Orchestrator                     │
│  (dependency graph, parallel scheduling,          │
│   incremental cache, condition filtering)         │
├──────────┬──────────┬──────────┬────────────────┤
│ TSC      │ esbuild  │ SWC      │ Rollup         │
│ Compiler │ Compiler │ Compiler │ Bundler        │
│ Adapter  │ Adapter  │ Adapter  │ Adapter        │
├──────────┴──────────┴──────────┴────────────────┤
│              Import Transformer                   │
│  (AST-based import path rewriting per target)     │
├─────────────────────────────────────────────────┤
│           Declaration Transformer                 │
│  (same rewriting applied to .d.ts files)          │
├─────────────────────────────────────────────────┤
│            Workspace Resolver                     │
│  (reads pnpm/yarn/npm workspace topology,         │
│   resolves @scope/pkg → filesystem paths)         │
└─────────────────────────────────────────────────┘
```

### Import Transformer (the hard part)

Uses `ts.transform()` or a lightweight AST parser to rewrite import/export specifiers:

```typescript
interface ImportTransformer {
  // Given a source file path and an import specifier, return the rewritten specifier
  rewrite(
    sourceFile: string,
    specifier: string,
    target: TargetConfig
  ): string;
}
```

For `"relative"` mode, the transformer:
1. Checks if specifier matches a workspace package name
2. Resolves that package's output path for this target
3. Computes the relative path from source to resolved output
4. Rewrites the specifier

For `.d.ts` files, the same logic applies but the transformer also handles:
- `/// <reference types="..." />` directives
- `declare module "..."` blocks
- `import type` statements

### Workspace Resolver

Reads workspace config to build a package graph:

```typescript
interface WorkspaceResolver {
  // All packages in the workspace
  packages: Map<string, PackageInfo>;

  // Resolve a bare specifier to a filesystem path
  resolve(specifier: string, fromPackage: string): string | null;

  // Get dependency order for building
  getBuildOrder(): string[][];  // Array of parallel levels
}

interface PackageInfo {
  name: string;           // "@sharpee/world-model"
  path: string;           // "packages/world-model"
  tsconfig: string;       // "packages/world-model/tsconfig.json"
  dependencies: string[]; // ["@sharpee/core"]
  entryPoint: string;     // "src/index.ts"
  outDirs: Map<string, string>;  // target → output dir
}
```

## Integration with package.json

The tool can optionally update `package.json` fields to match target outputs:

```json
{
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist-esm/index.mjs",
      "require": "./dist/index.js"
    }
  },
  "publishConfig": {
    "main": "dist-npm/index.js",
    "types": "dist-npm/index.d.ts",
    "exports": {
      ".": {
        "types": "./dist-npm/index.d.ts",
        "import": "./dist-esm/index.mjs",
        "require": "./dist-npm/index.js"
      }
    }
  }
}
```

Running `ts-forge init --sync-package-json` generates these fields from the config.

## Scenarios

### Scenario 1: Sharpee (the motivating case)

**Targets needed:**
- `local` — CJS, workspace imports preserved, for story `tsc` and local testing
- `npm` — CJS, workspace imports as peer dependencies, for npm publish
- `bundle` — single-file IIFE/CJS, all workspace imports bundled, for CLI (`dist/sharpee.js`)
- `browser` — ESM bundle, for web client

**Config:**
```json
{
  "projects": ["packages/*/tsconfig.json"],
  "targets": {
    "local": { "module": "commonjs", "outDir": "dist", "imports": "preserve" },
    "npm": { "module": "commonjs", "outDir": "dist-npm", "imports": "relative", "condition": "publish" },
    "bundle": { "format": "cjs", "outFile": "dist/sharpee.js", "imports": "bundle", "bundler": "esbuild", "condition": "bundle" },
    "browser": { "format": "esm", "outDir": "dist/web", "imports": "bundle", "bundler": "esbuild", "condition": "browser" }
  }
}
```

### Scenario 2: Typical OSS Library (dual CJS/ESM)

```json
{
  "projects": ["tsconfig.json"],
  "targets": {
    "cjs": { "module": "commonjs", "outDir": "dist/cjs", "declarations": true },
    "esm": { "module": "esnext", "outDir": "dist/esm", "extensionMap": { ".js": ".mjs", ".d.ts": ".d.mts" }, "declarations": true }
  }
}
```

### Scenario 3: Full-Stack App (Next.js + Lambda)

```json
{
  "projects": ["packages/*/tsconfig.json"],
  "targets": {
    "local": { "module": "esnext", "outDir": "dist", "imports": "preserve" },
    "lambda": { "module": "commonjs", "outDir": "dist-lambda", "imports": "bundle", "bundler": "esbuild", "target": "node18", "condition": "deploy" }
  }
}
```

### Scenario 4: Library with Deno Support

```json
{
  "projects": ["tsconfig.json"],
  "targets": {
    "npm": { "module": "esnext", "outDir": "dist", "imports": "preserve" },
    "deno": { "module": "esnext", "outDir": "dist-deno", "imports": "specifier-map", "importMap": "import_map.json", "extensionMap": { ".js": ".ts" }, "condition": "deno" }
  }
}
```

## Implementation Plan

### Phase 1: Core (MVP) ✅

1. ✅ Config parser and validator
2. ✅ Workspace resolver (pnpm) — npm/yarn detection planned
3. ✅ Build orchestrator with dependency ordering
4. ✅ TSC compiler adapter (including rootDir widening + output flattening)
5. ✅ Import transformer (`preserve` and `relative` modes)
6. ✅ Declaration transformer
7. ✅ CLI with `build`, `info` — `check` and `init` planned
8. ✅ Test suite (9 unit + 8 integration tests, all passing)

### Phase 2: Performance ✅

9. ✅ Incremental cache (per-package-per-target, SHA-256 content hashing, dependency cascade)
10. ✅ esbuild transpiler adapter (transpile + separate tsc declaration emit, lazy-loaded)
11. ✅ Parallel builds within dependency level (Promise.all with configurable concurrency via `--parallel`)
12. ✅ Watch mode (fs.watch recursive, debounced, dependency-aware rebuild)

### Phase 3: Bundling

13. esbuild bundler adapter (`bundle` import mode)
14. Rollup bundler adapter (tree shaking)
15. `outFile` support for single-file output

### Phase 4: Ecosystem

16. `ts-forge init` auto-detection from existing configs
17. `--sync-package-json` to update package.json fields
18. Validation (like publint) to verify outputs are correct
19. GitHub Action for CI integration

## Resolved Questions

### 1. Type Checking: Delegate to `tsc`, Don't Own It

**Decision: Delegate type checking to `tsc --noEmit` (or the user's existing `tsc` setup).**

ts-forge is a build orchestrator and import transformer, not a type checker. Owning type checking would mean:

- Maintaining a `ts.Program` per target with modified compiler options — significant API surface to get right
- Handling `tsconfig.json` inheritance, `extends`, `references`, and `composite` projects exactly as `tsc` does
- Tracking TypeScript version updates and behavioral changes across releases
- Diagnosing and reporting errors with the same fidelity as `tsc` output (codeframes, related spans, suggestion diagnostics)

The per-target diagnostics argument (e.g., catching ESM-only errors in an ESM target) is real but narrow. In practice:

- **Most type errors are target-independent.** A missing property, a type mismatch, or an unresolved import are the same regardless of module format.
- **ESM-specific errors** (top-level `await` in CJS, `import.meta` usage, `require()` in ESM) are better caught by linting rules (e.g., `eslint-plugin-import`) or by the transpiler itself failing.
- **Module resolution differences** between targets are handled by ts-forge's import transformer, not by type checking — the source code always uses the same specifiers.

**How it works in practice:**

```bash
# User's existing workflow — unchanged
tsc --noEmit                    # or tsc -b --noEmit for project references

# ts-forge only orchestrates builds
ts-forge build                  # transpile + transform, no type checking
ts-forge build --check          # runs tsc --noEmit first, then builds
ts-forge check                  # convenience alias for tsc --noEmit with the right config
```

`ts-forge check` and `--check` are thin wrappers: they spawn `tsc --noEmit` (or `tsc -b --noEmit` for composite projects) using the project's own tsconfig, then proceed with the build if it passes. ts-forge never creates its own `ts.Program`.

For transpilation, when `--no-check` is used (the fast path), ts-forge uses esbuild or swc which strip types without checking them. When type checking is wanted, tsc handles it as a separate pass.

**Future door left open:** If per-target diagnostics become critical (e.g., a target sets `"target": "es5"` and users want to catch ES2020+ API usage), ts-forge could optionally run `tsc --noEmit` with a per-target tsconfig overlay. But this is an additive feature, not a v1 requirement.

### 2. Handling `paths` in tsconfig.json

**Decision: ts-forge takes over workspace resolution. It generates a synthetic `paths` mapping for tsc/transpiler consumption, and strips or overrides any user-defined workspace `paths` entries.**

The conflict: many monorepos configure `paths` in tsconfig to alias workspace packages:

```json
{
  "compilerOptions": {
    "paths": {
      "@sharpee/core": ["../core/src/index.ts"],
      "@sharpee/world-model": ["../world-model/src/index.ts"]
    }
  }
}
```

This works for IDE resolution and type checking, but creates problems for multi-target builds:

- **The paths point to source**, not to the per-target output directory. A `relative` import target needs `@sharpee/core` to resolve to `../core/dist-npm/index.js`, not `../core/src/index.ts`.
- **Different targets need different resolutions** of the same specifier. `paths` is a single static mapping.
- **pnpm/yarn workspace symlinks** often make `paths` unnecessary for runtime, but they're needed for tsc's module resolution to find types during editing.

**Strategy — three layers:**

**Layer 1: Detection.** On startup, ts-forge reads all `tsconfig.json` files in the workspace and identifies which `paths` entries correspond to workspace packages (by matching against the workspace package map from `pnpm-workspace.yaml` / `package.json` workspaces). Non-workspace paths (e.g., `@/*` → `./src/*` convenience aliases) are left untouched.

**Layer 2: Build-time override.** When invoking tsc or a transpiler for a specific target, ts-forge generates a temporary tsconfig overlay (via `extends`) that:
- Removes workspace `paths` entries (ts-forge handles resolution itself via the import transformer)
- Preserves non-workspace `paths` entries
- Sets `baseUrl` and `outDir` appropriate for the target

```json
// Generated: .ts-forge-tmp/npm-cjs/packages/core/tsconfig.json
{
  "extends": "../../../../packages/core/tsconfig.json",
  "compilerOptions": {
    "outDir": "../../../../packages/core/dist-npm",
    "module": "commonjs",
    "paths": {
      "@/*": ["../../../../packages/core/src/*"]
      // workspace paths removed — ts-forge handles them
    }
  }
}
```

**Layer 3: Post-compile transform.** After compilation, the import transformer rewrites specifiers. Since workspace `paths` were stripped, tsc will have either:
- Left the bare specifier as-is (if `moduleResolution` is `bundler` or `node16` and the package exists in `node_modules` via symlink)
- Errored (if tsc can't resolve without `paths`) — in which case ts-forge needs to keep a minimal `paths` entry pointing at the correct target output

The safe default: **keep workspace `paths` entries during compilation** (so tsc can resolve types), but point them at source. Then the import transformer rewrites the output specifiers post-compilation. This avoids tsc resolution errors while still producing correct output.

**What users need to know:**
- Workspace `paths` entries are managed by ts-forge. Users can still define them for IDE support, but ts-forge will override them during builds.
- Non-workspace `paths` (convenience aliases like `@/`) work unchanged.
- `ts-forge init` will warn if it detects workspace `paths` entries and explain the override behavior.

### 3. Declaration Maps (`.d.ts.map`)

**Decision: Transform declaration maps. They're essential for "Go to Definition" landing on source `.ts` files rather than `.d.ts` files, which is a core developer experience feature.**

Declaration maps (generated by `"declarationMap": true` in tsconfig) are JSON files that map positions in `.d.ts` files back to the original `.ts` source. Their structure:

```json
{
  "version": 3,
  "file": "index.d.ts",
  "sourceRoot": "",
  "sources": ["../src/index.ts"],
  "mappings": "AAAA;AACA;..."
}
```

**What needs rewriting:**

1. **`sources` array** — contains relative paths from the `.d.ts` output location to the original `.ts` source files. When the output directory changes per target (`dist/` vs `dist-npm/` vs `dist-esm/`), these relative paths change.

2. **`file` field** — the `.d.ts` filename. If the target applies extension mapping (`.d.ts` → `.d.mts`), this field must be updated to match.

3. **`sourceRoot`** — if set, it prefixes all `sources` paths. Must be adjusted for the target's output location.

4. **The mappings themselves do NOT need rewriting.** The position mappings (VLQ-encoded line/column data) map declaration positions to source positions. Since we don't change the source files and the declaration content is structurally identical (only import specifiers change, not positions of declarations), the mappings remain valid. Exception: if the import rewriting changes line lengths or counts in the `.d.ts` file, the mappings for lines after the first rewrite become offset. See mitigation below.

**Mitigation for mapping offset:** Import specifier rewrites change string lengths (`'@sharpee/core'` → `'../../core/dist-npm/index.js'`), which shifts column positions on affected lines. Two options:

- **Option A: Regenerate mappings.** After rewriting the `.d.ts` file, re-map by adjusting column offsets for each rewritten import line. This is precise but requires parsing the VLQ mappings.
- **Option B: Accept minor inaccuracy.** The column offset only matters for the specific import lines. "Go to Definition" on type declarations (interfaces, functions, classes) — which is the primary use case — is unaffected because those lines are untouched. Import lines in `.d.ts` files are rarely the target of "Go to Definition".

**Recommendation: Option B for v1, Option A as a follow-up.** The inaccuracy is confined to import/export lines in declaration files, which are not meaningful "Go to Definition" targets. Precise source mapping on type declarations (the lines users actually click) will be correct.

**Implementation:**

```typescript
interface DeclarationMapTransformer {
  transform(
    mapContent: string,        // raw .d.ts.map JSON
    dtsOutputPath: string,     // where the .d.ts lands for this target
    originalSourcePath: string, // original .ts source
    extensionMap?: Record<string, string>  // e.g., { ".d.ts": ".d.mts" }
  ): string;  // rewritten .d.ts.map JSON
}
```

The transformer:
1. Parses the source map JSON
2. Recomputes `sources` relative paths from `dtsOutputPath` back to `originalSourcePath`
3. Updates `file` if extension mapping applies
4. Adjusts `sourceRoot` if needed
5. Serializes back to JSON

**When declaration maps are skipped:** If the target config sets `"declarationMap": false` (or inherits it), no transform needed. For `bundle` import mode targets, declaration maps are typically irrelevant (bundled output doesn't ship `.d.ts` files).

### 4. Package Name

**Decision: `ts-forge`.** npm package name `ts-forge`, CLI command `ts-forge`.

## Prior Art and References

- [tsc-multi](https://github.com/tommy351/tsc-multi/) — parallel multi-target tsc, extension rewriting
- [tsup](https://tsup.egoist.dev/) — esbuild-based bundler with dual CJS/ESM
- [tshy](https://github.com/isaacs/tshy) — dual CJS/ESM with live dev
- [unbuild](https://github.com/unjs/unbuild) — auto-config build tool
- [publint](https://publint.dev/) — package.json validation
- [Are the Types Wrong?](https://arethetypeswrong.github.io/) — declaration correctness checker
- [TypeScript issue #15833](https://github.com/microsoft/TypeScript/issues/15833) — transpile to multiple targets
- [Anthony Fu: Ship ESM & CJS](https://antfu.me/posts/publish-esm-and-cjs)
- [Colin McDonnell: Live Types in a TS Monorepo](https://colinhacks.com/essays/live-types-typescript-monorepo)
