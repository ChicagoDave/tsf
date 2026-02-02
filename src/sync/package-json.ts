import * as fs from 'fs';
import * as path from 'path';
import type { ResolvedTarget, PackageInfo } from '../types';
import * as logger from '../utils/logger';

interface ExportsConditions {
  types?: string;
  import?: string;
  require?: string;
  default?: string;
}

interface GeneratedFields {
  main?: string;
  module?: string;
  types?: string;
  exports?: Record<string, ExportsConditions | string>;
  bin?: string | Record<string, string>;
}

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
 * Generate a clean package.json for npm publish.
 * Strips workspace:* deps, devDependencies, and sets entry points
 * relative to the staging dir root (flat output).
 */
export function generatePublishManifest(pkg: PackageInfo): Record<string, unknown> {
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

  // Strip workspace:* from dependencies
  stripWorkspaceDeps(manifest);

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

export function stripWorkspaceDeps(pkgJson: Record<string, unknown>): number {
  let count = 0;
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
    const deps = pkgJson[field] as Record<string, string> | undefined;
    if (!deps) continue;
    for (const [name, version] of Object.entries(deps)) {
      if (typeof version === 'string' && version.startsWith('workspace:')) {
        delete deps[name];
        count++;
      }
    }
    if (Object.keys(deps).length === 0) {
      delete pkgJson[field];
    }
  }
  return count;
}

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
