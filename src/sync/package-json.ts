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
export function generatePublishManifest(
  pkg: PackageInfo,
  workspacePackages?: Map<string, PackageInfo>,
): Record<string, unknown> {
  const pkgJsonPath = path.join(pkg.path, 'package.json');
  const source = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8'));

  const manifest: Record<string, unknown> = { ...source };
  const entryBase = path.basename(pkg.entryPoint).replace(/\.tsx?$/, '.js');
  const dtsBase = entryBase.replace(/\.js$/, '.d.ts');

  // Set entry points relative to staging root
  manifest.main = './' + entryBase;
  manifest.types = './' + dtsBase;
  manifest.exports = rewritePublishExports(source, entryBase, dtsBase, pkg.name);

  // Convert workspace:* deps to real version ranges for publish
  resolveWorkspaceDeps(manifest, workspacePackages);

  // Remove devDependencies entirely
  delete manifest.devDependencies;

  // Remove fields that don't belong in a publish manifest
  delete manifest.scripts;
  delete manifest.files;
  delete manifest.module;
  // tsf publishes CommonJS, so a source "type":"module" would mislabel the emitted CJS
  // (ESM consumers would read `exports`/`require` as undefined). Drop it so .js defaults to CJS.
  delete manifest.type;

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

// ============================================================================
// Publish manifest internals
// ============================================================================

/**
 * Generates the publish manifest and writes it into a package's staging directory.
 *
 * This is the single production path from source package.json to the
 * `package.json` at the root of the published tarball — the orchestrator's npm
 * build calls it, and so does anything that needs to observe what actually gets
 * published rather than what a manifest object looks like in memory.
 *
 * @param pkg - Package to stage
 * @param workspacePackages - All workspace packages, for resolving workspace:* versions
 * @param stagingDir - The package's staging directory (must already exist)
 * @returns The manifest that was written
 * @throws If the staging directory does not exist or is not writable
 */
export function writePublishManifest(
  pkg: PackageInfo,
  workspacePackages: Map<string, PackageInfo> | undefined,
  stagingDir: string,
): Record<string, unknown> {
  const manifest = generatePublishManifest(pkg, workspacePackages);
  fs.writeFileSync(
    path.join(stagingDir, 'package.json'),
    JSON.stringify(manifest, null, 2) + '\n',
    'utf-8',
  );
  return manifest;
}

/**
 * Rewrites one exports target path for the flat staging root.
 *
 * Staging is flat: the publish target's outDir becomes the tarball root, so a
 * source target like `./dist/channels/index.js` is published as
 * `./channels/index.js`. A `*` is left untouched — npm expands subpath patterns
 * at resolve time, so only the static prefix is ours to rewrite.
 *
 * @param target - Source exports target (may contain one `*`)
 * @param cjsOutDir - The outDir that is actually staged, derived from source `main`
 * @returns The staged path, or null when the target lives in an outDir that is
 *          not staged (e.g. a `dist-esm` ESM build) and therefore has no file
 *          in the tarball to point at
 */
function rewriteExportTarget(target: string, cjsOutDir: string | undefined): string | null {
  const parts = target.replace(/^\.\//, '').split('/');
  if (parts.length > 1 && parts[0].startsWith('dist')) {
    // Only the staged outDir survives the flattening. Anything else — a parallel
    // ESM build, a docs dir — was never copied, so a rewritten path would name a
    // file that is not in the tarball. Signal "drop" rather than lie.
    if (cjsOutDir && parts[0] !== cjsOutDir) return null;
    parts.shift();
  }
  return './' + parts.join('/');
}

/**
 * Which outDir does the staging directory actually contain?
 *
 * Derived from the source `main` field, which by construction points at the CJS
 * build that tsf publishes. Returns undefined when `main` is absent or is not
 * under a `dist*` directory — callers then strip any `dist*` prefix and drop
 * nothing, since there is no evidence distinguishing staged from unstaged.
 *
 * @param source - The source package.json object
 * @returns The staged outDir segment (e.g. "dist", "dist-npm"), or undefined
 */
function stagedOutDir(source: Record<string, unknown>): string | undefined {
  const main = typeof source.main === 'string' ? source.main : undefined;
  if (!main) return undefined;
  const parts = main.replace(/^\.\//, '').split('/');
  return parts.length > 1 && parts[0].startsWith('dist') ? parts[0] : undefined;
}

/**
 * Builds the published `exports` map from the source package's own exports.
 *
 * Every source key is carried through with its target paths rewritten for the
 * flat staging root, so subpath entry points stay reachable after publish. The
 * `"."` key is synthesized from the package entry point rather than copied —
 * it is the one key whose staged filename tsf already knows exactly.
 *
 * @param source - The source package.json object
 * @param entryBase - Staged entry filename (e.g. "index.js")
 * @param dtsBase - Staged declaration filename (e.g. "index.d.ts")
 * @param pkgName - Package name, for warning context
 * @returns The exports map to publish
 */
function rewritePublishExports(
  source: Record<string, unknown>,
  entryBase: string,
  dtsBase: string,
  pkgName: string,
): Record<string, unknown> {
  const root: ExportsConditions = {
    types: './' + dtsBase,
    require: './' + entryBase,
    default: './' + entryBase,
  };

  const sourceExports = source.exports;
  if (!sourceExports || typeof sourceExports !== 'object' || Array.isArray(sourceExports)) {
    return { '.': root };
  }

  const cjsOutDir = stagedOutDir(source);
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(sourceExports as Record<string, unknown>)) {
    if (key === '.') {
      result['.'] = root;
      continue;
    }

    if (typeof value === 'string') {
      const rewritten = rewriteExportTarget(value, cjsOutDir);
      if (rewritten === null) {
        logger.warn(`Dropped exports["${key}"] — "${value}" is not in the published output`, pkgName);
        continue;
      }
      result[key] = rewritten;
      continue;
    }

    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const conditions: Record<string, string> = {};
      for (const [cond, condPath] of Object.entries(value as Record<string, unknown>)) {
        if (typeof condPath !== 'string') continue;
        const rewritten = rewriteExportTarget(condPath, cjsOutDir);
        if (rewritten === null) continue;
        conditions[cond] = rewritten;
      }
      if (Object.keys(conditions).length === 0) {
        logger.warn(`Dropped exports["${key}"] — no condition resolves to published output`, pkgName);
        continue;
      }
      result[key] = conditions;
    }
  }

  // A source exports map without "." still publishes a root entry: main/types
  // name it, and omitting it would make the package itself unimportable.
  if (!result['.']) {
    return { '.': root, ...result };
  }
  return result;
}

/**
 * Convert workspace:* and file: dependencies to real version ranges for publishing.
 * workspace:* → ^<version>, workspace:^ → ^<version>, workspace:~ → ~<version>.
 * file:../path → ^<version> using the dep's actual version from the workspace.
 * Falls back to removing the dep if the version can't be resolved.
 */
function resolveWorkspaceDeps(
  pkgJson: Record<string, unknown>,
  workspacePackages?: Map<string, PackageInfo>,
): void {
  for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
    const deps = pkgJson[field] as Record<string, string> | undefined;
    if (!deps) continue;
    for (const [name, version] of Object.entries(deps)) {
      if (typeof version !== 'string') continue;

      if (version.startsWith('workspace:')) {
        const depPkg = workspacePackages?.get(name);
        const depVersion = depPkg?.version;
        if (!depVersion) {
          delete deps[name];
          continue;
        }

        const protocol = version.slice('workspace:'.length); // *, ^, ~, or a version
        if (protocol === '*' || protocol === '^') {
          deps[name] = '^' + depVersion;
        } else if (protocol === '~') {
          deps[name] = '~' + depVersion;
        } else {
          deps[name] = depVersion;
        }
      } else if (version.startsWith('file:') || version.startsWith('link:')) {
        const depPkg = workspacePackages?.get(name);
        const depVersion = depPkg?.version;
        if (!depVersion) {
          delete deps[name];
          continue;
        }
        deps[name] = '^' + depVersion;
      }
    }
    if (Object.keys(deps).length === 0) {
      delete pkgJson[field];
    }
  }
}


export function stripWorkspaceDeps(pkgJson: Record<string, unknown>): number {
  let count = 0;
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    const deps = pkgJson[field] as Record<string, string> | undefined;
    if (!deps) continue;
    for (const [name, version] of Object.entries(deps)) {
      if (typeof version === 'string' &&
          (version.startsWith('workspace:') || version.startsWith('file:') || version.startsWith('link:'))) {
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
