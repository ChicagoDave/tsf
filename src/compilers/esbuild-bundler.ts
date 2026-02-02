import * as fs from 'fs';
import * as path from 'path';
import type { PackageInfo, ResolvedTarget, CompileResult } from '../types';
import * as logger from '../utils/logger';

let esbuild: typeof import('esbuild');

function loadEsbuild(): typeof import('esbuild') {
  if (esbuild) return esbuild;
  try {
    esbuild = require('esbuild');
    return esbuild;
  } catch {
    throw new Error(
      'esbuild is not installed. Install it with: pnpm add -D esbuild',
    );
  }
}

/**
 * Bundle a package using esbuild with bundle:true.
 * Workspace imports are resolved to source entry points and inlined.
 * Supports outFile (single output) and outDir (directory output).
 */
export async function bundleWithEsbuild(
  pkg: PackageInfo,
  target: ResolvedTarget,
  rootDir: string,
  workspacePackages?: Map<string, PackageInfo>,
): Promise<CompileResult> {
  const esb = loadEsbuild();
  const context = `${pkg.name}:${target.name}`;

  // Resolve format
  const format = resolveFormat(target.config.module, target.config.format);

  // Entry point: the package's source entry
  const entryPoint = path.resolve(pkg.path, pkg.entryPoint);

  // External packages (third-party deps the user wants excluded from the bundle)
  const external: string[] = [...(target.config.external || [])];

  // Build a map of workspace package names → source entry points for resolution
  const workspaceResolveMap = new Map<string, string>();
  if (workspacePackages) {
    for (const [depName, depPkg] of workspacePackages) {
      if (depName === pkg.name) continue;
      workspaceResolveMap.set(depName, path.resolve(depPkg.path, depPkg.entryPoint));
    }
  }

  // esbuild plugin to resolve workspace package imports to their source
  const workspacePlugin: import('esbuild').Plugin = {
    name: 'tsf-workspace-resolve',
    setup(build) {
      // Match bare specifiers that are workspace packages
      build.onResolve({ filter: /^[@a-z]/ }, (args) => {
        // Exact match
        if (workspaceResolveMap.has(args.path)) {
          return { path: workspaceResolveMap.get(args.path)! };
        }
        // Deep import: @scope/pkg/sub → resolve relative to package source
        for (const [name, entry] of workspaceResolveMap) {
          if (args.path.startsWith(name + '/')) {
            const subpath = args.path.slice(name.length + 1);
            const depPkg = workspacePackages!.get(name)!;
            const srcDir = path.dirname(path.resolve(depPkg.path, depPkg.entryPoint));
            return { path: path.resolve(srcDir, subpath) };
          }
        }
        return undefined;
      });
    },
  };

  // Determine output options
  const outFile = target.config.outFile
    ? path.resolve(pkg.path, target.config.outFile)
    : undefined;
  const outDir = outFile
    ? undefined
    : path.resolve(pkg.path, target.config.outDir || 'dist');

  // Ensure output directory exists
  const outputDir = outFile ? path.dirname(outFile) : outDir!;
  fs.mkdirSync(outputDir, { recursive: true });

  logger.verbose(`esbuild bundle: format=${format}, ${outFile ? 'outFile=' + outFile : 'outDir=' + outDir}`, context);

  try {
    const buildOptions: import('esbuild').BuildOptions = {
      entryPoints: [entryPoint],
      bundle: true,
      format,
      platform: 'node',
      sourcemap: target.config.sourceMap ?? false,
      external,
      logLevel: 'silent',
      plugins: [workspacePlugin],
    };

    if (outFile) {
      buildOptions.outfile = outFile;
    } else {
      buildOptions.outdir = outDir!;
    }

    if (target.config.banner) {
      buildOptions.banner = { js: target.config.banner };
    }

    if (target.config.target) {
      buildOptions.target = target.config.target;
    }

    const result = await esb.build(buildOptions);

    const diagnostics: string[] = [];
    if (result.errors.length > 0) {
      for (const err of result.errors) {
        diagnostics.push(formatEsbuildMessage(err));
      }
      return { success: false, diagnostics, outputFiles: [] };
    }

    for (const warn of result.warnings) {
      logger.warn(formatEsbuildMessage(warn), context);
    }

    // Collect output files
    const outputFiles: string[] = [];
    if (outFile) {
      if (fs.existsSync(outFile)) outputFiles.push(outFile);
      const mapFile = outFile + '.map';
      if (fs.existsSync(mapFile)) outputFiles.push(mapFile);
    } else {
      collectFiles(outDir!, outputFiles);
    }

    return { success: true, diagnostics: [], outputFiles };
  } catch (err: any) {
    return {
      success: false,
      diagnostics: [err.message || String(err)],
      outputFiles: [],
    };
  }
}

function resolveFormat(module?: string, format?: string): 'cjs' | 'esm' | 'iife' {
  if (format === 'iife') return 'iife';
  if (format === 'esm' || format === 'esmodule') return 'esm';
  if (format === 'cjs' || format === 'commonjs') return 'cjs';

  if (module) {
    const lower = module.toLowerCase();
    if (lower === 'commonjs') return 'cjs';
    if (lower.startsWith('es') || lower === 'nodenext' || lower === 'node16') return 'esm';
  }

  return 'cjs';
}

function formatEsbuildMessage(msg: { text: string; location?: { file?: string; line?: number; column?: number } | null }): string {
  if (msg.location?.file) {
    return `${msg.location.file}(${msg.location.line},${msg.location.column}): ${msg.text}`;
  }
  return msg.text;
}

function collectFiles(dir: string, files: string[]): void {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectFiles(full, files);
    } else if (/\.(js|mjs|cjs|js\.map)$/.test(entry.name)) {
      files.push(full);
    }
  }
}
