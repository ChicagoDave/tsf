/**
 * @fileoverview TypeScript Forge (TSF) - Multi-target TypeScript build tool
 * @module tsf
 *
 * TSF compiles TypeScript monorepos to multiple output formats with automatic
 * workspace import resolution. It solves the full matrix of:
 * - Multiple targets (ESM, CJS, bundled)
 * - Module formats (ESNext, CommonJS, ES2020)
 * - Import strategies (preserve for dev, relative for npm publish)
 *
 * ## Key Features
 * - Rewrites `@scope/package` imports to relative paths for npm publish
 * - Generates clean package.json manifests without `workspace:*` dependencies
 * - Parallel builds with dependency-aware ordering
 * - Incremental caching with content-hash invalidation
 * - Multiple transpiler support (tsc, esbuild, swc)
 *
 * ## Quick Start
 * ```typescript
 * import { build, loadConfig } from 'tsf';
 *
 * const config = await loadConfig('tsf.config.json');
 * await build({ target: ['local'] });
 * ```
 *
 * @see {@link https://github.com/AshwinSundar/tsf} for full documentation
 */

// ============================================================================
// Type Exports
// ============================================================================

export type {
  TsForgeConfig,
  TargetConfig,
  DefaultConfig,
  PackageInfo,
  PackageOverride,
  ResolvedTarget,
  BuildContext,
  BuildOptions,
  CompileResult,
  ImportStrategy,
  WorkspaceType,
} from './types';

// ============================================================================
// Configuration
// ============================================================================

export { findConfigFile, loadConfig, loadPackageOverride } from './config/loader';
export { validateConfig } from './config/validator';
export { resolveTargets, applyPackageOverride } from './config/defaults';

// ============================================================================
// Workspace Resolution
// ============================================================================

export { detectWorkspace } from './resolver/workspace';
export { resolvePackages } from './resolver/packages';
export { getBuildOrder } from './resolver/graph';

// ============================================================================
// Compilers & Bundlers
// ============================================================================

export { compile } from './compilers/tsc';
export { compileWithEsbuild } from './compilers/esbuild';
export { getCompiler, getBundler } from './compilers';
export { bundleWithEsbuild } from './compilers/esbuild-bundler';
export { bundleWithRollup } from './compilers/rollup-bundler';

// ============================================================================
// Output Transformation
// ============================================================================

export { transformImports } from './transform/imports';
export { transformDeclarations } from './transform/declarations';

// ============================================================================
// Build Infrastructure
// ============================================================================

export { computeCacheKey, isCached, recordBuild, loadCacheEntry, cleanCache } from './cache';
export { createWatcher } from './watcher';

// ============================================================================
// Orchestration (Main Entry Points)
// ============================================================================

export { build, buildWatch, check, info, loadBuildContextPublic, shouldSkipTarget, getPublishStagingDir } from './orchestrator';

// ============================================================================
// Package Sync & Validation
// ============================================================================

export { syncPackageJson, generateFields, stripWorkspaceDeps, generatePublishManifest } from './sync/package-json';
export { validatePackageOutputs, runValidation } from './validate';

// ============================================================================
// CLI Utilities
// ============================================================================

export { init } from './cli/init';
export { generateGitHubAction } from './cli/gh-action';
