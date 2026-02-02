# ADR-001: VS Code Extension for ts-forge

**Status:** Accepted
**Date:** 2026-02-01
**Context:** IDE support design (see architecture.md, BUILD vs EDITOR mode)

## Context

ts-forge's BUILD/EDITOR mode separation ensures the IDE always reads the user's original `tsconfig.json` with source-pointing `paths`. This works without any editor integration — tsserver resolves workspace imports, go-to-definition lands on `.ts` source, and diagnostics are accurate.

However, ts-forge has information the IDE doesn't:

1. **Target awareness.** The user is editing source that produces N outputs. Errors may be target-specific (e.g., using `import.meta.url` in source that targets CJS).
2. **Build status.** Which packages are stale, which targets have been built, what failed.
3. **Import resolution preview.** What a workspace import resolves to for each target — useful for debugging publish issues.
4. **Config validation.** Whether `ts-forge.config.json` is well-formed, whether targets conflict, whether `paths` are in sync with workspace topology.

A VS Code extension can surface this information without replacing tsserver or duplicating type checking.

## Decision

Build a lightweight VS Code extension that **complements tsserver** rather than replacing it. The extension is optional — ts-forge works fully without it.

## Architecture

### What the Extension Does

#### 1. Target-Aware Diagnostics (Warning Layer)

The extension runs ts-forge's config resolver and import transformer in analysis mode to produce **warnings** (not errors) for target-specific issues:

- **CJS/ESM compatibility:** Flag `import.meta`, top-level `await`, `__dirname`/`__filename` usage in source that targets both CJS and ESM. These aren't TypeScript errors but will fail at runtime for specific targets.
- **Unresolvable workspace imports:** A workspace import that can't be rewritten for a specific target (e.g., the dependency doesn't define an entry point compatible with the target's module format).
- **Missing declarations:** Source exports types consumed by a target with `"declarations": true`, but the dependency doesn't emit declarations.

These appear as VS Code diagnostics with a `ts-forge` source label, separate from TypeScript's own diagnostics. Severity is `Warning` or `Information`, never `Error` — ts-forge does not override tsserver's authority on type errors.

#### 2. Config File Support

- **JSON schema** for `ts-forge.config.json` and per-package `ts-forge.json` — provides autocomplete and validation in the editor.
- **Hover information** on config keys explaining what they do.
- **CodeLens** on target definitions showing quick actions: "Build this target", "Show resolved config".

#### 3. Status Bar and Build Integration

- **Status bar item** showing current ts-forge state: idle, building (with target name), error count.
- **Build commands** in the command palette: `ts-forge: Build`, `ts-forge: Build Target...`, `ts-forge: Check`, `ts-forge: Clean`.
- **Problem matcher** for build output so errors appear in the Problems panel with clickable file locations.
- **Task provider** that registers ts-forge build targets as VS Code tasks, runnable from the task picker.

#### 4. Import Resolution Lens

A CodeLens or hover provider on workspace import lines showing how the import resolves per target:

```typescript
import { WorldModel } from '@sharpee/world-model';
// CodeLens: local → @sharpee/world-model | npm-cjs → ../../world-model/dist-npm/index.js | npm-esm → ../../world-model/dist-esm/index.mjs
```

This is the highest-value debugging feature for the import rewriting system. When a published package has broken imports, the developer can see exactly what ts-forge will produce without running a build.

#### 5. `paths` Sync Notification

If the extension detects that a package's `tsconfig.json` has workspace `paths` that are out of sync with the actual workspace topology (new package added, package renamed, dependency changed), it shows a notification with a quick-fix to run `ts-forge init --editor`.

### What the Extension Does NOT Do

- **No custom language server.** tsserver handles all TypeScript intelligence. The extension uses VS Code's diagnostic API to add supplementary warnings.
- **No type checking.** ts-forge's resolved question 1 applies here too — the extension never creates a `ts.Program`.
- **No file watching for builds.** `ts-forge build --watch` is a CLI concern. The extension can start/stop watch mode via tasks but doesn't implement its own watcher.
- **No modification of tsconfig.json.** Consistent with the BUILD/EDITOR mode rule. The extension may suggest changes but never writes to tsconfig without explicit user action.

### Extension Architecture

```
┌─────────────────────────────────────────────┐
│            VS Code Extension Host            │
├──────────┬──────────┬──────────┬────────────┤
│ Diagnostic│ Config   │ Build    │ CodeLens   │
│ Provider  │ Schema   │ Tasks    │ (imports)  │
├───────────┴─────┬────┴──────┬──┴────────────┤
│   ts-forge Core (imported as library)        │
│   - Config resolver                          │
│   - Workspace resolver                       │
│   - Import transformer (analysis mode)       │
├──────────────────────────────────────────────┤
│   VS Code API                                │
│   - DiagnosticCollection                     │
│   - TaskProvider                             │
│   - CodeLensProvider                         │
│   - StatusBarItem                            │
└──────────────────────────────────────────────┘
```

The extension imports ts-forge's core modules as a library. No separate process, no IPC — the config resolver, workspace resolver, and import transformer run in-process in the extension host. This is feasible because these modules are lightweight (no tsc program, no compilation). The heavy work (actual builds) runs as external tasks.

### Activation

The extension activates when:
- A `ts-forge.config.json` file exists in the workspace root
- The user opens a file in a directory containing `ts-forge.config.json`

It does **not** activate in non-ts-forge projects.

## Consequences

### Positive

- Developers get target-aware feedback without leaving the editor.
- Import resolution preview eliminates the "build and check" loop for debugging publish issues.
- Config autocomplete reduces typos and speeds up setup.
- Build integration brings ts-forge into the standard VS Code workflow (tasks, problem matcher, status bar).
- The extension is optional — no lock-in, no degraded experience without it.

### Negative

- Another package to maintain and release alongside the CLI.
- ts-forge core must be structured as an importable library, not just a CLI — this is an architectural constraint on the core package. (But this is a good constraint that also enables programmatic API usage.)
- Target-aware diagnostics could confuse users if they conflict with tsserver's view. Mitigation: always use `Warning`/`Information` severity, clearly label as `ts-forge`, and provide explanatory messages.

### Risks

- **Performance.** The workspace resolver and import transformer running on every file save could be slow for very large monorepos. Mitigation: debounce analysis, cache workspace topology, only re-analyze changed files and their direct dependents.
- **VS Code coupling.** Building for VS Code first may delay support for other editors (Neovim, JetBrains). Mitigation: the core analysis logic lives in ts-forge's library, not in the extension. Other editor plugins can import the same modules. The extension is a thin adapter over VS Code's API.

## Implementation Notes

### Phase 1 (Ship with CLI v1)
- JSON schema for config files (zero-cost, just a schema file)
- Task provider and problem matcher (standard VS Code integration)
- Status bar item

### Phase 2 (Post CLI v1)
- Target-aware diagnostics
- Import resolution CodeLens
- `paths` sync notification

### Phase 3 (Community feedback)
- Inline build error decoration
- Target picker (switch which target's diagnostics are shown)
- Workspace visualization (dependency graph view)

## Alternatives Considered

### 1. TypeScript Plugin (tsserver plugin) Instead of VS Code Extension

A tsserver plugin would work in any editor, not just VS Code. However:
- tsserver plugins are limited to augmenting completions, diagnostics, and quick fixes within the TypeScript language service. They can't add CodeLens, status bar items, tasks, or config file support.
- tsserver plugins run inside the TypeScript process and can degrade performance or crash tsserver.
- The plugin API is underdocumented and changes between TypeScript versions.

**Verdict:** A tsserver plugin could supplement the VS Code extension for the diagnostic layer specifically (making target-aware warnings available in any editor). But it cannot replace the full extension. Worth considering as a Phase 3 addition.

### 2. No Editor Integration — CLI Only

The BUILD/EDITOR mode separation already provides a workable experience. However, the import resolution preview and target-aware diagnostics are high-value features that significantly reduce the debugging loop for the core problem ts-forge solves (import rewriting). A CLI-only approach means developers must run builds to verify import resolution, which defeats the fast-feedback goal.

### 3. Full Language Server (LSP)

A standalone LSP implementation would work in any editor. However:
- ts-forge doesn't need to provide completions, hover, go-to-definition, or any feature tsserver already handles.
- An LSP server is significantly more complex to build and maintain than a VS Code extension that uses the editor's native API.
- The features we need (diagnostics, CodeLens, tasks) are simpler to implement via VS Code's extension API.

**Verdict:** Overkill. If multi-editor support becomes critical, a tsserver plugin (alternative 1) covers the most important feature (diagnostics) with less effort than a full LSP.
