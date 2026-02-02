import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { globSync } from 'glob';
import type { PackageInfo, ResolvedTarget } from '../types';

export interface CacheEntry {
  key: string;
  outputFiles: string[];
  timestamp: number;
}

/**
 * Compute a cache key for a package+target build.
 * Hashes: source files, tsconfig, resolved target config, and dependency cache keys.
 */
export function computeCacheKey(
  pkg: PackageInfo,
  target: ResolvedTarget,
  rootDir: string,
  depCacheKeys: Map<string, string>,
): string {
  const hash = crypto.createHash('sha256');

  // Hash source files (sorted for determinism)
  const srcDir = path.dirname(path.resolve(pkg.path, pkg.entryPoint));
  const sourceFiles = globSync('**/*.{ts,tsx}', {
    cwd: srcDir,
    absolute: true,
    ignore: ['**/*.d.ts'],
  }).sort();

  for (const file of sourceFiles) {
    hash.update(`file:${path.relative(pkg.path, file)}\n`);
    hash.update(fs.readFileSync(file));
  }

  // Hash tsconfig
  const tsconfigPath = path.resolve(pkg.path, pkg.tsconfig);
  if (fs.existsSync(tsconfigPath)) {
    hash.update('tsconfig:\n');
    hash.update(fs.readFileSync(tsconfigPath));
  }

  // Hash target config
  hash.update('target:\n');
  hash.update(JSON.stringify(target));

  // Hash dependency cache keys (sorted by dep name)
  const sortedDeps = [...pkg.dependencies].sort();
  for (const dep of sortedDeps) {
    const depKey = depCacheKeys.get(dep);
    if (depKey) {
      hash.update(`dep:${dep}:${depKey}\n`);
    }
  }

  return hash.digest('hex');
}

function getCacheFilePath(cacheDir: string, pkg: PackageInfo, target: ResolvedTarget): string {
  // Use package name without scope for directory
  const safeName = pkg.name.replace(/^@/, '').replace(/\//g, '__');
  return path.join(cacheDir, target.name, safeName, 'cache.json');
}

export function loadCacheEntry(
  cacheDir: string,
  pkg: PackageInfo,
  target: ResolvedTarget,
): CacheEntry | null {
  const filePath = getCacheFilePath(cacheDir, pkg, target);
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as CacheEntry;
  } catch {
    return null;
  }
}

/**
 * Check if a package+target build is cached and still valid.
 * Returns the cache key if valid, null if rebuild needed.
 */
export function isCached(
  cacheDir: string,
  pkg: PackageInfo,
  target: ResolvedTarget,
  rootDir: string,
  depCacheKeys: Map<string, string>,
): string | null {
  const entry = loadCacheEntry(cacheDir, pkg, target);
  if (!entry) return null;

  const currentKey = computeCacheKey(pkg, target, rootDir, depCacheKeys);
  if (entry.key !== currentKey) return null;

  // Verify output files still exist
  for (const file of entry.outputFiles) {
    if (!fs.existsSync(file)) return null;
  }

  return currentKey;
}

/**
 * Record a successful build in the cache.
 */
export function recordBuild(
  cacheDir: string,
  pkg: PackageInfo,
  target: ResolvedTarget,
  key: string,
  outputFiles: string[],
): void {
  const filePath = getCacheFilePath(cacheDir, pkg, target);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  const entry: CacheEntry = {
    key,
    outputFiles,
    timestamp: Date.now(),
  };

  fs.writeFileSync(filePath, JSON.stringify(entry, null, 2) + '\n', 'utf-8');
}

/**
 * Remove the entire cache directory.
 */
export function cleanCache(cacheDir: string): void {
  if (fs.existsSync(cacheDir)) {
    fs.rmSync(cacheDir, { recursive: true });
  }
}
