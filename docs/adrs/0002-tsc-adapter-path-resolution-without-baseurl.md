# ADR-0002: tsc adapter resolves workspace paths without baseUrl or node10

**Status**: ACCEPTED
**Date**: 2026-11-03
**Kind**: technical
**Scope**: src/compilers/tsc.ts, tests/ts6-compat.test.ts

## Context

TSF's tsc adapter (`src/compilers/tsc.ts`) makes workspace packages resolvable during a per-package compile by injecting `paths` entries into the compiler options: source-pointing entries for local builds, staging-dir entries for npm builds. Since the adapter was written it has also injected `baseUrl = pkg.path`, because the entries were written relative to the package directory and 5.x resolved `paths` against `baseUrl`. Separately, when a user tsconfig declares `moduleResolution: bundler` and a target overrides `module` to CommonJS, the adapter downgrades `moduleResolution` to `node10`, because TypeScript 5.x rejected bundler resolution with CommonJS output (TS5095).

TypeScript 6.0 deprecates both `baseUrl` and `moduleResolution: node10` as hard errors, silenceable only by `ignoreDeprecations: "6.0"`, and TypeScript 7 removes them. Phase 1 of `docs/work/archive/typescript-6-compat/plan.md` (findings B3, B4, B5 in `findings.md`) reproduced every injection site failing under 6.0.3 with a 6.0-clean user tsconfig. 6.0 also allows bundler resolution with CommonJS output, which removes the reason for the downgrade.

Two facts about the compiler API constrain the replacement:

- When `paths` is present and `baseUrl` is absent, TypeScript resolves entries against `options.pathsBasePath`, an internal option that `parseJsonConfigFileContent` sets **only when the user's own tsconfig declares `paths`**; otherwise it falls back to the host's current working directory. Entries the adapter injects into a config that had no `paths` would therefore resolve against `process.cwd()`, not the tsconfig directory. Tsconfig-relative entries are not safe to inject.
- A `paths` substitution that is already an absolute path is used as-is; the base is ignored.

ADR-0001 fixes the BUILD/EDITOR split: the user's tsconfig on disk is never modified, the adapter injects only into the in-memory compile. That constraint continues to hold here.

## Decision

1. **Injected `paths` entries are absolute.** Every entry the adapter adds, for workspace source (local builds) and for staging output (npm builds), is written as an absolute filesystem path. The adapter never injects `baseUrl`.
2. **User-declared `baseUrl` and `paths` are honored and left as written.** If the user tsconfig declares `baseUrl`, its own entries keep resolving against it and TypeScript's deprecation diagnostic is surfaced through the normal diagnostics channel, never suppressed. TSF never injects `ignoreDeprecations`; a user who wants it sets it in their own tsconfig and it passes through unchanged.
3. **The widened-rootDir check resolves entries the way TypeScript will.** The base for a relative entry is the user's `baseUrl` resolved against the tsconfig directory if declared, otherwise the tsconfig directory; an absolute entry is used as-is. The check previously used `pkg.path` as the fallback, which coincides with the tsconfig directory for conventional layouts but is not the same thing.
4. **The node10 downgrade is version-gated, not removed.** On TypeScript 6.0 and later the adapter leaves `moduleResolution: bundler` in place when the target forces CommonJS, because 6.0 accepts the pair. On 5.x it still downgrades to `node10`, which is the only resolution 5.x accepts for that pair. The gate reads `ts.versionMajorMinor`. The supported range stays `>=5.7 <7` (plan Phase 4); the 5.x branch is removed when the floor is raised to 6.
5. **The compat suite is the acceptance gate for this decision.** `tests/ts6-compat.test.ts` drives `compile()` against a real two-package workspace with no stubs. Its Phase 1 `it.fails` cases become plain `it`; a case for a user-declared `baseUrl` asserts the deprecation is surfaced on 6.x and the build succeeds on 5.x; rootDir-shape cases cover nested and `./src`-prefixed `rootDir` for both local and npm-staging builds.

## Consequences

- The adapter emits no deprecation diagnostic of its own on 6.x; whatever a user sees is theirs. This is a precondition for TypeScript 7 support, which a later plan addresses behind the compiler-adapter interface.
- Future code that injects `paths` anywhere in TSF (esbuild adapter, bundlers, transforms) must use absolute entries for the same `pathsBasePath` reason. Relative injected entries are a bug even where they happen to work.
- `pkg.path` and `path.dirname(pkg.tsconfig)` are different quantities in the adapter: the former names the package, the latter is the resolution base. Code that conflates them is wrong for a tsconfig that does not sit at the package root.
- The 5.x node10 branch is a known, bounded piece of legacy that goes away with the version floor. Nothing else in TSF should branch on the TypeScript version.
- Open issue 3 (three duplicated `getOutputEntryPoint()` copies and a rootDir test matrix) is not folded in. This ADR adds the rootDir-shape coverage its own change needs, in the compat suite, and leaves the consolidation to issue 3.

## Session

Written in session 9ca055 (2026-11-03) as the first deliverable of Phase 2 of `docs/work/archive/typescript-6-compat/plan.md`, following the Phase 1 findings in `docs/work/archive/typescript-6-compat/findings.md`.
