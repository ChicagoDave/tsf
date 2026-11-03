# TypeScript 6.0 compatibility — Phase 1 findings

**Recorded**: 2026-11-03, session 9ca055, TypeScript 6.0.3 installed (`npx tsc --version` → 6.0.3; was 5.9.3 under `^5.7.0`).
**Baseline before install**: `pnpm build` green, `pnpm exec vitest run` 12 files / 152 tests green, `npx tsc --noEmit` exit 0.

Provenance: every row marked [verified] was reproduced by running 6.0.3 in this repo. Rows marked [reported] come from the TypeScript 6.0 release notes (typescriptlang.org, fetched 2026-11-03) and were not exercised here.

## 1. Breaks observed under 6.0.3

| # | Where | Symptom | Cause | Call | Phase |
|---|---|---|---|---|---|
| B1 | `tsconfig.json:5` (TSF's own) | `pnpm build` and `npx tsc --noEmit` exit 2: `error TS5107: Option 'moduleResolution=node10' is deprecated and will stop functioning in TypeScript 7.0` [verified] | TSF self-hosts with `"moduleResolution": "node"`, which is node10. | Fix: move to `bundler` (6.0 allows bundler + commonjs) or `nodenext`. Stopgap applied in this phase only: `"ignoreDeprecations": "6.0"` in `tsconfig.json`, to be removed in Phase 3. Not shipped. **The stopgap is 6.0-only**: under 5.9.3 `pnpm build` fails with `error TS5103: Invalid value for '--ignoreDeprecations'` [verified], so the 5.9.3 leg of any dual-version run must strip it first (see B7). | 3 |
| B2 | `package.json:38` | `pnpm add -D typescript` moved TypeScript from `dependencies` to `devDependencies` [verified] | TypeScript is a **runtime** dependency of TSF (the compiler API is `require`d from `src/compilers/*`, `src/transform/*`). The plan's "devDependency" wording is wrong. | Fix applied: restored under `dependencies` as `~6.0.3`. Phase 4's range decision must keep it there and decide whether a `peerDependencies` range is additionally wanted. | 1 (done), 4 |
| B3 | `src/compilers/tsc.ts:131,158,189` | Adapter-injected `baseUrl = pkg.path` makes every cross-package compile fail on 6.0: `Option 'baseUrl' is deprecated and will stop functioning in TypeScript 7.0` [verified via `tests/ts6-compat.test.ts`, 6.0-clean fixture] | TSF injects `baseUrl` whenever it adds workspace or staging `paths` and the user tsconfig has none. 6.0 deprecates `baseUrl` as a lookup root; `paths` must be written relative to the tsconfig instead. | Fix in Phase 2: write injected `paths` relative to `path.dirname(pkg.tsconfig)` with a `./` prefix and stop injecting `baseUrl`. Note `pkg.path` and `dirname(pkg.tsconfig)` coincide for the fixture but need not in general. | 2 |
| B4 | `src/compilers/tsc.ts:81-95` | When the user tsconfig uses `moduleResolution: bundler` and the target overrides `module: commonjs`, TSF downgrades to `Node10`, which 6.0 rejects with TS5107 [verified via `tests/ts6-compat.test.ts`] | Written for 5.x, where bundler required module esnext/preserve. 6.0 explicitly allows bundler + commonjs. | Fix in Phase 2: drop the downgrade on 6.x; on 5.x it is still needed, so the decision (ADR-0002) must state the 5.x fallback: version-gate it, or raise the floor to `>=6`. | 2 |
| B5 | `src/compilers/tsc.ts:170` | Widened-rootDir check resolves `paths` entries against `parsedConfig.options.baseUrl ?? pkg.path` [verified by reading] | Once B3 stops injecting `baseUrl`, entries are tsconfig-relative and this resolution base must change to `dirname(pkg.tsconfig)` or the widening decision silently flips. This is one of the three sites issue 3 patched before. | Fix in Phase 2 together with B3; add the npm-staging column to the rootDir-shape tests (plan-review tension 2). | 2 |
| B6 | `tests/fixture/packages/{app,core}/tsconfig.json` | `tsf build` on the fixture fails under 6.0 before reaching TSF's own injection: two TS5107 (`moduleResolution: node` in both packages) and one `baseUrl` deprecation (`app` declares `"baseUrl": "."`) [verified, both integration suites fail in `beforeAll`] | The fixture represents a 5.x-era user. TSF correctly surfaces the user's deprecations as errors; the fixture itself is not 6.0-clean. | Stopgap applied in this phase: `"ignoreDeprecations": "6.0"` added to both fixture tsconfigs so the integration suites run under 6.0.3 (both green afterwards). Same 5.x caveat as B1. Phase 2 decision: migrate the fixture to `nodenext`/no `baseUrl` (valid on 5.9 and 6.0, see B7) so the integration suites exercise TSF's own injection, and keep `tests/ts6-compat.test.ts`'s legacy-user case as the surfacing test. | 2 |
| B7 | `tests/ts6-compat.test.ts` fixture design | A tsconfig with `moduleResolution: bundler` + `module: commonjs` is accepted by 6.0 but rejected by 5.9.3 (TS5095) [verified: first draft of the compat fixture failed 5 of 6 under 5.9.3, including the no-injection baseline] | 6.0 newly allows the pair; 5.x never did. There is no bundler-based tsconfig that emits CJS cleanly on both. | Compat fixture uses `module: nodenext` + `moduleResolution: nodenext` with no `"type": "module"` (emits CJS, valid and deprecation-free on both versions); a bundler tsconfig is used only to provoke the node10 downgrade (B4). The same choice is the recommended migration for `tests/fixture/` in Phase 2 and for Sharpee-style users in Phase 4. | 1 (done), 2, 4 |

## 2. Default changes and what they touch in TSF

| # | 6.0 change | Effect on TSF or its users | Call | Phase |
|---|---|---|---|---|
| D1 | `module` defaults to `esnext` (was commonjs) [reported] | A user tsconfig without `module` and a target without `module` now emits ESM where 5.x emitted CJS. TSF passes `parsedConfig.options` through, so the change is silent. `resolveModuleKind()` (`src/compilers/tsc.ts:~250`) also lacks `preserve`. | Phase 3: warn when neither side sets `module`, or make the target default explicit; add `preserve` to the map. | 3 |
| D2 | `types` defaults to `[]` (was all `@types/*`) [reported] | TSF's own build passed because every file imports `fs`/`path`, which pulls `@types/node` in by import. User packages relying on ambient `@types/*` globals break on 6.0; TSF's `getPreEmitDiagnostics` surfaces that as ordinary errors, not a TSF defect. | Phase 3: add `"types": ["node"]` to TSF's tsconfig so the dependency is explicit; document for users. | 3 |
| D3 | Default `rootDir` is the tsconfig directory (was longest common path) [reported] | `getOutputEntryPoint()` (three copies: `src/compilers/tsc.ts:441`, `src/transform/imports.ts:240`, `src/transform/declarations.ts:193`) falls back to `'src'` when the tsconfig has no `rootDir`. Wrong on both 5.x and 6.0 and now wrong in a new way. TSF's own tsconfig sets `rootDir` explicitly, so TSF itself is unaffected. | Phase 3: fallback should be the tsconfig directory. Overlaps issue 3 (consolidate the three copies); fix the fallback in all three without consolidating, or consolidate under issue 3 first. | 3 / issue 3 |
| D4 | `strict` defaults to `true` [reported] | TSF already `strict: true`. Users without `strict` see new type errors through TSF; not a TSF defect. | None. Document. | — |
| D5 | `esModuleInterop` / `allowSyntheticDefaultImports` can no longer be `false` [reported] | TSF sets `esModuleInterop: true`. Fixture sets it true. | None. | — |
| D6 | `target` defaults to current-year ES [reported] | TSF and fixture set `target` explicitly. | None. | — |
| D7 | `moduleResolution: classic`, `module: amd/umd/systemjs/none`, `outFile` removed [reported] | `resolveModuleKind()` never mapped these; `TargetConfig.outFile` exists for bundlers only, not passed to tsc. | None. | — |
| D8 | Compiler API "continues to be API compatible with 5.9" [reported] | `createProgram`, `emit`, `getPreEmitDiagnostics`, `readConfigFile`, `parseJsonConfigFileContent`, `transpileModule`, `ts.sys` all still present; TSF's build and 130 non-integration tests pass unchanged. [verified: no API-level failure anywhere] | None for 6.0. TS 7 removes all of these; out of scope. | — |

## 3. Test run record

| Run | Toolchain | Result |
|---|---|---|
| `pnpm build` | 6.0.3, no stopgap | exit 2, B1 |
| `npx tsc --noEmit` | 6.0.3, no stopgap | exit 2, B1 |
| `pnpm exec vitest run` | 6.0.3, no stopgap | 2 suites fail in `beforeAll` (`pnpm build` → B1); 130 passed, 22 skipped |
| `pnpm build` | 6.0.3 + `tsconfig.json` stopgap | green |
| `pnpm exec vitest run` | 6.0.3 + `tsconfig.json` stopgap only | 2 suites fail in `beforeAll` (`tsf build` on fixture → B6); 130 passed, 22 skipped |
| `tests/ts6-compat.test.ts` probe (`it.fails` → `it`) | 6.0.3 | 4 failed, 2 passed; each failure's sole diagnostic is the injected deprecation: `baseUrl` ×3 (B3), `moduleResolution=node10` ×1 (B4) |
| `tests/ts6-compat.test.ts` | 5.9.3 | 6 passed (no `it.fails` under 5.x) |
| `pnpm build` | 5.9.3 + stopgap present | exit 2, `TS5103: Invalid value for '--ignoreDeprecations'` (B1 note) |
| **`pnpm exec vitest run`** | **6.0.3 + `tsconfig.json` and fixture stopgaps** | **13 files / 158 tests green**; compat suite 6 passed, 4 of them `it.fails` |

## 4. ignoreDeprecations decision

`"ignoreDeprecations": "6.0"` is in `tsconfig.json` for the rest of this plan so the suite can run. It must be removed in Phase 3 (plan Exit state: no `ignoreDeprecations`). It is never to be injected into user builds: a user who wants it sets it in their own tsconfig, and TSF already passes it through via `parsedConfig.options`.
