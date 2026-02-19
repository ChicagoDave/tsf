/**
 * @fileoverview Incremental build cache with content-hash invalidation
 * @module tsf/cache
 *
 * Implements a content-addressed cache to skip redundant builds.
 * Cache keys are SHA-256 hashes computed from:
 * - Source file contents
 * - Package version
 * - tsconfig.json
 * - Target configuration
 * - Dependency cache keys (transitive invalidation)
 *
 * This ensures builds are skipped only when truly unchanged, and any
 * modification to dependencies triggers downstream rebuilds.
 *
 * Cache entries are stored in `.tsf-cache/<target>/<package>/cache.json`.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { globSync } from 'glob';
import type { PackageInfo, ResolvedTarget } from '../types';

/**
 * Cache entry stored on disk.
 */
export interface CacheEntry {
  /** SHA-256 hash of all inputs */
  key: string;
  /** Paths to generated output files */
  outputFiles: string[];
  /** Unix timestamp of build completion */
  timestamp: number;
}

/**
 * Computes a cache key for a package+target build.
 *
 * The key is a SHA-256 hash of:
 * - All source .ts/.tsx files (contents, not just paths)
 * - Package version from package.json
 * - tsconfig.json contents
 * - Serialized target configuration
 * - Cache keys of all workspace dependencies
 *
 * If any input changes, the hash changes, triggering a rebuild.
 *
 * @param pkg - Package to compute key for
 * @param target - Build target
 * @param rootDir - Workspace root
 * @param depCacheKeys - Map of dependency name → cache key
 * @returns Hex-encoded SHA-256 hash
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

  // Hash package.json version
  const pkgJsonPath = path.join(pkg.path, 'package.json');
  if (fs.existsSync(pkgJsonPath)) {
    try {
      const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8'));
      hash.update(`version:${pkgJson.version || ''}\n`);
    } catch { /* ignore */ }
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

/**
 * Computes the cache file path for a package+target combination.
 * Uses a safe filename derived from the package name.
 *
 * @param cacheDir - Root cache directory
 * @param pkg - Package
 * @param target - Build target
 * @returns Path to cache.json file
 */
function getCacheFilePath(cacheDir: string, pkg: PackageInfo, target: ResolvedTarget): string {
  // Sanitize package name for filesystem: @scope/pkg → scope__pkg
  const safeName = pkg.name.replace(/^@/, '').replace(/\//g, '__');
  return path.join(cacheDir, target.name, safeName, 'cache.json');
}

/**
 * Loads a cache entry from disk.
 *
 * @param cacheDir - Root cache directory
 * @param pkg - Package to look up
 * @param target - Build target
 * @returns Cache entry if exists and valid JSON, null otherwise
 */
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
 * Checks if a package+target build is cached and still valid.
 *
 * Validation checks:
 * 1. Cache entry exists on disk
 * 2. Stored key matches computed key (no input changes)
 * 3. All output files still exist (handles manual deletion)
 *
 * @param cacheDir - Root cache directory
 * @param pkg - Package to check
 * @param target - Build target
 * @param rootDir - Workspace root
 * @param depCacheKeys - Dependency cache keys for hash computation
 * @returns Cache key if valid (can skip build), null if rebuild needed
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

  // Verify output files still exist (handles manual deletion)
  for (const file of entry.outputFiles) {
    if (!fs.existsSync(file)) return null;
  }

  return currentKey;
}

/**
 * Records a successful build in the cache.
 * Creates parent directories if needed.
 *
 * @param cacheDir - Root cache directory
 * @param pkg - Package that was built
 * @param target - Build target
 * @param key - Computed cache key
 * @param outputFiles - Paths to all generated files
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
 * Removes the entire cache directory.
 * Use with `--clean` flag to force full rebuild.
 *
 * @param cacheDir - Cache directory to remove
 */
export function cleanCache(cacheDir: string): void {
  if (fs.existsSync(cacheDir)) {
    fs.rmSync(cacheDir, { recursive: true });
  }
}
