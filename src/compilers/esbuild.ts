import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';
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
 * Compile a package using esbuild for fast transpilation.
 * esbuild strips types but does not emit .d.ts files.
 * If declarations are requested, a separate tsc --emitDeclarationOnly pass runs.
 */
export function compileWithEsbuild(
  pkg: PackageInfo,
  target: ResolvedTarget,
  rootDir: string,
  workspacePackages?: Map<string, PackageInfo>,
): CompileResult {
  const esb = loadEsbuild();
  const context = `${pkg.name}:${target.name}`;
  const outDir = target.config.outDir
    ? path.resolve(pkg.path, target.config.outDir)
    : path.resolve(pkg.path, 'dist');

  // Resolve format from target config
  const format = resolveFormat(target.config.module, target.config.format);

  // Find source files
  const configFile = ts.readConfigFile(pkg.tsconfig, ts.sys.readFile);
  const parsedConfig = ts.parseJsonConfigFileContent(
    configFile.config || {},
    ts.sys,
    path.dirname(pkg.tsconfig),
  );
  const entryPoints = parsedConfig.fileNames;

  // Workspace package names to mark as external
  const external: string[] = [...(target.config.external || [])];
  if (workspacePackages) {
    for (const depName of workspacePackages.keys()) {
      if (depName !== pkg.name) {
        external.push(depName);
      }
    }
  }

  logger.verbose(`esbuild: ${entryPoints.length} files, format=${format}`, context);

  try {
    const result = esb.buildSync({
      entryPoints,
      outdir: outDir,
      format,
      platform: 'node',
      sourcemap: target.config.sourceMap ?? false,
      external,
      logLevel: 'silent',
      // Transpile only — each file individually, no bundling
      bundle: false,
      // Preserve directory structure relative to source root
      outbase: path.dirname(path.resolve(pkg.path, pkg.entryPoint)),
    });

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
    collectFiles(outDir, outputFiles);

    // Emit declarations separately if requested
    if (target.config.declarations) {
      logger.verbose('Running tsc --emitDeclarationOnly for declarations', context);
      const declResult = emitDeclarationsOnly(pkg, target, outDir, parsedConfig);
      diagnostics.push(...declResult.diagnostics);
      outputFiles.push(...declResult.outputFiles);
      if (!declResult.success) {
        return { success: false, diagnostics, outputFiles };
      }
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
    } else if (/\.(js|mjs|cjs|d\.ts|js\.map|d\.ts\.map)$/.test(entry.name)) {
      files.push(full);
    }
  }
}

/**
 * Run tsc in declaration-only mode to emit .d.ts files alongside esbuild output.
 */
function emitDeclarationsOnly(
  pkg: PackageInfo,
  target: ResolvedTarget,
  outDir: string,
  parsedConfig: ts.ParsedCommandLine,
): CompileResult {
  const options: ts.CompilerOptions = {
    ...parsedConfig.options,
    outDir,
    declaration: true,
    declarationMap: target.config.declarationMap ?? false,
    emitDeclarationOnly: true,
    noEmit: false,
  };

  const program = ts.createProgram({
    rootNames: parsedConfig.fileNames,
    options,
  });

  const emitResult = program.emit();
  const allDiagnostics = ts.getPreEmitDiagnostics(program).concat(emitResult.diagnostics);
  const diagnostics: string[] = [];

  for (const diag of allDiagnostics) {
    if (diag.file && diag.start !== undefined) {
      const { line, character } = diag.file.getLineAndCharacterOfPosition(diag.start);
      const message = ts.flattenDiagnosticMessageText(diag.messageText, '\n');
      diagnostics.push(`${diag.file.fileName}(${line + 1},${character + 1}): ${message}`);
    } else {
      diagnostics.push(ts.flattenDiagnosticMessageText(diag.messageText, '\n'));
    }
  }

  const outputFiles: string[] = [];
  collectFiles(outDir, outputFiles);

  return {
    success: !emitResult.emitSkipped && diagnostics.length === 0,
    diagnostics,
    outputFiles,
  };
}
