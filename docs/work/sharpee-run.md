# Running TSF against Sharpee

## Prerequisites

Build TSF first (from the TSF repo root):

```bash
cd /mnt/c/repotemp/tsf
pnpm build
```

This produces the CLI at `dist/cli/index.js`.

## Setup

From your sharpee terminal:

```bash
# Create an alias for convenience
alias tsf='node /mnt/c/repotemp/tsf/dist/cli/index.js'
```

## Step 1: Initialize config

```bash
tsf init
```

This creates `ts-forge.config.json`. It will detect pnpm workspace and fall back to a "monorepo" template with a single `local` target (`outDir: "dist"`).

To match sharpee's actual dual-output setup, edit `ts-forge.config.json` and replace the `targets` section:

```json
{
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

## Step 2: Inspect the build plan

```bash
tsf info
```

Expected output shows 30 packages across 8 dependency levels, with per-target scoping:

```
Targets:
  local: commonjs → dist, imports=preserve
  npm: commonjs → dist-npm, imports=relative [condition: publish] (18 packages)
```

The `npm` target automatically applies only to the 18 packages that have `publishConfig` in their `package.json`. Stories, platforms, and internal tools are excluded. Packages negated in `pnpm-workspace.yaml` (e.g. `!packages/forge`) are excluded from the projects list entirely.

## Step 3: Build

```bash
# Build the default target (local) — applies to all 30 packages
tsf build

# Build all targets (local for all 30, npm for 18 published)
tsf build --all

# Build with package.json sync
tsf build --all --sync-package-json

# Build only the npm target
tsf build --target npm
```

## Step 4: Sync package.json fields

```bash
tsf sync
```

Generates `main`, `types`, `exports` fields in each package's `package.json`. Preserves all other fields (scripts, dependencies, etc.).

**Per-package target awareness:**
- Published packages (18 with `publishConfig`) get fields pointing to `dist-npm/` (from the `npm` target)
- Non-published packages (12 without) get fields pointing to `dist/` (from the `local` target)

## Step 5: Validate outputs

```bash
tsf validate
```

Checks that all package.json entry points exist on disk, declarations match JS files, and no workspace specifiers leaked into npm output. Only validates targets applicable to each package (e.g. stories are not checked against the `npm` target).

## Step 6: Generate CI workflow

```bash
tsf gh-action
```

Creates `.github/workflows/tsf.yml` with pnpm setup and Node 18/20/22 matrix.

## Step 7: Version packages for publish

```bash
# Set all npm-published packages to a specific version
tsf version 0.9.64-beta --condition publish

# Preview first with --dry-run
tsf version 0.9.64-beta --condition publish --dry-run

# Bump patch version on published packages
tsf version --bump patch --condition publish
```

The `--condition publish` flag restricts versioning to packages that have `publishConfig` in their `package.json` — the same scoping used by `tsf build --condition publish`.

## Full pipeline (one-shot)

```bash
tsf version 0.9.64-beta --condition publish && tsf build --all --sync-package-json && tsf validate
```

## Cleanup

To undo everything TSF generated:

```bash
rm ts-forge.config.json
rm -rf .github/workflows/tsf.yml
git checkout -- packages/ stories/   # restore modified package.json files
```
