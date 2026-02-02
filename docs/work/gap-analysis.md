# Gap Analysis: TSF vs Sharpee Monorepo

Findings from running TSF against the [sharpee](https://github.com/ChicagoDave/sharpee) monorepo (31 packages, pnpm workspace).

## Gap 1: Per-Package Target Scoping

**Severity: High**

TSF applies every target to every package. Sharpee has 31 packages but only 19 are published to npm (those with `publishConfig` in package.json). The remaining 12 (stories, platforms, internal tools) should never get an `npm` target build.

**Evidence:** `tsf info` shows both `local` and `npm` targets applied to all 31 packages. The `condition: "publish"` flag controls *when* to build the target, not *which packages* it applies to.

**Published packages (19):**
- core, engine, event-processor, if-domain, if-services, lang-en-us, parser-en-us
- plugin-npc, plugin-scheduler, plugin-state-machine, plugins
- sharpee, stdlib, text-blocks, text-service, world-model
- forge, extensions/conversation, extensions/testing

**Non-published packages (12):**
- stories (5): dungeo, reflections, cloak-of-darkness, armoured, secretletter2025
- platforms (3): cli-en-us, browser-en-us, test
- internal (4): map-editor, platform-browser, transcript-tester, zifmia

**Proposed solutions (pick one or combine):**

A. **Target-level `packages` filter** — explicit include list:
```json
"npm": {
  "outDir": "dist-npm",
  "imports": "relative",
  "packages": ["@sharpee/core", "@sharpee/engine", "..."]
}
```

B. **Target-level `exclude` filter** — glob-based:
```json
"npm": {
  "outDir": "dist-npm",
  "imports": "relative",
  "excludePackages": ["@sharpee/story-*", "@sharpee/platform-*"]
}
```

C. **Auto-detect from `publishConfig`** — if a target has `condition: "publish"`, only apply to packages with `publishConfig` or `"private": false` in their package.json.

D. **Per-package overrides** — sharpee packages already support `ts-forge.json` per-package overrides, but there's no way to *exclude* a target entirely.

Option C is the most ergonomic (zero config) and matches real-world intent. Option B is the most flexible. They could coexist.

## Gap 2: Init Detection Missed Existing Dual-Target Setup

**Severity: Medium**

`tsf init` fell back to the "monorepo" template with a single `local` target, despite every published package already having `dist-npm` output dirs and dual exports in their package.json. The detection logic reads `package.json` exports to infer targets, but it only reads the *root* package.json (which is `private: true` with no exports).

**Expected:** Init should scan a sample of workspace package.json files (not just root) to detect the common target pattern across the monorepo.

**Proposed fix:** In monorepo mode, read the first N package.json files (or all of them) and look for common output dir patterns (`dist`, `dist-npm`, `dist-esm`, etc.) to infer targets.

## Gap 3: Init Doesn't Read tsconfig.json `outDir`

**Severity: Low**

Each sharpee package has `"outDir": "./dist"` in its tsconfig.json, and `tsconfig.base.json` sets `"module": "commonjs"`, `"declaration": true`. Init could use this to infer more accurate target defaults instead of hardcoded template values. Currently the detection reads tsconfig for module/target/sourceMap but not outDir.

## Gap 4: Sync Overwrites Existing Correct Fields

**Severity: Medium**

`tsf sync` overwrote sharpee's existing `main: "dist-npm/index.js"` with `main: "./dist/index.js"` because the config only had one target. Even with dual targets configured, sync generates fields based on target config, potentially conflicting with hand-maintained package.json fields that point to the *npm* output for publish.

**Expected behavior:** Sync should understand which target's output is intended for the published package.json fields. The `npm` target (with `condition: "publish"`) should be the source of truth for `main`/`types`/`exports`, not the `local` target.

**Proposed fix:** When generating package.json fields, prefer the target with `condition: "publish"` for the top-level fields. Or allow specifying which target maps to package.json fields:
```json
"npm": {
  "outDir": "dist-npm",
  "condition": "publish",
  "packageJsonTarget": true
}
```

## Gap 5: Validate Checks `module` Field It Didn't Generate

**Severity: Low**

After sync, some packages retained their original `"module": "dist-npm/index.js"` field (sync didn't overwrite it because no ESM target existed to generate a `module` field). Validate then flagged it as missing. This is technically correct but confusing — validate is checking a field that predates TSF.

**Proposed fix:** Validate could distinguish between TSF-managed fields and pre-existing fields, or sync could explicitly clear fields it can't generate (with a warning).

## Summary

| Gap | Severity | Effort | Impact |
|-----|----------|--------|--------|
| Per-package target scoping | High | Medium | Blocks real monorepo use |
| Init monorepo detection | Medium | Medium | Poor first-run experience |
| Sync publish target preference | Medium | Low | Wrong package.json fields |
| Init tsconfig outDir reading | Low | Low | Minor default inaccuracy |
| Validate pre-existing fields | Low | Low | Confusing warnings |

Gap 1 (per-package target scoping) is the most critical — without it, TSF can't correctly model any monorepo where not all packages share all targets. This is the common case.
