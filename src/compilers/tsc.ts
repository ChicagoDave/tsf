import * as ts from 'typescript';
import * as fs from 'fs';
import * as path from 'path';
import type { PackageInfo, ResolvedTarget, CompileResult } from '../types';
import * as logger from '../utils/logger';

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
  // Keep existing paths pointing at source (for type resolution), and add
  // any missing workspace deps. The import transformer rewrites output post-compile.
  if (workspacePackages) {
    const currentPaths: ts.MapLike<string[]> = { ...(parsedConfig.options.paths || {}) };
    let needsBaseUrl = false;

    for (const [depName, depPkg] of workspacePackages) {
      if (depName === pkg.name) continue; // Skip self
      if (!pkg.dependencies.includes(depName)) continue; // Only add actual deps

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

    // Widen rootDir if any path entry resolves outside the package's rootDir.
    // This handles both user-provided paths (in tsconfig) and ts-forge-injected ones.
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

  // Remove the top-level nested directory (e.g., outDir/packages/)
  const topNested = path.join(outDir, relFromRoot.split(path.sep)[0]);
  if (fs.existsSync(topNested) && topNested !== outDir) {
    fs.rmSync(topNested, { recursive: true });
    logger.verbose(`Flattened output from ${relFromRoot}/ to outDir root`, context);
  }
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
