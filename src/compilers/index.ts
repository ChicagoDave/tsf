import type { PackageInfo, ResolvedTarget, CompileResult } from '../types';

export type CompileFn = (
  pkg: PackageInfo,
  target: ResolvedTarget,
  rootDir: string,
  workspacePackages?: Map<string, PackageInfo>,
) => CompileResult;

/**
 * Return the appropriate compiler function based on target config.
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
