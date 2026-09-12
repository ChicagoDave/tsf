# Session Plan: Preserve subpath exports in the publish manifest, and gate publish on it

**Created**: 2026-09-11
**Plan Status**: ACTIVE
**Overall scope**: Fix GitHub issue #1 — `generatePublishManifest` (`src/sync/package-json.ts`) unconditionally overwrites `manifest.exports` with a `"."`-only map, silently discarding every subpath export the source `package.json` declares (plain subpaths, wildcards, `./package.json` passthrough, non-CJS-condition targets). The files themselves are staged and published correctly; only the exports map that would let consumers reach them is lost. Add the same class of defect-prevention the issue asks for: a check in the publish path that fails `tsf publish` when a staged manifest's exports/main/types/bin targets don't actually exist in the staging directory, since today `tsf validate` checks the *source* manifest against the *source* tree and passes while the *staged* manifest (the one actually published) is already broken.
**Bounded contexts touched**: N/A — infrastructure/tooling (build-tool internals: publish manifest generation and the publish CLI gate). No domain model is recorded for this repository and this work introduces none.
**Key domain language**: N/A — plain technical framing (publish manifest, staging directory, exports map, staged validation gate).

## References consulted
- `docs/context/project-profile.md` — CLI/Tooling mutation signature is explicit that publish-related tests must assert on the actual file written to disk (or the real `npm pack`/`npm publish` output-parsing path), never on stdout or a returned string alone; this governs how Phase 1 and Phase 2's REAL-PATH tests are shaped. Also notes `documentationStandard: always` and no CI/lint tooling in this repo.
- `docs/context/session-20260725-1700-main.md` (newest by filename sort; its own content is otherwise resolved/superseded by 1.0.2/1.0.3) — its Open Items record the existing project convention that the actual `npm publish` step is run manually by David, not automated in-session; this plan's final phase follows that precedent rather than introducing a new one.

## Phases

### Phase 1: Preserve and rewrite subpath exports in `generatePublishManifest`
- **Tier**: Medium
- **Budget**: 250
- **Domain focus**: Build Tooling / Compiler Orchestration — publish-manifest generation (`src/sync/package-json.ts`, consumed by `src/orchestrator/index.ts`'s npm-mode staging step)
- **Entry state**: `main` at 1.0.3. `generatePublishManifest` starts `manifest` as `{ ...source }` (so source `exports` is present) then unconditionally replaces `manifest.exports` with a synthesized `"."`-only map, dropping every other key. The correct model already exists ~20 lines below for `bin`: strip a leading `dist*` path segment so paths resolve against the flat staging root. 116 existing tests green, `pnpm build` green.
- **Deliverable**:
  - Rewrite the exports-generation block in `generatePublishManifest` to carry every source `exports` key through, applying the same outDir-stripping rewrite used for `bin`, across all five cases: `"."` (keep current synthesized behavior, reconciled against the rewritten source value), plain subpaths (`./channels` → conditions rewritten from `./dist/channels/index.js` to `./channels/index.js`), wildcard keys (`./styles/*` — strip the outDir prefix on the target side only, leave `*` intact), `./package.json: ./package.json` (passthrough, no prefix to strip), and conditions pointing at a non-CJS outDir like `dist-esm` (must collapse to the flat staged file or be dropped — never rewritten to a path absent from the tarball, consistent with the existing `delete manifest.type` decision). Synthesize the `"."`-only map only when the source declares no `exports` at all.
  - Extract the inline "generate manifest, write it into the staging directory" block currently living inside `build()` in `src/orchestrator/index.ts` (~lines 205–219) into a small, directly callable function (e.g. `writePublishManifest(pkg, workspacePackages, pkgStagingDir)` co-located with `generatePublishManifest`), so both the production `build --npm` path and the REAL-PATH test below call the identical code — not a hand-written stand-in.
  - A Behavior Statement (rule 12) for `generatePublishManifest` (and for the extracted staging-write function, since it performs a `fs.writeFileSync` side effect) before writing tests.
  - Derived GREEN tests (rule 13) in `tests/sync.test.ts`: one behavioral test per DOES/REJECTS-WHEN line, covering all five export shapes above, each asserting on the actual `manifest.exports` object produced (not a mock).
  - One REAL-PATH test (rule 13a) that stages a fixture package with plain-subpath, wildcard, and `./package.json` exports through the actual extracted staging function (or the full `build --npm` CLI path against a small dedicated fixture package — not the shared `core`/`app` fixtures, since their source `package.json` is rewritten by the `--sync-package-json` step in a way that would already collapse `exports` before `generatePublishManifest` ever sees it) and asserts on the `package.json` actually written to the staging directory.
- **Exit state**: `pnpm build` and `pnpm test` green (116 + new tests). `generatePublishManifest` preserves and correctly rewrites all export shapes from the issue. `src/orchestrator/index.ts`'s npm-mode staging step calls the extracted function with no behavioral change to its callers. No version bump yet.
- **Status**: DONE (2026-09-11) — exports preserved and rewritten; `writePublishManifest` extracted; 10 tests added, 141 passing, build clean; mutation-verification clean

### Phase 2: Gate `tsf publish` on staged-manifest export/entry-point validation
- **Tier**: Medium
- **Budget**: 250
- **Domain focus**: Publish pipeline — staged-manifest validation gate (`src/validate/index.ts`, `src/cli/publish.ts`)
- **Entry state**: Phase 1 complete and merged into the working tree; `generatePublishManifest` now preserves subpaths correctly. `tsf validate` (`validatePackageOutputs`) checks the SOURCE package.json against the SOURCE tree, which always passes since the referenced dist files genuinely exist there — it never inspects the staged manifest, which is the one actually published. `tsf publish`'s existing "Validate staging manifests" block (`src/cli/publish.ts` ~lines 143–164) only checks for leftover `workspace:` protocol strings, not for missing exports/main/types/bin targets.
- **Deliverable**:
  - A staged-manifest validator that checks a manifest's `main`/`types`/`module`/`exports`/`bin` targets exist relative to a given staging directory, reusing `exportTargetExists` (already wildcard-aware per 1.0.2) and factoring out the existing per-field existence checks in `validatePackageOutputs` so both the source-tree validator and the new staged-tree validator share one implementation rather than drifting apart.
  - Wire this into `handlePublish`'s existing staged-manifest validation loop (extending it, following the same extraction convention already used for `checkNpmLogin`/`buildPublishCommand` so the new check is a small, independently testable function rather than inline logic in `handlePublish`) so a missing staged target fails `tsf publish` with a clear error before `npm pack`/`npm publish` runs for any package.
  - A Behavior Statement for the new validation function before writing tests.
  - Derived GREEN tests: unit tests for the validator (missing target fails with a specific message, a wildcard target with ≥1 matching file in the staging dir passes, `./package.json` passthrough passes) plus a REAL-PATH test (rule 13a) that stages a fixture manifest whose exports target is genuinely absent from a real staging directory on disk and asserts the extracted validation function — and, at least once, the full `handlePublish` path — rejects it, per the project-profile mutation signature (assert on real staged file state, not stdout).
- **Exit state**: `tsf publish` exits non-zero, before packing or publishing any package, when any staged package's `main`/`types`/`module`/`exports`/`bin` target is missing from its staging directory. `pnpm build` and `pnpm test` green.
- **Status**: DONE (2026-09-11) — `validateManifestTargets` extracted and shared by source and staged validation; `validateStagedManifests` gates `handlePublish` before any pack; 11 tests added (8 unit + 1 shared-validator + 2 real-path CLI), 152 passing, build clean; mutation-verification clean

### Phase 3: Bump to 1.0.4 and finalize
- **Tier**: Small
- **Budget**: 100
- **Domain focus**: Release housekeeping
- **Entry state**: Phases 1–2 complete, `pnpm build` and `pnpm test` green, no version bump yet.
- **Deliverable**: `package.json` version bumped 1.0.3 → 1.0.4. A single commit containing the fix, the validation gate, and the version bump — following this repo's existing convention of landing the version number in the same commit as the fix it releases (e.g. `f3eed7a`, `1fbba11`). Commit message references issue #1.
- **Exit state**: Working tree at 1.0.4, `pnpm build`/`pnpm test` green, commit created (not pushed unless the user asks). Ready for manual publish.
- **Status**: CURRENT (since 2026-09-11)

### Phase 4: Publish 1.0.4 to npm (manual, owned by David)
- **Tier**: N/A — manual step, not executed by the agent
- **Budget**: N/A
- **Domain focus**: N/A
- **Entry state**: Phase 3 committed, working tree clean.
- **Deliverable**: David runs `npm publish` for the staged 1.0.4 build, then bumps Sharpee's `tsf` devDependency to `^1.0.4` and reinstalls, mirroring the same manual hand-off recorded for the 1.0.1 release.
- **Exit state**: 1.0.4 live on npm; downstream Sharpee packages can pick up the fix.
- **Status**: PENDING (manual — not started by the agent)
