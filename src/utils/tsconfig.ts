/**
 * @fileoverview Effective-tsconfig helpers that pin TypeScript defaults TSF depends on
 * @module tsf/utils/tsconfig
 *
 * TypeScript 6.0 changed the default `rootDir` from the longest common directory
 * of the input files to the directory containing tsconfig.json. TSF's output
 * model (entry-point stripping, package.json sync, declaration placement) assumes
 * the former, so every reader of a user tsconfig resolves `rootDir` through
 * `resolveRootDir()` rather than through TypeScript's version-dependent default.
 *
 * Public interface: `resolveRootDir(tsconfigPath)`.
 * Owner context: build tooling / compiler orchestration (shared by compilers and transforms).
 */

import * as path from 'path';
import * as ts from 'typescript';

/**
 * Resolves the effective `rootDir` for a tsconfig as an absolute path.
 *
 * Returns the user's `rootDir` when declared. Otherwise returns the longest
 * common directory of the config's non-declaration input files, which is what
 * TypeScript 5.x inferred and what TSF's output layout assumes; this keeps the
 * emitted layout identical on 5.x and 6.0. With no input files the tsconfig
 * directory is returned.
 *
 * @param tsconfigPath - Absolute path to the package's tsconfig.json
 * @returns Absolute effective rootDir
 */
export function resolveRootDir(tsconfigPath: string): string {
  const configDir = path.dirname(tsconfigPath);
  const configFile = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
  if (configFile.error || !configFile.config) return configDir;

  const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, configDir);
  if (parsed.options.rootDir) return path.resolve(configDir, parsed.options.rootDir);

  const sourceDirs = parsed.fileNames
    .filter((f) => !/\.d\.[cm]?ts$/.test(f))
    .map((f) => path.dirname(path.resolve(f)));
  if (sourceDirs.length === 0) return configDir;

  return commonDirectory(sourceDirs);
}

/** Longest common ancestor directory of absolute directory paths. */
function commonDirectory(dirs: string[]): string {
  let common = dirs[0].split(path.sep);
  for (const dir of dirs.slice(1)) {
    const parts = dir.split(path.sep);
    let i = 0;
    while (i < common.length && i < parts.length && common[i] === parts[i]) i++;
    common = common.slice(0, i);
  }
  return common.join(path.sep) || path.sep;
}
