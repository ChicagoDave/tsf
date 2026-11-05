# ADR-0003: Pin rootDir to the common source directory when the user omits it

**Status**: ACCEPTED
**Date**: 2026-11-04
**Kind**: technical
**Scope**: src/utils/tsconfig.ts, src/compilers/tsc.ts, src/compilers/esbuild.ts, src/transform/imports.ts, src/transform/declarations.ts, tests/ts6-compat.test.ts

## Context

TSF's output model assumes a package's entry point lands at the root of its output directory: `src/index.ts` becomes `dist/index.js`, never `dist/src/index.js`. Entry-point stripping, package.json sync for npm staging, declaration placement, and import rewriting all compute output paths from the package's `rootDir`.

When a user tsconfig omits `rootDir`, TypeScript 5.x inferred it as the longest common directory of the input files, which for a conventional package is `src`. TypeScript 6.0 changed that default to the directory containing tsconfig.json (findings D3 in `docs/work/archive/typescript-6-compat/findings.md`). Under 6.0 the same tsconfig therefore emits to `dist/src/`, and every TSF path computation that assumed the 5.x layout is wrong. Before Phase 3, the three `getOutputEntryPoint()` copies also fell back to a hardcoded `'src'` when `rootDir` was absent, which matched 5.x inference only by convention.

TSF supports TypeScript `>=5.7 <7` (plan Phase 4), so both defaults are live at once. Two options were available: adopt the 6.0 default and teach every path computation to branch on the TypeScript version, or decide the value in TSF so the compiler's default never applies. ADR-0002 already established that nothing in TSF beyond the bounded node10 gate should branch on the TypeScript version.

## Decision

1. **TSF decides the effective `rootDir`; the compiler default never applies.** `resolveRootDir(tsconfigPath)` in `src/utils/tsconfig.ts` returns, in order: the user's declared `rootDir` resolved against the tsconfig directory; otherwise the longest common directory of the config's non-declaration input files (TypeScript 5.x's inference); otherwise, with no input files, the tsconfig directory.
2. **A declared `rootDir` is always honored as written.** The pin applies only when `rootDir` is undefined in the parsed user config. TSF never overrides a value the user set.
3. **Every emitter pins the same value.** The tsc adapter's `compile()` and the esbuild adapter's `emitDeclarationsOnly()` pass `rootDir: resolveRootDir(...)` in the in-memory compiler options when the user omits it. The user's tsconfig on disk is not modified (ADR-0001).
4. **Every reader resolves through the same function.** The widened-rootDir check in the tsc adapter and the `getOutputEntryPoint()` fallbacks in `src/compilers/tsc.ts`, `src/transform/imports.ts`, and `src/transform/declarations.ts` read `resolveRootDir()`. No code path falls back to a literal `'src'` or to TypeScript's default.
5. **The compat suite is the acceptance gate.** `tests/ts6-compat.test.ts` covers rootDir omitted for local and npm-staging builds with exact emitted layouts, esbuild declaration emit with rootDir omitted, and the three `resolveRootDir` branches. These run without stubs on both the 5.9 and 6.0 legs.

## Consequences

- Emit layout is identical on TypeScript 5.x and 6.0 for a tsconfig that omits `rootDir`. A user upgrading TypeScript sees no layout change from TSF, and does not need to add `rootDir` to keep their package.json entry points valid.
- TSF's layout for a rootDir-less tsconfig deliberately differs from what a bare `tsc` produces on 6.0. A user comparing `tsf build` output with `tsc` output on 6.0 will see `dist/index.js` against `dist/src/index.js`. The README's TypeScript versions note is the place this is stated.
- Any new code that emits through the TypeScript API, or computes an output path from a source path, must take `rootDir` from `resolveRootDir()`. Reading `parsedConfig.options.rootDir` directly and tolerating `undefined` is a bug, because `undefined` now means different things on different TypeScript versions.
- Adopting 6.0's tsconfig-directory default later is a breaking layout change for users and requires revisiting every site in Decision 3 and 4 together. It is not a local edit.
- The inference reads the config's input file list, so `include`/`files` changes can move the inferred `rootDir`. That is the same sensitivity 5.x had; a user who wants a fixed layout declares `rootDir`.
- This ADR does not cover the `module` default, which Phase 3 chose to warn about rather than pin, and does not consolidate the three `getOutputEntryPoint()` copies or fix the nested-rootDir flatten defect (findings B8). Both stay with issue 3.

## Session

Decision made and implemented in session 9ca055 (2026-11-03), Phase 3 of `docs/work/archive/typescript-6-compat/plan.md` (commit 8c3836b), and tracked as issue 8 because no confirmation was available then. Confirmed ADR-worthy by David and written in session 0a69e6 (2026-11-04).
