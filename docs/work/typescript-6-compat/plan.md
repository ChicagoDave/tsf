# Session Plan: TypeScript 6.0 compatibility for TSF

**Created**: 2026-11-02
**Plan Status**: ACTIVE
**Overall scope**: Make TSF build and run correctly against TypeScript 6.0.x (6.0.3 is current on npm) while still working on 5.x. Replace the `baseUrl` and `moduleResolution: node10` injection in the tsc adapter with 6.0-safe equivalents (`paths` relative to the tsconfig, `bundler` resolution), pin down the 6.0 default changes TSF relies on implicitly, and prove it with a real downstream consumer. TypeScript 7.x (Go-native, no JS compiler API) is OUT of scope; a 7.1 spike behind the compiler-adapter interface is a later, separate plan.
**Bounded contexts touched**: N/A — infrastructure/tooling (tsc compiler adapter, import/declaration transforms, TSF's own tsconfig and dependency range).
**Key domain language**: N/A — plain technical framing (compiler adapter, workspace path mapping, staging directory, moduleResolution, rootDir).

## References consulted
- `docs/adrs/0001-vscode-extension.md` — Kind technical; governs the VS Code extension (BUILD vs EDITOR mode, source-pointing `paths` in the user tsconfig). Constraint: the adapter must keep the user tsconfig untouched and inject only into the build copy; Phase 2 must not alter that split.
- `docs/context/project-profile.md` — Tests live in `tests/`, run via `pnpm exec vitest run`; compiler/transform tests must assert on files actually written (REAL-PATH), not stdout; JSDoc headers on source files; TSF self-hosts with `module: commonjs`.
- `docs/context/session-20261102-0035-main.md` (newest-session open items: TS 7 assessment, TS 6 first, 7.1 spike later) — sets the order this plan follows.
- GitHub issue 3 (recurrence, Build / Toolchain; not a file) — three duplicated `getOutputEntryPoint()` copies; see Phase 2 note.
- Product ADRs not consulted (no Scope intersection): none

## Verified facts vs reported
- [verified] npm registry 2026-11-02: `latest` is 7.0.2; 6.0.2 and 6.0.3 exist; installed locally is 5.9.3; `package.json` has `"typescript": "^5.7.0"`, so a `^6` range is a deliberate change, not a drift.
- [verified] `src/compilers/tsc.ts` injects `moduleResolution = Node10` when bundler resolution meets a CommonJS module override (lines ~81-95), and injects `baseUrl = pkg.path` at three sites (~131, ~158, ~189), and its widened-rootDir check reads `parsedConfig.options.baseUrl` (~170). Injected `paths` are written relative to `pkg.path` precisely because baseUrl is `pkg.path`.
- [verified] `getOutputEntryPoint` exists three times: `src/compilers/tsc.ts:441`, `src/transform/imports.ts:240`, `src/transform/declarations.ts:193`.
- [verified] TSF's own `tsconfig.json` is `module: commonjs`, `moduleResolution: node`, explicit `rootDir`, no explicit `types`.
- [reported] TS 6.0 deprecates `baseUrl` and `moduleResolution: node10`, and changes defaults for `rootDir`, `types`, `strict`, `module`; 7 hard-errors on the first two. Not confirmed from release notes (not fetched). Phase 1 confirms each by running 6.0.3, which is the authority.

## Phases

### Phase 1: Baseline TSF against TypeScript 6.0.3 and record exactly what breaks
- **Tier**: Medium
- **Budget**: 250
- **Domain focus**: Compiler adapter compatibility — discovery before change
- **Entry state**: `main` at 1.0.4, TS 5.9.3 installed, `pnpm build` green, `pnpm exec vitest run` 12 files / 152 tests green, `npx tsc --noEmit` exit 0.
- **Deliverable**: Install `typescript@~6.0.3` as devDependency (lockfile updated). Run build, full suite, and `npx tsc --noEmit`; record each failure and each deprecation diagnostic (TS5101/TS5107-style) and which default changes bite, in a findings table at `docs/work/typescript-6-compat/findings.md` (new). Add `tests/ts6-compat.test.ts` (new): real-path tests that run the tsc adapter (`src/compilers/tsc.ts`) against fixture packages and assert on emitted files and zero deprecation diagnostics, initially expected red where baseUrl/node10 trip. Decide from findings whether TSF's tsconfig needs `ignoreDeprecations: "6.0"` only as a stopgap (not shipped).
- **Files**: `package.json`, `pnpm-lock.yaml`, `tests/ts6-compat.test.ts` (new), `docs/work/typescript-6-compat/findings.md` (new), `tsconfig.json` and `tests/fixture/packages/{app,core}/tsconfig.json` (`ignoreDeprecations: "6.0"` stopgap only, removed by Phase 3)
- **Exit state**: Findings table lists every 6.0 break with file:line and a fix-or-ignore call; an expected-red test (Vitest `it.fails`, so the suite itself stays green and flips when Phase 2 fixes the behavior) exists for each adapter break; no source changes to `src/` yet.
- **Demonstration**: Run `pnpm exec vitest run` under 6.0.3 and see it green, with the `it.fails` cases in `tests/ts6-compat.test.ts` matching the findings table one-for-one; run `npx tsc --version` and see 6.0.3.
- **Demonstrated**: [verified] 2026-11-03 — `npx tsc --version` → 6.0.3; `pnpm exec vitest run` → 13 files / 158 tests green, `tests/ts6-compat.test.ts` 6 passed with 4 `it.fails` cases; a probe with `it.fails` → `it` failed exactly those 4 with the injected `baseUrl` (×3) and `moduleResolution=node10` (×1) deprecations as the sole diagnostic, matching findings rows B3 and B4 one-for-one. Under 5.9.3 the compat suite passes 6 of 6. No `src/` changes. Findings table: 7 breaks (B1–B7), 8 default-change rows (D1–D8). [verified: writer re-ran `npx tsc --version` → 6.0.3 and `pnpm exec vitest run` → 13 files / 158 passed at 2026-11-03 00:38:59 local, after the last edit to tests/ts6-compat.test.ts (06:37:06Z); event log row 06:38:42Z records the probe run failing as expected]
- **Status**: DONE

### Phase 2: Replace the baseUrl and node10 injection in the tsc adapter (ADR-0002)
- **Tier**: Large
- **Budget**: 400
- **Domain focus**: tsc adapter workspace path mapping and CommonJS resolution
- **Entry state**: Phase 1 findings table and `it.fails` tests present; 6.0.3 installed. TypeScript is a **runtime** dependency (`dependencies`, `~6.0.3`), not a devDependency (findings B2). The `ignoreDeprecations: "6.0"` stopgaps in `tsconfig.json` and the two fixture tsconfigs are TS5103 under 5.x (findings B1, B7): strip them for the 5.9.3 leg of the demonstration, or migrate the fixture to `nodenext` first so no stopgap is needed there.
- **Deliverable**: Write `docs/adrs/0002-tsc-adapter-path-resolution-without-baseurl.md` (new) FIRST — this is the ADR-worthy decision: `paths` entries become absolute-or-tsconfig-relative with no `baseUrl` injection, and the CommonJS+bundler downgrade (node10) is replaced by the 6.0-supported alternative (for example `module: node16`/`nodenext` resolution or keeping `bundler` with emit-compatible module), with the 5.x fallback behavior stated explicitly (must still work on `^5.7`). Then implement in `src/compilers/tsc.ts` (the three baseUrl sites, the Node10 override, and the widened-rootDir check that reads baseUrl). Behavior Statement before tests; Phase 1 red tests go green; add cases for user tsconfigs that already declare `baseUrl` (must be honored, with the deprecation surfaced rather than swallowed).
  - Issue 3 decision: these edits only CALL `getOutputEntryPoint`; they do not change it. Leave issue 3 (consolidate three copies plus rootDir test matrix) SEPARATE and do not fold it in; folding doubles the blast radius of a compatibility change. Instead add one test per rootDir shape (nested, `./src`-prefixed) here only as far as the new paths logic needs, and note on issue 3 that the matrix remains open.
- **Files**: `src/compilers/tsc.ts`, `docs/adrs/0002-tsc-adapter-path-resolution-without-baseurl.md` (new), `tests/ts6-compat.test.ts`, `tests/fixture/packages/{app,core}/tsconfig.json` (migrated to bundler resolution, no baseUrl, stopgap removed), `docs/work/typescript-6-compat/findings.md`
- **Exit state**: Under 6.0.3 the adapter emits zero deprecation diagnostics for TSF-injected options; suite green; the same suite also green under 5.9.3 (run both by switching the installed version); ADR-0002 written.
- **Demonstration**: Run `pnpm exec vitest run` under 6.0.3, then reinstall TypeScript 5.9.3 and rerun; both must show all tests passing, with the ts6-compat suite included.
- **Demonstrated**: [verified] 2026-11-03 — ADR-0002 written first. Under 6.0.3: `npx tsc --noEmit` clean, `pnpm exec vitest run` 13 files / 163 tests green, `tests/ts6-compat.test.ts` 11 passed with exact-layout assertions; the 4 Phase 1 `it.fails` cases are plain `it` now, and 2 new nested-rootDir cases are `it.fails` against the pre-existing flatten defect recorded as findings B8 on issue 3 (not caused by this phase; reproduced on 5.9.3 too). Fixture stopgaps removed and both integration suites green on the migrated fixture. Under 5.9.3 with the `tsconfig.json` stopgap stripped for the run: `pnpm build` green, 13 files / 163 tests green. TypeScript restored to 6.0.3 afterwards. Adapter injects no `baseUrl` (zero occurrences outside comments and the user-baseUrl read in `src/compilers/tsc.ts`); node10 downgrade gated to 5.x. [verified: writer re-ran `npx tsc --version` → 6.0.3 and `pnpm exec vitest run` → 13 files / 163 passed at 2026-11-03 00:48:44 local, after the last edit to src/compilers/tsc.ts and tests/ts6-compat.test.ts; the 5.9.3 leg is reported by session, unverified (no hook row)]
- **Status**: DONE

### Phase 3: Pin the 6.0 default changes and harden config reading
- **Tier**: Medium
- **Budget**: 250
- **Domain focus**: Implicit compiler defaults (`rootDir`, `types`, `strict`, `module`) and user-tsconfig reading in `src/transform/imports.ts`, `src/transform/declarations.ts`, `src/compilers/esbuild.ts`, `src/compilers/rollup-bundler.ts`
- **Entry state**: Phase 2 done; adapter clean under 6.0.3.
- **Deliverable**: For each default change Phase 1 confirmed bites, either set the option explicitly in TSF's own `tsconfig.json` (`types`, `rootDir` already explicit; `module`, `moduleResolution` moved off `node10`) or make the readers (`readConfigFile`/`parseJsonConfigFileContent` call sites) not depend on the old default, with a test per decision that passes a user tsconfig lacking the option. Move TSF's own tsconfig off `moduleResolution: node` to a 6.0-valid setting and confirm `pnpm build` still emits CommonJS.
- **Files**: `tsconfig.json`, `src/utils/tsconfig.ts` (new), `src/compilers/tsc.ts`, `src/compilers/esbuild.ts`, `src/transform/imports.ts`, `src/transform/declarations.ts`, `tests/ts6-compat.test.ts`, `docs/work/typescript-6-compat/findings.md` (`src/compilers/rollup-bundler.ts` inspected, no default dependence: `transpileModule` gets explicit module/target)
- **Exit state**: `pnpm build` green under 6.0.3 with no deprecation diagnostic and no `ignoreDeprecations`; suite green under both 6.0.3 and 5.9.3; `dist/` emit is CommonJS as before.
- **Demonstration**: Run `pnpm build` then `pnpm exec vitest run` under 6.0.3; grep the build output for "deprecat" and see none.
- **Demonstrated**: [verified] 2026-11-03 — `tsconfig.json` on `module`/`moduleResolution: nodenext` with `types: ["node"]`, no `ignoreDeprecations` anywhere in the repo (grep count 0). Under 6.0.3: `pnpm build` green with no deprecation output, `npx tsc --noEmit` clean, `dist/` emit is CommonJS (`require`/`exports`, no `import`/`export` statements), `pnpm exec vitest run` 13 files / 171 tests green (compat suite 19). Under 5.9.3 with nothing stripped: `pnpm build` green, 13 files / 171 tests green. TypeScript restored to `~6.0.3`, package.json and pnpm-lock.yaml unchanged versus HEAD. New `src/utils/tsconfig.ts` pins rootDir; `module` left floating with a warning; `preserve` mapped. Two side findings filed: issue 7 (esbuild adapter passes `external` without `bundle`, pre-existing) and the D1 correction (5.x already defaulted to ES2015 modules for ES2015+ targets). [verified: writer re-ran `npx tsc --version` -> 6.0.3 and `pnpm exec vitest run` -> 13 files / 171 passed at 2026-11-03 00:59:08 local, after the last edit; event log row 06:57:49Z records the 171-pass runs on both 6.0.3 and 5.9.3. The 5.9.3 leg itself is [reported by session, unverified] in the writer re-run]
- **Status**: DONE

### Phase 4: Real-path check against Sharpee and declare the supported TypeScript range
- **Tier**: Medium
- **Budget**: 250
- **Domain focus**: Downstream consumer validation and dependency range
- **Entry state**: Phases 2-3 done; Sharpee at `../sharpee` consumes tsf `^1.0.4` and currently pins `"typescript": "^5.2.2"`.
- **Deliverable**: Pack the local build with `pnpm pack`, install it into a scratch copy of Sharpee (not its working tree), override its TypeScript to 6.0.3, and run Sharpee's tsf build; record results and any Sharpee-side tsconfig changes it needs in `docs/work/typescript-6-compat/findings.md`. Set TSF's `package.json` TypeScript range: `devDependency` on `~6.0.3`, and a `peerDependencies` range that states what is actually tested (`>=5.7 <7`), with a README note that TS 7 is unsupported. If Sharpee is unavailable, say so and substitute `tests/fixture/` plus a second synthetic workspace, marking the check [reported].
- **Files**: `package.json` (peerDependencies + peerDependenciesMeta; `pnpm-lock.yaml` unchanged), `README.md` ("TypeScript versions" under Install), `docs/work/typescript-6-compat/findings.md` (section 5, D10)
- **Exit state**: A Sharpee build under TSF-with-TS-6.0.3 succeeds, or its failures are recorded with owner; supported range is declared and matches what was tested.
- **Demonstration**: Run the scratch Sharpee tsf build with TS 6.0.3 and see it exit 0 with emitted dist and declaration files; run `pnpm exec vitest run` and see all green.
- **Demonstrated**: [reported by session, unverified — the scratch builds ran outside the hook log; run1–run5 logs under the session scratchpad phase4/] 2026-11-03 — Sharpee scratch copy (git archive of ../sharpee HEAD 2fd7336b5, Sharpee's checkout untouched) on TypeScript 6.0.3 with the packed TSF tarball from 8c3836b: as-is, `tsf build` exits 1 on 35 Sharpee-side deprecations plus `types: []` fallout (findings §5 run 1); with three Sharpee-side config changes and one source line (findings §5), `tsf build` exits 0 with 0 deprecation diagnostics across 34 packages, and `tsf build --npm` exits 0 producing 34 staged packages with generated manifests (`main`, `types`, `exports`, `@sharpee/*` deps) — runs 4 and 5. In the tsf repo [verified]: `npx tsc --noEmit` clean, `pnpm exec vitest run` 13 files / 171 tests green, `pnpm-lock.yaml` unchanged after `pnpm install`, and the packed tarball's package.json carries `peerDependencies.typescript: ">=5.7 <7"`.
- **Status**: DONE

### Phase 5: Version bump and local commit
- **Tier**: Small
- **Budget**: 100
- **Domain focus**: Release housekeeping
- **Entry state**: Phases 1-4 done, build and tests green under 6.0.3.
- **Deliverable**: Bump `package.json` to 1.1.0 (new supported-range behavior; David may choose 1.0.5) in the same commit as the work, per repo convention; commit locally, not pushed.
- **Files**: `package.json`
- **Exit state**: Working tree at the new version, `pnpm build` and `pnpm exec vitest run` green, local commit created.
- **Demonstration**: Run `pnpm exec vitest run` and read the version in `package.json`; see all tests green and the new version.
- **Demonstrated**: 
- **Status**: PENDING

### Phase 6: Publish to npm (manual, owned by David)
- **Tier**: N/A — manual step, not executed by the agent
- **Budget**: N/A
- **Domain focus**: N/A
- **Entry state**: Phase 5 committed, working tree clean.
- **Deliverable**: David runs `npm publish`, then bumps Sharpee's tsf dependency and, if desired, its TypeScript range.
- **Exit state**: Release live on npm.
- **Demonstration**: Run the npm registry version query for the package and see the new version.
- **Demonstrated**: 
- **Status**: PENDING
