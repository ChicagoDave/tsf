# Fix: Publish via Staging Directory + Tarball

## Problem

Published packages contain `workspace:*` in their `dependencies`, which npm cannot resolve. Consumers hit `EUNSUPPORTEDPROTOCOL` on install before any code runs.

## Rejected Approaches

- **Strip deps from source package.json** — breaks local dev. pnpm needs `workspace:*` for symlink resolution.
- **Temporarily modify package.json during publish, then restore** — no one will use a tool that mutates their files.
- **Write publish output into the package tree** (outDir like `dist-npm/`) — tsc finds `.d.ts` files there and gets confused during local dev.
- **Separate build step writing to workspace** (`tsf build --condition publish`) — same problem, files in the package tree break local dev.
- **Staging dir inside workspace** (`/npmpub/`) — pnpm finds `package.json` files and breaks.

## Solution

`tsf build` gets two modes. `tsf publish` is strictly the npm publish step.

### Workflow

```
tsf version 0.9.66-beta          # bump versions in source package.json
tsf build --npm                   # compile to staging dir, rewrite imports, clean package.json
tsf publish --tag latest          # pack tarballs from staging, npm publish
```

### `tsf build --local` (default)

What `tsf build` does today. Compiles to `dist/`, preserves workspace imports. Nothing changes.

### `tsf build --npm`

Compiles publish targets to a staging directory on the native Linux filesystem (`~/.tsf-publish/`), outside the workspace. For each publishable package:

1. Compile to `~/.tsf-publish/<pkg-name>/`
2. Rewrite imports to relative paths
3. Transform declarations
4. Generate a clean `package.json` (strip `workspace:*` deps, strip `devDependencies`, set entry points)
5. Copy README, LICENSE if present

Uses incremental caching — skips packages whose source hasn't changed since last npm build. Cache keys stored separately from local build cache.

### `tsf publish`

Reads already-built packages from `~/.tsf-publish/`, packs each into a `.tgz` tarball, and runs `npm publish <tarball>`. Does not compile anything.

Options:
- `--tag <tag>` — npm dist-tag (default: `latest`)
- `--filter <name>` — restrict to specific packages
- `--changed` — only publish packages changed since last npm version
- `--dry-run` — show what would be published

### Staging Directory

Must be on native Linux filesystem in WSL — not `/mnt/c/`. Default: `~/.tsf-publish/`, configurable via `TSF_PUBLISH_DIR` env var.

```
~/.tsf-publish/
  @sharpee/
    core/
      package.json   (clean)
      index.js
      index.d.ts
      README.md
    engine/
      ...
```

### Clean package.json in staging

Source `packages/engine/package.json` (never touched):
```json
{
  "name": "@sharpee/engine",
  "version": "0.9.66-beta",
  "dependencies": {
    "@sharpee/core": "workspace:*",
    "@sharpee/world-model": "workspace:*",
    "lz-string": "^2.0.0"
  },
  "devDependencies": {
    "vitest": "^3.0.0"
  },
  "publishConfig": {
    "access": "public"
  }
}
```

Generated `~/.tsf-publish/@sharpee/engine/package.json`:
```json
{
  "name": "@sharpee/engine",
  "version": "0.9.66-beta",
  "main": "./index.js",
  "types": "./index.d.ts",
  "dependencies": {
    "lz-string": "^2.0.0"
  },
  "publishConfig": {
    "access": "public"
  }
}
```

### What changes

| Component | Change |
|---|---|
| `src/cli/index.ts` | Parse `--local` / `--npm` flags on build command |
| `src/orchestrator/index.ts` | Route `--npm` builds to staging dir with relative imports |
| `src/sync/package-json.ts` | `generatePublishManifest()` — returns clean package.json object |
| `src/cli/publish.ts` | Read from staging dir, pack tarballs, `npm publish <tarball>` |

### What doesn't change

- Source `package.json` — never modified
- `tsf build` (no flags / `--local`) — unchanged, compiles to `dist/`
- No files written to the package tree during npm build
- Local dev workflow — completely unaffected
