/**
 * @fileoverview TypeScript compiler (tsc) adapter
 * @module tsf/compilers/tsc
 *
 * Full TypeScript compilation using the official tsc compiler.
 * This is the default transpiler for TSF, providing:
 * - Complete type checking
 * - Declaration file (.d.ts) generation
 * - Source map generation
 * - Cross-package path resolution
 *
 * Handles complex monorepo scenarios:
 * - Automatic workspace package path injection
 * - rootDir widening for cross-package imports
 * - Output flattening when rootDir is widened
 * - Module resolution compatibility fixes
 *
 * @example
 * ```typescript
 * const result = compile(pkg, target, rootDir, packages);
 * if (!result.success) {
 *   result.diagnostics.forEach(d => console.error(d));
 * }
 * ```
 */

import * as ts from 'typescript';
import * as fs from 'fs';
import * as path from 'path';
import type { PackageInfo, ResolvedTarget, CompileResult } from '../types';
import * as logger from '../utils/logger';

/**
 * Compiles a package using the TypeScript compiler.
 *
 * @param pkg - Package to compile
 * @param target - Build target configuration
 * @param rootDir - Workspace root directory
 * @param workspacePackages - All workspace packages (for path injection)
 * @returns Compilation result with success status, diagnostics, and output files
 */
export function compile(
  pkg: PackageInfo,
  target: ResolvedTarget,
  rootDir: string,
  workspacePackages?: Map<string, PackageInfo>,
): CompileResult {
  const context = `${pkg.name}:${target.name}`;

  // Read the package's tsconfig
  const configFile = ts.readConfigFile(pkg.tsconfig, ts.sys.readFile);
  if (configFile.error) {
    const msg = ts.flattenDiagnosticMessageText(configFile.error.messageText, '\n');
    return { success: false, diagnostics: [msg], outputFiles: [] };
  }

  const parsedConfig = ts.parseJsonConfigFileContent(
    configFile.config,
    ts.sys,
    path.dirname(pkg.tsconfig),
  );

  // Override compiler options per target
  const outDir = target.config.outDir
    ? path.resolve(pkg.path, target.config.outDir)
    : parsedConfig.options.outDir;

  const moduleKind = resolveModuleKind(target.config.module);

  const overrides: ts.CompilerOptions = {
    outDir,
    ...(moduleKind !== undefined && { module: moduleKind }),
    declaration: target.config.declarations ?? parsedConfig.options.declaration ?? false,
    declarationMap: target.config.declarationMap ?? parsedConfig.options.declarationMap ?? false,
    sourceMap: target.config.sourceMap ?? parsedConfig.options.sourceMap ?? false,
    noEmit: false,
    composite: false,
  };

  // When overriding module, ensure moduleResolution is compatible.
  // "bundler" resolution only works with module=preserve or es2015+.
  // If we're forcing commonjs, switch to node resolution.
  if (moduleKind !== undefined && parsedConfig.options.moduleResolution !== undefined) {
    const isBundlerResolution =
      parsedConfig.options.moduleResolution === ts.ModuleResolutionKind.Bundler;
    const isCommonJS = moduleKind === ts.ModuleKind.CommonJS;

    if (isBundlerResolution && isCommonJS) {
      overrides.moduleResolution = ts.ModuleResolutionKind.Node10;
      logger.verbose(
        `Switched moduleResolution from bundler to node (incompatible with commonjs)`,
        context,
      );
    }
  }

  // Ensure workspace packages are resolvable during compilation.
  // For npm/relative builds, skip path injection — let tsc resolve via node_modules
  // symlinks so it emits bare specifiers (e.g. require("@sharpee/core")) that the
  // import transformer can then rewrite. Path injection causes tsc to emit broken
  // relative paths into the staging directory.
  const isRelativeBuild = target.config.imports === 'relative';
  const currentPaths: ts.MapLike<string[]> = { ...(parsedConfig.options.paths || {}) };

  // Inject workspace package paths for local builds only
  if (workspacePackages && !isRelativeBuild) {
    let needsBaseUrl = false;

    // Include transitive deps: tsc follows source paths and needs to resolve
    // imports in dependency source files too (e.g. plugins -> world-model -> if-domain)
    const transitiveDeps = getTransitiveDeps(pkg.name, workspacePackages);

    for (const [depName, depPkg] of workspacePackages) {
      if (depName === pkg.name) continue; // Skip self
      if (!transitiveDeps.has(depName)) continue; // Only add reachable deps

      // Add paths entry pointing at source if not already present
      if (!currentPaths[depName]) {
        const relEntry = path.relative(pkg.path, path.join(depPkg.path, depPkg.entryPoint));
        currentPaths[depName] = [relEntry];
        currentPaths[depName + '/*'] = [
          path.relative(pkg.path, path.join(depPkg.path, path.dirname(depPkg.entryPoint), '*')),
        ];
        needsBaseUrl = true;
        logger.verbose(`Added workspace path: ${depName} → ${relEntry}`, context);
      }
    }

    overrides.paths = currentPaths;
    if (needsBaseUrl && !parsedConfig.options.baseUrl) {
      overrides.baseUrl = pkg.path;
    }
  }

  // Widen rootDir if any path entry resolves outside the package's rootDir.
  // This handles user-provided paths in tsconfig (for both local and npm builds).
  // Even for npm builds, if tsconfig has paths that resolve outside rootDir, tsc fails.
  if (Object.keys(currentPaths).length > 0) {
    const effectiveRootDir = parsedConfig.options.rootDir
      ? path.resolve(path.dirname(pkg.tsconfig), parsedConfig.options.rootDir)
      : path.dirname(pkg.tsconfig);
    const baseUrl = parsedConfig.options.baseUrl
      ? path.resolve(path.dirname(pkg.tsconfig), parsedConfig.options.baseUrl)
      : pkg.path;

    let needsWiderRoot = false;
    for (const entries of Object.values(currentPaths)) {
      for (const entry of entries) {
        if (entry.includes('*')) continue;
        const resolved = path.resolve(baseUrl, entry);
        if (!resolved.startsWith(effectiveRootDir + path.sep) && resolved !== effectiveRootDir) {
          needsWiderRoot = true;
          break;
        }
      }
      if (needsWiderRoot) break;
    }

    if (needsWiderRoot) {
      overrides.rootDir = rootDir; // workspace root
      if (!parsedConfig.options.baseUrl) {
        overrides.baseUrl = pkg.path;
      }
      logger.verbose(`Widened rootDir to workspace root for cross-package resolution`, context);
    }
  }

  const compilerOptions: ts.CompilerOptions = {
    ...parsedConfig.options,
    ...overrides,
  };

  logger.verbose(`Compiling with module=${ts.ModuleKind[compilerOptions.module!]}, outDir=${outDir}`, context);

  // Create program and emit
  const program = ts.createProgram({
    rootNames: parsedConfig.fileNames,
    options: compilerOptions,
  });

  const emitResult = program.emit();

  // When rootDir was widened, tsc outputs a nested directory structure mirroring
  // the full workspace tree. Flatten it: keep only this package's own output files
  // and move them to the outDir root. Remove duplicated dependency sources.
  if (overrides.rootDir === rootDir && outDir) {
    flattenWidenedOutput(outDir, rootDir, pkg, context);
  }

  // Collect diagnostics
  const allDiagnostics = ts.getPreEmitDiagnostics(program).concat(emitResult.diagnostics);
  const diagnosticMessages: string[] = [];

  for (const diagnostic of allDiagnostics) {
    if (diagnostic.file && diagnostic.start !== undefined) {
      const { line, character } = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
      const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n');
      const fileName = path.relative(rootDir, diagnostic.file.fileName);
      diagnosticMessages.push(`${fileName}(${line + 1},${character + 1}): error ${diagnostic.code ? 'TS' + diagnostic.code : ''}: ${message}`);
    } else {
      const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n');
      diagnosticMessages.push(message);
    }
  }

  // Collect output file paths
  const outputFiles: string[] = [];
  if (outDir) {
    collectOutputFiles(outDir, outputFiles);
  }

  const success = !emitResult.emitSkipped && diagnosticMessages.length === 0;
  return { success, diagnostics: diagnosticMessages, outputFiles };
}

function resolveModuleKind(module?: string): ts.ModuleKind | undefined {
  if (!module) return undefined;
  const map: Record<string, ts.ModuleKind> = {
    commonjs: ts.ModuleKind.CommonJS,
    esnext: ts.ModuleKind.ESNext,
    es2015: ts.ModuleKind.ES2015,
    es2020: ts.ModuleKind.ES2020,
    es2022: ts.ModuleKind.ES2022,
    node16: ts.ModuleKind.Node16,
    nodenext: ts.ModuleKind.NodeNext,
  };
  return map[module.toLowerCase()];
}

function collectOutputFiles(dir: string, files: string[]): void {
  if (!ts.sys.directoryExists(dir)) return;
  for (const entry of ts.sys.readDirectory(dir, ['.js', '.d.ts', '.js.map', '.d.ts.map'])) {
    files.push(entry);
  }
}

/**
 * When rootDir is widened to workspace root, tsc outputs files in a nested
 * structure: outDir/packages/app/src/index.js instead of outDir/index.js.
 * This function moves the package's own files to outDir root and removes
 * the nested directories (including duplicated dependency source output).
 */
function flattenWidenedOutput(
  outDir: string,
  workspaceRoot: string,
  pkg: PackageInfo,
  context: string,
): void {
  // The package's source dir relative to workspace root determines the nesting
  // e.g. if workspace root is /repo and package src is /repo/packages/app/src,
  // then tsc outputs to outDir/packages/app/src/
  const pkgSrcDir = path.resolve(pkg.path, 'src'); // conventional source dir
  const relFromRoot = path.relative(workspaceRoot, pkgSrcDir);
  const nestedDir = path.join(outDir, relFromRoot);

  if (!fs.existsSync(nestedDir)) {
    // Try with just the package path (if rootDir was the package dir, not src)
    const relPkg = path.relative(workspaceRoot, pkg.path);
    const nestedPkgDir = path.join(outDir, relPkg);
    if (!fs.existsSync(nestedPkgDir)) return;
    // Package-level nesting without src subdir — nothing to flatten
    return;
  }

  // Move all files from nested location to outDir root
  copyDirRecursive(nestedDir, outDir);

  // Fix relative imports that reference the pre-flattened structure.
  // After flattening, paths like "../src/index.js" should become "../index.js"
  // because the "src/" nesting no longer exists in the output.
  fixFlattenedImports(outDir);

  // Remove the top-level nested directory (e.g., outDir/packages/)
  const topNested = path.join(outDir, relFromRoot.split(path.sep)[0]);
  if (fs.existsSync(topNested) && topNested !== outDir) {
    fs.rmSync(topNested, { recursive: true });
    logger.verbose(`Flattened output from ${relFromRoot}/ to outDir root`, context);
  }
}

/**
 * After flattening widened output, relative imports may still contain
 * a "src/" segment from the original nested structure. Rewrite them.
 * e.g. require("../src/index.js") → require("../index.js")
 *      require("./src/utils/foo.js") → require("./utils/foo.js")
 */
function fixFlattenedImports(outDir: string): void {
  const jsFiles: string[] = [];
  collectFilesRecursive(outDir, jsFiles, ['.js', '.d.ts', '.d.ts.map']);

  for (const file of jsFiles) {
    let content = fs.readFileSync(file, 'utf-8');
    let changed = false;

    // Match require("..."), from "...", and import("...") patterns containing /src/ segments
    const updated = content.replace(
      /(require\(["']|from\s+["']|import\(["'])(\.\.?\/(?:[^"']*\/)?)(src\/)/g,
      (match, prefix, relPath, _srcSegment) => {
        changed = true;
        return prefix + relPath;
      },
    );

    if (changed) {
      fs.writeFileSync(file, updated, 'utf-8');
    }
  }
}

function collectFilesRecursive(dir: string, files: string[], extensions: string[]): void {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectFilesRecursive(fullPath, files, extensions);
    } else if (extensions.some((ext) => entry.name.endsWith(ext))) {
      files.push(fullPath);
    }
  }
}

function getTransitiveDeps(
  pkgName: string,
  workspacePackages: Map<string, PackageInfo>,
): Set<string> {
  const result = new Set<string>();
  const queue = [...(workspacePackages.get(pkgName)?.dependencies ?? [])];
  while (queue.length > 0) {
    const dep = queue.pop()!;
    if (result.has(dep)) continue;
    result.add(dep);
    const depPkg = workspacePackages.get(dep);
    if (depPkg) {
      queue.push(...depPkg.dependencies);
    }
  }
  return result;
}

function copyDirRecursive(src: string, dest: string): void {
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      fs.mkdirSync(destPath, { recursive: true });
      copyDirRecursive(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}
