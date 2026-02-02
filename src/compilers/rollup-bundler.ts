import * as fs from 'fs';
import * as path from 'path';
import type { PackageInfo, ResolvedTarget, CompileResult } from '../types';
import * as logger from '../utils/logger';

let rollup: typeof import('rollup');

function loadRollup(): typeof import('rollup') {
  if (rollup) return rollup;
  try {
    rollup = require('rollup');
    return rollup;
  } catch {
    throw new Error(
      'rollup is not installed. Install it with: pnpm add -D rollup',
    );
  }
}

/**
 * Bundle a package using Rollup for tree-shaking.
 * Workspace imports are resolved to source entry points and inlined.
 */
export async function bundleWithRollup(
  pkg: PackageInfo,
  target: ResolvedTarget,
  rootDir: string,
  workspacePackages?: Map<string, PackageInfo>,
): Promise<CompileResult> {
  const { rollup: rollupBuild } = loadRollup();

  const context = `${pkg.name}:${target.name}`;
  const format = resolveRollupFormat(target.config.module, target.config.format);
  const entryPoint = path.resolve(pkg.path, pkg.entryPoint);

  // External packages
  const external: string[] = [...(target.config.external || [])];

  // Build workspace resolution map
  const workspaceResolveMap = new Map<string, string>();
  if (workspacePackages) {
    for (const [depName, depPkg] of workspacePackages) {
      if (depName === pkg.name) continue;
      workspaceResolveMap.set(depName, path.resolve(depPkg.path, depPkg.entryPoint));
    }
  }

  // Rollup plugin for workspace resolution
  const workspacePlugin: import('rollup').Plugin = {
    name: 'tsf-workspace-resolve',
    resolveId(source) {
      if (workspaceResolveMap.has(source)) {
        return workspaceResolveMap.get(source)!;
      }
      for (const [name, entry] of workspaceResolveMap) {
        if (source.startsWith(name + '/')) {
          const subpath = source.slice(name.length + 1);
          const depPkg = workspacePackages!.get(name)!;
          const srcDir = path.dirname(path.resolve(depPkg.path, depPkg.entryPoint));
          return path.resolve(srcDir, subpath);
        }
      }
      return null;
    },
  };

  // Rollup plugin for TypeScript (simple transpile via esbuild or sucrase)
  // We use a minimal approach: load .ts files and strip types
  const typescriptPlugin: import('rollup').Plugin = {
    name: 'tsf-typescript',
    async transform(code, id) {
      if (!/\.tsx?$/.test(id)) return null;
      // Use esbuild for type stripping if available, otherwise try sucrase
      try {
        const esb = require('esbuild');
        const result = esb.transformSync(code, {
          loader: id.endsWith('.tsx') ? 'tsx' : 'ts',
          format,
          sourcemap: target.config.sourceMap ?? false,
        });
        return { code: result.code, map: result.map || null };
      } catch {
        // Fallback: strip type annotations with TypeScript compiler API
        const ts = require('typescript');
        const result = ts.transpileModule(code, {
          compilerOptions: {
            module: ts.ModuleKind.ESNext,
            target: ts.ScriptTarget.ESNext,
            sourceMap: target.config.sourceMap ?? false,
          },
          fileName: id,
        });
        return { code: result.outputText, map: result.sourceMapText || null };
      }
    },
  };

  // Determine output
  const outFile = target.config.outFile
    ? path.resolve(pkg.path, target.config.outFile)
    : undefined;
  const outDir = outFile
    ? undefined
    : path.resolve(pkg.path, target.config.outDir || 'dist');

  const outputDir = outFile ? path.dirname(outFile) : outDir!;
  fs.mkdirSync(outputDir, { recursive: true });

  logger.verbose(`rollup bundle: format=${format}, ${outFile ? 'outFile=' + outFile : 'outDir=' + outDir}`, context);

  try {
    const bundle = await rollupBuild({
      input: entryPoint,
      plugins: [workspacePlugin, typescriptPlugin],
      external: (id) => {
        // Mark explicitly external packages
        if (external.includes(id)) return true;
        // Mark node builtins as external
        if (id.startsWith('node:') || ['fs', 'path', 'os', 'crypto', 'util', 'stream', 'events', 'child_process', 'http', 'https', 'url', 'querystring', 'buffer', 'assert', 'zlib', 'net', 'tls', 'dns', 'dgram', 'cluster', 'worker_threads', 'perf_hooks', 'async_hooks', 'v8', 'vm', 'module', 'readline', 'repl', 'inspector', 'tty'].includes(id)) return true;
        // External if it's a bare specifier not in workspace
        if (/^[@a-z]/.test(id) && !workspaceResolveMap.has(id)) {
          for (const name of workspaceResolveMap.keys()) {
            if (id.startsWith(name + '/')) return false;
          }
          return true;
        }
        return false;
      },
      onwarn(warning, handler) {
        logger.verbose(`rollup warning: ${warning.message}`, context);
      },
    });

    const outputOptions: import('rollup').OutputOptions = {
      format,
      sourcemap: target.config.sourceMap ?? false,
    };

    if (outFile) {
      outputOptions.file = outFile;
    } else {
      outputOptions.dir = outDir!;
    }

    if (target.config.banner) {
      outputOptions.banner = target.config.banner;
    }

    const { output } = await bundle.write(outputOptions);
    await bundle.close();

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

function resolveRollupFormat(module?: string, format?: string): 'cjs' | 'es' | 'iife' {
  if (format === 'iife') return 'iife';
  if (format === 'esm' || format === 'esmodule' || format === 'es') return 'es';
  if (format === 'cjs' || format === 'commonjs') return 'cjs';

  if (module) {
    const lower = module.toLowerCase();
    if (lower === 'commonjs') return 'cjs';
    if (lower.startsWith('es') || lower === 'nodenext' || lower === 'node16') return 'es';
  }

  return 'cjs';
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
