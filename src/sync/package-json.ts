/**
 * @fileoverview Package.json field generation and synchronization
 * @module tsf/sync/package-json
 *
 * Generates and updates package.json entry point fields based on build targets.
 * Handles the complexity of modern package.json exports:
 * - `main` for CommonJS entry
 * - `module` for ESM entry
 * - `types` for TypeScript declarations
 * - `exports` for conditional exports (Node.js dual-package pattern)
 * - `bin` for CLI executables
 *
 * Also generates clean manifests for npm publish:
 * - Strips `workspace:*` dependencies (pnpm protocol)
 * - Removes `devDependencies`
 * - Sets flat entry points for staging directory
 */

import * as fs from 'fs';
import * as path from 'path';
import type { ResolvedTarget, PackageInfo } from '../types';
import * as logger from '../utils/logger';

/**
 * Version range prefix used when resolving workspace:* to real versions.
 * Uses ^ for semver compatibility (e.g., "workspace:*" → "^0.9.87").
 */
const VERSION_RANGE_PREFIX = '^';

/**
 * Conditional export entry with Node.js-standard conditions.
 */
interface ExportsConditions {
  types?: string;
  import?: string;
  require?: string;
  default?: string;
}

/**
 * Fields generated/updated in package.json.
 */
interface GeneratedFields {
  main?: string;
  module?: string;
  types?: string;
  exports?: Record<string, ExportsConditions | string>;
  bin?: string | Record<string, string>;
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Syncs package.json with generated entry point fields.
 * Only updates fields that differ from current values.
 *
 * @param pkg - Package to sync
 * @param targets - Build targets to derive entry points from
 *
 * @example
 * ```typescript
 * syncPackageJson(pkg, targets);
 * // package.json now has main, module, types, exports set correctly
 * ```
 */
export function syncPackageJson(
  pkg: PackageInfo,
  targets: ResolvedTarget[],
): void {
  const pkgJsonPath = path.join(pkg.path, 'package.json');
  if (!fs.existsSync(pkgJsonPath)) {
    logger.warn(`No package.json found`, pkg.name);
    return;
  }

  const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8'));
  const fields = generateFields(pkg, targets);

  // Merge generated fields into existing package.json
  let changed = false;
  for (const [key, value] of Object.entries(fields)) {
    if (JSON.stringify(pkgJson[key]) !== JSON.stringify(value)) {
      pkgJson[key] = value;
      changed = true;
    }
  }

  if (!changed) {
    logger.verbose('package.json already up to date', pkg.name);
    return;
  }

  fs.writeFileSync(pkgJsonPath, JSON.stringify(pkgJson, null, 2) + '\n', 'utf-8');
  logger.success('Synced package.json', pkg.name);
}

/**
 * Generates a clean package.json for npm publish.
 *
 * This is the key to the staging directory approach:
 * - Entry points are relative to staging root (flat structure)
 * - `workspace:*` dependencies are stripped (cause EUNSUPPORTEDPROTOCOL errors)
 * - `devDependencies` are removed (not needed at runtime)
 * - Build scripts and files config are removed
 *
 * The generated manifest goes into `~/.tsf-publish/<pkg>/package.json`,
 * which becomes the root of the published tarball.
 *
 * @param pkg - Package to generate manifest for
 * @param packages - All workspace packages (for resolving workspace:* versions)
 * @returns Clean package.json object ready for npm publish
 *
 * @example
 * ```typescript
 * const manifest = generatePublishManifest(pkg, allPackages);
 * fs.writeFileSync(stagingDir + '/package.json', JSON.stringify(manifest, null, 2));
 * ```
 */
export function generatePublishManifest(pkg: PackageInfo, packages?: Map<string, PackageInfo>): Record<string, unknown> {
  const pkgJsonPath = path.join(pkg.path, 'package.json');
  const source = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8'));

  const manifest: Record<string, unknown> = { ...source };
  const entryBase = path.basename(pkg.entryPoint).replace(/\.tsx?$/, '.js');
  const dtsBase = entryBase.replace(/\.js$/, '.d.ts');

  // Set entry points relative to staging root
  manifest.main = './' + entryBase;
  manifest.types = './' + dtsBase;
  manifest.exports = {
    '.': {
      types: './' + dtsBase,
      require: './' + entryBase,
      default: './' + entryBase,
    },
  };

  // Resolve workspace:* to real version numbers
  resolveWorkspaceDeps(manifest, packages);

  // Remove devDependencies entirely
  delete manifest.devDependencies;

  // Remove fields that don't belong in a publish manifest
  delete manifest.scripts;
  delete manifest.files;
  delete manifest.module;

  // Rewrite bin paths — source paths like ./dist-npm/cli/index.js become ./cli/index.js
  if (manifest.bin) {
    if (typeof manifest.bin === 'string') {
      manifest.bin = './' + path.basename(manifest.bin as string);
    } else if (typeof manifest.bin === 'object') {
      const bin = manifest.bin as Record<string, string>;
      for (const [name, binPath] of Object.entries(bin)) {
        // Strip the outDir prefix (e.g. dist-npm/) — staging root is flat
        const parts = binPath.replace(/^\.\//, '').split('/');
        // Remove the first segment if it looks like an outDir (dist, dist-npm, etc.)
        if (parts.length > 1 && parts[0].startsWith('dist')) {
          parts.shift();
        }
        bin[name] = './' + parts.join('/');
      }
    }
  }

  return manifest;
}

/**
 * Resolves all `workspace:*` protocol dependencies to real version numbers.
 *
 * pnpm uses `workspace:*` to reference other packages in the monorepo,
 * but npm doesn't understand this protocol. This function replaces them
 * with the actual versions from the workspace packages' package.json files.
 *
 * If no packages map is provided, falls back to reading versions from disk
 * by looking for package.json in sibling directories.
 *
 * @param pkgJson - Package.json object to modify (mutated in place)
 * @param packages - Workspace packages map for version lookup
 * @returns Number of dependencies resolved
 *
 * @example
 * ```typescript
 * const resolved = resolveWorkspaceDeps(manifest, allPackages);
 * console.log(`Resolved ${resolved} workspace dependencies`);
 * ```
 */
export function resolveWorkspaceDeps(
  pkgJson: Record<string, unknown>,
  packages?: Map<string, PackageInfo>,
): number {
  let count = 0;
  for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
    const deps = pkgJson[field] as Record<string, string> | undefined;
    if (!deps) continue;
    for (const [name, version] of Object.entries(deps)) {
      if (typeof version === 'string' && version.startsWith('workspace:')) {
        const resolvedVersion = resolveWorkspaceVersion(name, version, packages);
        if (resolvedVersion) {
          deps[name] = resolvedVersion;
          count++;
        } else {
          logger.warn(`Could not resolve workspace version for ${name} — removing`);
          delete deps[name];
        }
      }
    }
    // Clean up empty dependency objects
    if (Object.keys(deps).length === 0) {
      delete pkgJson[field];
    }
  }
  return count;
}

/**
 * Resolves a single workspace:* version specifier to a real version.
 *
 * Handles pnpm workspace protocol variants:
 * - `workspace:*` → `^<version>` (any version in workspace)
 * - `workspace:^` → `^<version>` (caret range)
 * - `workspace:~` → `~<version>` (tilde range)
 * - `workspace:<version>` → `<version>` (exact)
 */
function resolveWorkspaceVersion(
  depName: string,
  workspaceSpec: string,
  packages?: Map<string, PackageInfo>,
): string | null {
  // Look up the dependency's version from the packages map
  let depVersion: string | undefined;

  if (packages) {
    const depPkg = packages.get(depName);
    if (depPkg?.version) {
      depVersion = depPkg.version;
    } else if (depPkg) {
      // PackageInfo.version might not be set — read from package.json
      try {
        const depPkgJson = JSON.parse(fs.readFileSync(path.join(depPkg.path, 'package.json'), 'utf-8'));
        depVersion = depPkgJson.version;
      } catch {
        // fall through
      }
    }
  }

  if (!depVersion) return null;

  // Parse the workspace protocol suffix
  const suffix = workspaceSpec.slice('workspace:'.length);
  switch (suffix) {
    case '*':
    case '^':
      return VERSION_RANGE_PREFIX + depVersion;
    case '~':
      return '~' + depVersion;
    default:
      // workspace:1.2.3 → 1.2.3
      return suffix || VERSION_RANGE_PREFIX + depVersion;
  }
}

/**
 * Removes all `workspace:*` protocol dependencies from a package.json object.
 *
 * @deprecated Use resolveWorkspaceDeps instead, which converts to real versions.
 *
 * @param pkgJson - Package.json object to modify (mutated in place)
 * @returns Number of dependencies stripped
 */
export function stripWorkspaceDeps(pkgJson: Record<string, unknown>): number {
  let count = 0;
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    const deps = pkgJson[field] as Record<string, string> | undefined;
    if (!deps) continue;
    for (const [name, version] of Object.entries(deps)) {
      if (typeof version === 'string' && version.startsWith('workspace:')) {
        delete deps[name];
        count++;
      }
    }
    // Clean up empty dependency objects
    if (Object.keys(deps).length === 0) {
      delete pkgJson[field];
    }
  }
  return count;
}

/**
 * Generates entry point fields from build targets.
 *
 * Analyzes targets to find:
 * - CJS target → `main` field
 * - ESM target → `module` field
 * - Declaration target → `types` field
 * - Shebang target → `bin` field
 *
 * Also generates `exports` map for dual-package support.
 *
 * @param pkg - Package to generate fields for
 * @param targets - Build targets to analyze
 * @returns Generated fields to merge into package.json
 */
export function generateFields(
  pkg: PackageInfo,
  targets: ResolvedTarget[],
): GeneratedFields {
  const fields: GeneratedFields = {};
  const entryBase = path.basename(pkg.entryPoint).replace(/\.tsx?$/, '.js');

  let cjsTarget: ResolvedTarget | undefined;
  let esmTarget: ResolvedTarget | undefined;
  let declTarget: ResolvedTarget | undefined;
  let binTarget: ResolvedTarget | undefined;

  // Exclude publish-conditioned targets — their output goes to staging, not the package tree
  const sorted = targets.filter((t) => t.config.condition !== 'publish');

  for (const t of sorted) {
    const cfg = t.config;

    // Identify CJS target
    if (cfg.module === 'commonjs' || cfg.format === 'cjs') {
      if (!cjsTarget) cjsTarget = t;
    }

    // Identify ESM target
    if (cfg.module === 'esnext' || cfg.module === 'es2020' || cfg.module === 'es2022' ||
        cfg.module === 'nodenext' || cfg.module === 'node16' || cfg.format === 'esm') {
      if (!esmTarget) esmTarget = t;
    }

    // Identify target with declarations
    if (cfg.declarations) {
      if (!declTarget) declTarget = t;
    }

    // Identify CLI/bin target
    if (cfg.banner && cfg.banner.includes('#!/')) {
      if (!binTarget) binTarget = t;
    }
  }

  // main → CJS output
  if (cjsTarget?.config.outDir) {
    fields.main = './' + path.join(cjsTarget.config.outDir, entryBase);
  }

  // module → ESM output
  if (esmTarget?.config.outDir) {
    fields.module = './' + path.join(esmTarget.config.outDir, entryBase);
  }

  // types → declaration output
  if (declTarget?.config.outDir) {
    const dtsBase = entryBase.replace(/\.js$/, '.d.ts');
    fields.types = './' + path.join(declTarget.config.outDir, dtsBase);
  }

  // exports → conditional exports map
  if (cjsTarget || esmTarget) {
    const conditions: ExportsConditions = {};

    if (declTarget?.config.outDir) {
      const dtsBase = entryBase.replace(/\.js$/, '.d.ts');
      conditions.types = './' + path.join(declTarget.config.outDir, dtsBase);
    }
    if (esmTarget?.config.outDir) {
      conditions.import = './' + path.join(esmTarget.config.outDir, entryBase);
    }
    if (cjsTarget?.config.outDir) {
      conditions.require = './' + path.join(cjsTarget.config.outDir, entryBase);
    }

    // Also add targets with explicit conditions
    const exports: Record<string, ExportsConditions | string> = { '.': conditions };

    // Add custom Node.js export conditions (skip TSF-internal conditions like "publish")
    const tsfConditions = new Set(['publish']);
    for (const t of targets) {
      if (t.config.condition && t.config.outDir && !tsfConditions.has(t.config.condition)) {
        const condPath = './' + path.join(t.config.outDir, entryBase);
        (exports['.'] as ExportsConditions)[t.config.condition as keyof ExportsConditions] = condPath;
      }
    }

    fields.exports = exports;
  }

  // bin → shebang targets
  if (binTarget) {
    const outDir = binTarget.config.outDir || 'dist';
    const binPath = './' + path.join(outDir, entryBase);
    const pkgJsonPath = path.join(pkg.path, 'package.json');
    if (fs.existsSync(pkgJsonPath)) {
      const existing = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8'));
      if (existing.bin && typeof existing.bin === 'object') {
        // Preserve existing bin keys, update values
        const bin: Record<string, string> = {};
        for (const key of Object.keys(existing.bin)) {
          bin[key] = binPath;
        }
        fields.bin = bin;
      } else if (existing.name) {
        const binName = existing.name.replace(/^@[^/]+\//, '');
        fields.bin = { [binName]: binPath };
      }
    }
  }

  return fields;
}
