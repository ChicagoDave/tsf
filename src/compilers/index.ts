/**
 * @fileoverview Compiler and bundler adapter registry
 * @module tsf/compilers
 *
 * Provides a unified interface to different TypeScript compilation strategies.
 * Supports multiple transpilers and bundlers with a common signature.
 *
 * **Transpilers** (file-by-file compilation):
 * - `tsc` (default) - TypeScript compiler, full type checking
 * - `esbuild` - Fast transpilation, optional type checking
 * - `swc` - Rust-based transpiler (not yet implemented)
 *
 * **Bundlers** (single-file output):
 * - `esbuild` (default) - Fast bundling with tree-shaking
 * - `rollup` - Flexible bundling with plugin ecosystem
 *
 * @example
 * ```typescript
 * const compile = getCompiler('esbuild');
 * const result = compile(pkg, target, rootDir, packages);
 * ```
 */

import type { PackageInfo, ResolvedTarget, CompileResult } from '../types';

/**
 * Signature for transpiler functions (file-by-file compilation).
 */
export type CompileFn = (
  pkg: PackageInfo,
  target: ResolvedTarget,
  rootDir: string,
  workspacePackages?: Map<string, PackageInfo>,
  npmStagingDir?: string,
) => CompileResult;

/**
 * Signature for bundler functions (single-file output).
 * May be async due to bundler plugin requirements.
 */
export type BundleFn = (
  pkg: PackageInfo,
  target: ResolvedTarget,
  rootDir: string,
  workspacePackages?: Map<string, PackageInfo>,
) => CompileResult | Promise<CompileResult>;

/**
 * Returns the appropriate transpiler function for a target.
 *
 * @param transpiler - Transpiler name: 'tsc', 'esbuild', or 'swc'
 * @returns Compilation function
 * @throws {Error} If transpiler is not supported
 *
 * @example
 * ```typescript
 * const compile = getCompiler('tsc');
 * const result = compile(pkg, target, rootDir);
 * ```
 */
export function getCompiler(transpiler?: string): CompileFn {
  switch (transpiler) {
    case 'esbuild':
      return require('./esbuild').compileWithEsbuild;
    case 'swc':
      throw new Error('SWC compiler adapter is not yet implemented');
    case 'tsc':
    default:
      return require('./tsc').compile;
  }
}

/**
 * Returns the appropriate bundler function for a target.
 * Bundlers inline all dependencies into a single output file.
 *
 * @param bundler - Bundler name: 'esbuild' or 'rollup'
 * @returns Bundling function
 *
 * @example
 * ```typescript
 * const bundle = getBundler('rollup');
 * const result = await bundle(pkg, target, rootDir, packages);
 * ```
 */
export function getBundler(bundler?: string): BundleFn {
  switch (bundler) {
    case 'rollup':
      return require('./rollup-bundler').bundleWithRollup;
    case 'esbuild':
    default:
      return require('./esbuild-bundler').bundleWithEsbuild;
  }
}
