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

  if (Object.keys(fields).length === 0) {
    logger.verbose('No fields to sync', pkg.name);
    return;
  }

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

  // Sort targets so publish-conditioned targets are preferred (checked first)
  const sorted = [...targets].sort((a, b) => {
    const aPublish = a.config.condition === 'publish' ? 0 : 1;
    const bPublish = b.config.condition === 'publish' ? 0 : 1;
    return aPublish - bPublish;
  });

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
