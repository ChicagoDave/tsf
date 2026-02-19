/**
 * @fileoverview Package discovery and metadata resolution
 * @module tsf/resolver/packages
 *
 * Resolves workspace packages from glob patterns and builds metadata
 * needed for compilation. For each package, determines:
 * - Name and version from package.json
 * - Path to tsconfig.json
 * - Entry point (src/index.ts or inferred from package.json)
 * - Workspace dependencies (other packages in the monorepo)
 *
 * The resolved packages are used by the graph module to compute build order.
 */

import * as fs from 'fs';
import * as path from 'path';
import { globSync } from 'glob';
import type { PackageInfo, TsForgeConfig } from '../types';
import * as logger from '../utils/logger';

/**
 * Resolves all packages matching the config's project globs.
 * Builds a map of package name → metadata including dependencies.
 *
 * Resolution process:
 * 1. Expand project globs to find tsconfig.json files
 * 2. For each tsconfig, load sibling package.json
 * 3. Extract name, version, entry point, and dependencies
 * 4. Filter dependencies to only include workspace packages
 *
 * @param config - TSF configuration with project globs
 * @param rootDir - Workspace root directory
 * @param workspacePackageNames - Optional set of known workspace package names
 *                                (for filtering dependencies; if not provided,
 *                                a second pass resolves them)
 * @returns Map of package name → PackageInfo
 *
 * @example
 * ```typescript
 * const packages = resolvePackages(config, '/workspace');
 * for (const [name, info] of packages) {
 *   console.log(`${name}: ${info.dependencies.length} workspace deps`);
 * }
 * ```
 */
export function resolvePackages(
  config: TsForgeConfig,
  rootDir: string,
  workspacePackageNames?: Set<string>,
): Map<string, PackageInfo> {
  const packages = new Map<string, PackageInfo>();

  // Resolve project globs to tsconfig paths
  const tsconfigPaths: string[] = [];
  for (const pattern of config.projects) {
    const matches = globSync(pattern, { cwd: rootDir, absolute: true });
    tsconfigPaths.push(...matches);
  }

  if (tsconfigPaths.length === 0) {
    logger.warn(`No tsconfig files matched by projects: ${config.projects.join(', ')}`);
    return packages;
  }

  // First pass: collect package metadata
  for (const tsconfigPath of tsconfigPaths) {
    const pkgDir = path.dirname(tsconfigPath);
    const pkgJsonPath = path.join(pkgDir, 'package.json');

    if (!fs.existsSync(pkgJsonPath)) {
      logger.verbose(`Skipping ${tsconfigPath}: no package.json found`);
      continue;
    }

    const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8'));
    const name: string = pkgJson.name;
    if (!name) {
      logger.warn(`Skipping ${pkgDir}: package.json has no "name" field`);
      continue;
    }

    // Find entry point from package.json hints or conventions
    const entryPoint = resolveEntryPoint(pkgDir, pkgJson);

    // Collect all dependency types
    const allDeps = {
      ...pkgJson.dependencies,
      ...pkgJson.devDependencies,
      ...pkgJson.peerDependencies,
    };

    // Filter to workspace packages if we know them
    const deps = workspacePackageNames
      ? Object.keys(allDeps).filter((d) => workspacePackageNames.has(d))
      : [];

    packages.set(name, {
      name,
      path: pkgDir,
      tsconfig: tsconfigPath,
      dependencies: deps,
      entryPoint,
      version: pkgJson.version,
    });
  }

  // Second pass: resolve workspace dependencies if not provided upfront
  // (Now that we know all package names in this workspace)
  if (!workspacePackageNames) {
    const knownNames = new Set(packages.keys());
    for (const pkg of packages.values()) {
      const pkgJsonPath = path.join(pkg.path, 'package.json');
      const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8'));
      const allDeps = { ...pkgJson.dependencies, ...pkgJson.devDependencies, ...pkgJson.peerDependencies };
      pkg.dependencies = Object.keys(allDeps).filter((d) => knownNames.has(d));
    }
  }

  return packages;
}

/**
 * Determines the TypeScript entry point for a package.
 * Checks common conventions and package.json hints.
 *
 * Search order:
 * 1. Infer from package.json "main" field (dist/index.js → src/index.ts)
 * 2. src/index.ts
 * 3. src/index.tsx
 * 4. src/main.ts
 * 5. index.ts
 *
 * @param pkgDir - Package directory
 * @param pkgJson - Parsed package.json
 * @returns Entry point path relative to package root
 */
function resolveEntryPoint(pkgDir: string, pkgJson: Record<string, unknown>): string {
  const candidates = [
    'src/index.ts',
    'src/index.tsx',
    'src/main.ts',
    'index.ts',
  ];

  // Infer source entry from "main" field
  if (typeof pkgJson.main === 'string') {
    const mainSrc = pkgJson.main
      .replace(/^\.\//, '')
      .replace(/^dist\//, 'src/')
      .replace(/\.js$/, '.ts');
    candidates.unshift(mainSrc);
  }

  for (const candidate of candidates) {
    if (fs.existsSync(path.join(pkgDir, candidate))) {
      return candidate;
    }
  }

  return 'src/index.ts'; // Default assumption
}
