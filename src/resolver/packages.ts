import * as fs from 'fs';
import * as path from 'path';
import { globSync } from 'glob';
import type { PackageInfo, TsForgeConfig } from '../types';
import * as logger from '../utils/logger';

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

    // Find entry point from tsconfig or package.json
    const entryPoint = resolveEntryPoint(pkgDir, pkgJson);

    // Identify workspace dependencies
    const allDeps = {
      ...pkgJson.dependencies,
      ...pkgJson.devDependencies,
    };
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

  // Second pass: now that we know all package names, resolve dependencies
  // against the actual set if we didn't have workspace names upfront
  if (!workspacePackageNames) {
    const knownNames = new Set(packages.keys());
    for (const pkg of packages.values()) {
      const pkgJsonPath = path.join(pkg.path, 'package.json');
      const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8'));
      const allDeps = { ...pkgJson.dependencies, ...pkgJson.devDependencies };
      pkg.dependencies = Object.keys(allDeps).filter((d) => knownNames.has(d));
    }
  }

  return packages;
}

function resolveEntryPoint(pkgDir: string, pkgJson: Record<string, unknown>): string {
  // Try common entry points
  const candidates = [
    'src/index.ts',
    'src/index.tsx',
    'src/main.ts',
    'index.ts',
  ];

  // Check package.json "main" for hints
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
