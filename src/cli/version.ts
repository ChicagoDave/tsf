/**
 * @fileoverview Package version management
 * @module tsf/cli/version
 *
 * Updates version numbers in package.json files across the workspace.
 * Supports both explicit versions and semantic version bumping.
 *
 * Features:
 * - Explicit version: `tsf version 1.2.3`
 * - Bump: `tsf version --bump patch`
 * - Prerelease: `tsf version --bump prerelease --preid beta`
 * - Filter to specific packages
 * - Changed detection integration
 * - Dry-run mode for preview
 *
 * @example
 * ```bash
 * tsf version 1.0.0              # Set all packages to 1.0.0
 * tsf version --bump minor       # Bump minor version
 * tsf version --bump prerelease --preid alpha  # 1.0.0 → 1.0.1-alpha.0
 * tsf version --changed --bump patch  # Only bump changed packages
 * ```
 */

import { loadBuildContextPublic, shouldSkipTarget } from '../orchestrator';
import { detectChanged } from './changed';
import * as logger from '../utils/logger';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Options for the version command.
 */
interface VersionOptions {
  /** Explicit version to set */
  version?: string;
  /** Semantic version bump type */
  bump?: 'major' | 'minor' | 'patch' | 'prerelease';
  /** Prerelease identifier (e.g., "alpha", "beta") */
  preid: string;
  /** Package names to version (empty = all) */
  filter: string[];
  /** Only version packages with this target condition */
  condition?: string;
  /** Only version packages that have changed */
  changed: boolean;
  /** Preview without modifying files */
  dryRun: boolean;
}

/**
 * Handles the `tsf version` command.
 * Updates version numbers in package.json files.
 */
export function handleVersion(args: string[]): void {
  const options = parseVersionOptions(args);

  if (!options.version && !options.bump) {
    logger.error('Provide an explicit version or --bump <major|minor|patch|prerelease>');
    process.exit(1);
  }

  if (options.version && options.bump) {
    logger.error('Cannot use both an explicit version and --bump');
    process.exit(1);
  }

  const ctx = loadBuildContextPublic();
  if (!ctx) return;

  let packages = [...ctx.packages.values()];

  if (options.filter.length > 0) {
    packages = packages.filter((pkg) => options.filter.includes(pkg.name));
  }

  if (options.condition) {
    const conditionTargets = ctx.targets.filter((t) => t.config.condition === options.condition);
    packages = packages.filter((pkg) => conditionTargets.some((t) => !shouldSkipTarget(pkg, t)));
  }

  if (options.changed) {
    const changedPkgs = detectChanged({ condition: options.condition, filter: options.filter });
    const changedNames = new Set(changedPkgs.map((c) => c.pkg.name));
    packages = packages.filter((pkg) => changedNames.has(pkg.name));
  }

  if (packages.length === 0) {
    logger.error('No packages matched the filter');
    process.exit(1);
  }

  const changes: { name: string; from: string; to: string }[] = [];

  for (const pkg of packages) {
    const pkgJsonPath = path.join(pkg.path, 'package.json');
    const raw = fs.readFileSync(pkgJsonPath, 'utf-8');
    const pkgJson = JSON.parse(raw);
    const oldVersion: string = pkgJson.version || '0.0.0';

    const newVersion = options.version ?? bumpVersion(oldVersion, options.bump!, options.preid);

    changes.push({ name: pkg.name, from: oldVersion, to: newVersion });

    if (!options.dryRun) {
      pkgJson.version = newVersion;
      fs.writeFileSync(pkgJsonPath, JSON.stringify(pkgJson, null, 2) + '\n');
    }
  }

  const label = options.dryRun ? '(dry run)' : '';
  for (const c of changes) {
    logger.info(`${c.name}  ${c.from} → ${c.to} ${label}`);
  }
}

export function bumpVersion(current: string, level: 'major' | 'minor' | 'patch' | 'prerelease', preid: string): string {
  const match = current.match(/^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/);
  if (!match) {
    throw new Error(`Cannot parse version: ${current}`);
  }

  let [, majorS, minorS, patchS, pre] = match;
  let major = parseInt(majorS, 10);
  let minor = parseInt(minorS, 10);
  let patch = parseInt(patchS, 10);

  switch (level) {
    case 'major':
      major++;
      minor = 0;
      patch = 0;
      return `${major}.${minor}.${patch}`;
    case 'minor':
      minor++;
      patch = 0;
      return `${major}.${minor}.${patch}`;
    case 'patch':
      if (pre) {
        // 1.0.1-beta → 1.0.1 (strip prerelease)
        return `${major}.${minor}.${patch}`;
      }
      patch++;
      return `${major}.${minor}.${patch}`;
    case 'prerelease': {
      if (pre) {
        // Try to increment numeric suffix: beta.1 → beta.2
        const preMatch = pre.match(/^(.+?)\.(\d+)$/);
        if (preMatch && preMatch[1] === preid) {
          return `${major}.${minor}.${patch}-${preid}.${parseInt(preMatch[2], 10) + 1}`;
        }
        // Different preid or no numeric suffix — start at .0
        return `${major}.${minor}.${patch}-${preid}.0`;
      }
      // No prerelease — bump patch and add preid
      patch++;
      return `${major}.${minor}.${patch}-${preid}.0`;
    }
  }
}

function parseVersionOptions(args: string[]): VersionOptions {
  const options: VersionOptions = {
    preid: 'beta',
    filter: [],
    changed: false,
    dryRun: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case '--bump':
        options.bump = args[++i] as VersionOptions['bump'];
        break;
      case '--preid':
        options.preid = args[++i];
        break;
      case '--filter':
        options.filter.push(args[++i]);
        break;
      case '--condition':
        options.condition = args[++i];
        break;
      case '--changed':
        options.changed = true;
        break;
      case '--dry-run':
        options.dryRun = true;
        break;
      default:
        if (!arg.startsWith('-')) {
          options.version = arg;
        } else {
          logger.warn(`Unknown option: ${arg}`);
        }
    }
  }

  return options;
}
