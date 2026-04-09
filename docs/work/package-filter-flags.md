# Work Summary: --package and --packageList CLI Flags

**Date:** 2026-04-09
**Status:** COMPLETE

## Problem

Publishing a single package with `tsf build --npm` required knowing the full scoped name (`--filter @sharpee/stdlib`). There was no way to use short names or comma-separated lists, making single-package and selective-package workflows awkward.

This surfaced when `@sharpee/stdlib@0.9.109` was accidentally published via `npm publish` (bypassing tsf), which shipped with unresolved `workspace:*` dependencies. The fix required tsf to support building and publishing individual packages conveniently.

## Solution

Added two new CLI flags available across all commands that support `--filter`:

- `--package <name>` — restrict to a single package by short name (e.g., `stdlib`)
- `--packageList <a,b>` — restrict to packages by short names, comma-separated (e.g., `stdlib,engine`)

Short names are resolved to full scoped names by matching against the workspace package map (e.g., `stdlib` resolves to `@sharpee/stdlib`).

## Files Changed

| File | Change |
|------|--------|
| `src/utils/package-filter.ts` | **New** — `parsePackageFlag()` parses the two flags; `resolvePackageFilters()` resolves short names to full scoped names |
| `src/cli/index.ts` | Added flags to `parseBuildOptions()` + updated help text for build, publish, version, changed, list |
| `src/cli/publish.ts` | Added flag parsing + resolution after context load |
| `src/cli/version.ts` | Added flag parsing + resolution after context load |
| `src/cli/changed.ts` | Added flag parsing + resolution after context load |
| `src/cli/list.ts` | Added flag parsing + resolution after context load |
| `src/orchestrator/index.ts` | Added resolution step before filter is applied in build |

## Verification

- `tsf list --package stdlib` → `@sharpee/stdlib`
- `tsf list --packageList stdlib,engine,world-model` → lists all three in dependency order
- `tsf build --npm --package stdlib` → builds single package to staging with resolved deps (no `workspace:*`)
- Sharpee npm regression test: 46/46 passing after publishing the fix
