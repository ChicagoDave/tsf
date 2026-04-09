/**
 * @fileoverview Change detection for selective publishing
 * @module tsf/cli/changed
 *
 * Detects which packages have changed since their last npm publish.
 * Used by `tsf publish --changed` and `tsf version --changed` to
 * only affect packages that need updates.
 *
 * Detection methods:
 * 1. Not published: Package doesn't exist on npm
 * 2. Version differs: Local version differs from npm version
 * 3. Git changes: Files changed since version tag (v{name}@{version})
 *
 * @example
 * ```bash
 * tsf changed                    # List changed packages
 * tsf publish --changed          # Publish only changed packages
 * tsf version --changed --bump patch  # Bump only changed packages
 * ```
 */

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { loadBuildContextPublic, shouldSkipTarget } from '../orchestrator';
import type { PackageInfo } from '../types';
import * as logger from '../utils/logger';
import { parsePackageFlag, resolvePackageFilters } from '../utils/package-filter';

/**
 * Options for change detection.
 */
interface ChangedOptions {
  /** Only check packages with this target condition */
  condition?: string;
  /** Package names to check (empty = all) */
  filter: string[];
}

/**
 * Information about a changed package.
 */
export interface ChangedPackage {
  /** Package metadata */
  pkg: PackageInfo;
  /** Version in local package.json */
  localVersion: string;
  /** Version on npm registry (null if not published) */
  publishedVersion: string | null;
  /** Why the package is considered changed */
  reason: string;
}

/**
 * Detects which publishable packages have changed since their last npm publish.
 *
 * Comparison logic:
 * 1. Query npm registry for published version
 * 2. If not published → changed (reason: "not published")
 * 3. If versions differ → changed (reason: "version differs")
 * 4. If git has changes since tag → changed (reason: "git changes")
 *
 * @param options - Filter options
 * @returns Array of changed packages with reasons
 */
export function detectChanged(options: { condition?: string; filter: string[] }): ChangedPackage[] {
  const ctx = loadBuildContextPublic();
  if (!ctx) return [];

  // Resolve short package names (e.g., "stdlib" → "@sharpee/stdlib")
  if (options.filter.length > 0) {
    options.filter = resolvePackageFilters(options.filter, ctx.packages);
  }

  let packages = [...ctx.packages.values()];

  if (options.filter.length > 0) {
    packages = packages.filter((pkg) => options.filter.includes(pkg.name));
  }

  if (options.condition) {
    const conditionTargets = ctx.targets.filter((t) => t.config.condition === options.condition);
    packages = packages.filter((pkg) => conditionTargets.some((t) => !shouldSkipTarget(pkg, t)));
  }

  // Get git root for relative path calculations
  const gitRoot = execSync('git rev-parse --show-toplevel', { stdio: 'pipe' }).toString().trim();

  const changed: ChangedPackage[] = [];

  for (const pkg of packages) {
    const pkgJsonPath = path.join(pkg.path, 'package.json');
    const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8'));
    const localVersion: string = pkgJson.version || '0.0.0';

    // Get published version from npm registry
    const publishedVersion = getNpmVersion(pkg.name);

    if (!publishedVersion) {
      changed.push({ pkg, localVersion, publishedVersion, reason: 'not published' });
      continue;
    }

    if (localVersion !== publishedVersion) {
      changed.push({ pkg, localVersion, publishedVersion, reason: 'version differs' });
      continue;
    }

    // Same version — check git for file changes since that version's tag
    const tag = findVersionTag(pkg.name, publishedVersion);
    if (!tag) {
      // No tag found — check for uncommitted/staged changes in package dir
      const relPath = path.relative(gitRoot, pkg.path);
      if (hasGitChanges(relPath)) {
        changed.push({ pkg, localVersion, publishedVersion, reason: 'uncommitted changes' });
      }
      continue;
    }

    // Check for changes since the tag
    const relPath = path.relative(gitRoot, pkg.path);
    if (hasChangesSinceTag(tag, relPath)) {
      changed.push({ pkg, localVersion, publishedVersion, reason: `changed since ${tag}` });
    }
  }

  return changed;
}

export function handleChanged(args: string[]): void {
  const options = parseChangedOptions(args);
  const changed = detectChanged(options);

  if (changed.length === 0) {
    logger.info('No packages have changed since last publish');
    return;
  }

  for (const c of changed) {
    const published = c.publishedVersion ?? 'unpublished';
    console.log(`${c.pkg.name}  ${published} → ${c.localVersion}  (${c.reason})`);
  }
}

function getNpmVersion(name: string): string | null {
  try {
    return execSync(`npm view ${name} version 2>/dev/null`, { stdio: 'pipe' }).toString().trim() || null;
  } catch {
    return null;
  }
}

function findVersionTag(name: string, version: string): string | null {
  // Try common tag formats: v0.9.63, @scope/pkg@0.9.63, 0.9.63
  const safeName = name.replace(/^@/, '').replace(/\//g, '-');
  const candidates = [
    `${name}@${version}`,
    `${safeName}@${version}`,
    `v${version}`,
    version,
  ];

  for (const tag of candidates) {
    try {
      execSync(`git rev-parse --verify refs/tags/${tag}`, { stdio: 'pipe' });
      return tag;
    } catch {
      continue;
    }
  }
  return null;
}

function hasGitChanges(relPath: string): boolean {
  try {
    const output = execSync(`git status --porcelain -- "${relPath}"`, { stdio: 'pipe' }).toString().trim();
    return output.length > 0;
  } catch {
    return false;
  }
}

function hasChangesSinceTag(tag: string, relPath: string): boolean {
  try {
    const output = execSync(`git diff --name-only "${tag}"..HEAD -- "${relPath}"`, { stdio: 'pipe' }).toString().trim();
    return output.length > 0;
  } catch {
    return false;
  }
}

function parseChangedOptions(args: string[]): ChangedOptions {
  const options: ChangedOptions = {
    filter: [],
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case '--condition':
        options.condition = args[++i];
        break;
      case '--filter':
        options.filter.push(args[++i]);
        break;
      case '--package':
      case '--packageList': {
        const newI = parsePackageFlag(arg, args, i, options.filter);
        if (newI >= 0) i = newI;
        break;
      }
      default:
        if (arg.startsWith('-')) {
          logger.warn(`Unknown option: ${arg}`);
        }
    }
  }

  return options;
}
