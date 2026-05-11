/**
 * @fileoverview Core type definitions for TypeScript Forge (TSF)
 * @module tsf/types
 *
 * This module defines the configuration schema and internal data structures
 * used throughout TSF. These types form the contract between:
 * - User configuration (tsf.config.json)
 * - Internal build orchestration
 * - Compiler adapters
 * - Output transformation
 *
 * @see {@link https://github.com/AshwinSundar/tsf} for full documentation
 */

// ============================================================================
// Configuration Types
// ============================================================================

/**
 * Root configuration object for TSF.
 * Typically loaded from `tsf.config.json` in the workspace root.
 *
 * @example
 * ```json
 * {
 *   "$schema": "https://tsf.dev/schema.json",
 *   "projects": ["packages/*"],
 *   "targets": {
 *     "local": { "module": "ESNext", "outDir": "dist" },
 *     "npm": { "module": "CommonJS", "outDir": "dist-npm", "imports": "relative" }
 *   }
 * }
 * ```
 */
export interface TsForgeConfig {
  /** Optional JSON schema reference for IDE validation */
  $schema?: string;
  /** Glob patterns matching package directories to build */
  projects: string[];
  /** Named build targets with their configurations */
  targets?: Record<string, TargetConfig>;
  /** Default settings applied to all targets */
  defaults?: DefaultConfig;
}

/**
 * Configuration for a single build target.
 * Targets define how source code is compiled, transformed, and output.
 *
 * @example
 * ```json
 * {
 *   "module": "ESNext",
 *   "outDir": "dist",
 *   "imports": "preserve",
 *   "declarations": true,
 *   "sourceMap": true
 * }
 * ```
 */
export interface TargetConfig {
  /** TypeScript module format: "ESNext", "CommonJS", "ES2020", etc. */
  module?: string;
  /** Output format hint for bundlers: "esm", "cjs", "iife" */
  format?: string;
  /** Output directory relative to package root */
  outDir?: string;
  /** Single output file for bundled builds */
  outFile?: string;
  /** How to handle workspace imports in output */
  imports?: ImportStrategy;
  /** How relative imports are calculated: 'path' (../pkg/dist) or 'peer' (../pkg) */
  relativeMode?: 'path' | 'peer';
  /** Generate .d.ts declaration files */
  declarations?: boolean;
  /** Generate .d.ts.map source maps for declarations */
  declarationMap?: boolean;
  /** Generate .js.map source maps */
  sourceMap?: boolean;
  /** Conditional build flag: "publish" targets only build with --npm */
  condition?: string;
  /** File extension remapping: { ".js": ".mjs", ".d.ts": ".d.mts" } */
  extensionMap?: Record<string, string>;
  /** Transpiler to use: tsc (default), esbuild (faster), or swc */
  transpiler?: 'tsc' | 'esbuild' | 'swc';
  /** Bundler for single-file output: esbuild or rollup */
  bundler?: 'esbuild' | 'rollup';
  /** Packages to mark as external (not bundled) */
  external?: string[];
  /** Banner comment prepended to output files */
  banner?: string;
  /** ECMAScript target: "ES2020", "ES2022", "ESNext" */
  target?: string;
  /** Run type checking during build */
  typeCheck?: boolean;
  /** Clean output directory before build */
  clean?: boolean;
  /** Path to import map JSON for specifier-map strategy */
  importMap?: string;
  /**
   * When true, append Node-ESM-required file extensions to relative
   * import specifiers in emitted JS files:
   * - `./foo` becomes `./foo.js` when `./foo.js` exists in the output
   * - `./foo` becomes `./foo/index.js` when `./foo/index.js` exists
   *
   * Defaults to false. Required for ESM output that will be consumed
   * by strict Node ESM (Node 22+ with `--input-type=module` or `"type":
   * "module"` packages). Idempotent — already-extensioned specifiers
   * are left alone. Only relative paths are rewritten; bare specifiers
   * (`@scope/pkg`, `lodash`) are handled by the `imports` strategy.
   */
  esmExtensions?: boolean;
}

/**
 * Strategy for handling `@scope/package` workspace imports in output.
 *
 * - `preserve`: Keep imports as-is (for local development)
 * - `relative`: Rewrite to relative paths (for npm publish)
 * - `bundle`: Inline dependencies (single-file output)
 * - `specifier-map`: Use import map for custom resolution
 */
export type ImportStrategy = 'preserve' | 'relative' | 'bundle' | 'specifier-map';

/**
 * Default settings applied to all targets unless overridden.
 */
export interface DefaultConfig {
  /** Default transpiler for all targets */
  transpiler?: 'tsc' | 'esbuild' | 'swc';
  /** Enable type checking by default */
  typeCheck?: boolean;
  /** Generate source maps by default */
  sourceMap?: boolean;
  /** Clean output directories by default */
  clean?: boolean;
}

/**
 * Per-package configuration overrides.
 * Stored in `tsf.package.json` within each package directory.
 *
 * @example
 * ```json
 * {
 *   "targets": {
 *     "local": { "skip": true },
 *     "npm": { "external": ["lodash"] }
 *   }
 * }
 * ```
 */
export interface PackageOverride {
  /** Target-specific overrides; use `skip: true` to exclude a target */
  targets?: Record<string, Partial<TargetConfig> & { skip?: boolean }>;
  assets?: string[];
}

// ============================================================================
// Runtime Types
// ============================================================================

/**
 * Resolved metadata for a workspace package.
 * Built by the resolver after scanning the workspace.
 */
export interface PackageInfo {
  /** Package name from package.json (e.g., "@scope/pkg") */
  name: string;
  /** Absolute path to package directory */
  path: string;
  /** Path to package's tsconfig.json */
  tsconfig: string;
  /** Names of workspace packages this package depends on */
  dependencies: string[];
  /** Main entry point file (e.g., "src/index.ts") */
  entryPoint: string;
  /** Package version from package.json */
  version?: string;
}

/**
 * A build target with its configuration fully resolved.
 * Created by merging defaults, target config, and package overrides.
 */
export interface ResolvedTarget {
  /** Target name (e.g., "local", "npm", "esm") */
  name: string;
  /** Fully resolved configuration with required fields guaranteed */
  config: TargetConfig & { imports: ImportStrategy };
}

/**
 * Complete build context passed to the orchestrator.
 * Contains all information needed to execute a build.
 */
export interface BuildContext {
  /** Workspace root directory (where tsf.config.json lives) */
  rootDir: string;
  /** Loaded and validated configuration */
  config: TsForgeConfig;
  /** Map of package name → PackageInfo */
  packages: Map<string, PackageInfo>;
  /** Topologically sorted build order (array of parallel levels) */
  buildOrder: string[][];
  /** Resolved targets to build */
  targets: ResolvedTarget[];
}

/**
 * Options passed to the build command.
 * Parsed from CLI arguments.
 */
export interface BuildOptions {
  /** Filter to specific target names */
  target?: string[];
  /** Filter to targets with specific conditions */
  condition?: string[];
  /** Build all targets (ignore condition filtering) */
  all?: boolean;
  /** Build for npm publish (uses staging directory) */
  npm?: boolean;
  /** Run type checking only (no emit) */
  check?: boolean;
  /** Skip type checking */
  noCheck?: boolean;
  /** Clean output directories before build */
  clean?: boolean;
  /** Enable verbose logging */
  verbose?: boolean;
  /** Watch mode for incremental rebuilds */
  watch?: boolean;
  /** Max concurrent package builds */
  parallel?: number;
  /** Restrict to specific package(s) by name */
  filter?: string[];
}

/**
 * Result from a single compilation operation.
 */
export interface CompileResult {
  /** Whether compilation succeeded without errors */
  success: boolean;
  /** TypeScript diagnostic messages (errors and warnings) */
  diagnostics: string[];
  /** Paths to generated output files */
  outputFiles: string[];
}

/**
 * Detected workspace package manager type.
 * Determines how packages are discovered and linked.
 */
export type WorkspaceType = 'pnpm' | 'npm' | 'yarn';
