/**
 * @fileoverview Project structure detection for configuration generation
 * @module tsf/cli/detect
 *
 * Analyzes existing project files to auto-detect build configuration.
 * Used by `tsf init` to generate sensible defaults.
 *
 * Detection sources:
 * - `package.json`: main, module, types, bin, type, exports
 * - `tsconfig.json`: module, target, declaration, outDir
 *
 * Templates:
 * - `library`: ESM + CJS dual output with declarations
 * - `cli`: Single executable with shebang
 * - `monorepo`: Multiple packages with workspace resolution
 */

import * as fs from 'fs';
import * as path from 'path';
import type { TargetConfig, DefaultConfig } from '../types';

/**
 * Auto-detected configuration from project analysis.
 */
export interface DetectedConfig {
  /** Detected build targets */
  targets: Record<string, TargetConfig>;
  /** Detected default settings */
  defaults: DefaultConfig;
  /** Detected tsconfig.json glob patterns */
  projects: string[];
  /** Detected project template */
  template?: 'library' | 'cli' | 'monorepo';
}

/**
 * Hints extracted from package.json.
 */
export interface PackageJsonHints {
  main?: string;
  module?: string;
  types?: string;
  bin?: string | Record<string, string>;
  type?: 'module' | 'commonjs';
  exports?: Record<string, unknown>;
}

/**
 * Hints extracted from tsconfig.json.
 */
export interface TsconfigHints {
  module?: string;
  target?: string;
  moduleResolution?: string;
  declaration?: boolean;
  outDir?: string;
  composite?: boolean;
}

export function readPackageJsonHints(dir: string): PackageJsonHints | null {
  const pkgPath = path.join(dir, 'package.json');
  if (!fs.existsSync(pkgPath)) return null;
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    return {
      main: pkg.main,
      module: pkg.module,
      types: pkg.types ?? pkg.typings,
      bin: pkg.bin,
      type: pkg.type,
      exports: pkg.exports,
    };
  } catch {
    return null;
  }
}

export function readTsconfigHints(dir: string): TsconfigHints | null {
  const tsconfigPath = path.join(dir, 'tsconfig.json');
  if (!fs.existsSync(tsconfigPath)) return null;
  try {
    const raw = fs.readFileSync(tsconfigPath, 'utf-8');
    // Strip comments (simple single-line // and /* */ removal)
    const stripped = raw.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    const tsconfig = JSON.parse(stripped);
    const co = tsconfig.compilerOptions ?? {};
    return {
      module: co.module,
      target: co.target,
      moduleResolution: co.moduleResolution,
      declaration: co.declaration,
      outDir: co.outDir,
      composite: co.composite,
    };
  } catch {
    return null;
  }
}

export function detectFromPackageJson(hints: PackageJsonHints): Record<string, TargetConfig> {
  const targets: Record<string, TargetConfig> = {};

  // Check for dual CJS+ESM via exports
  if (hints.exports && typeof hints.exports === 'object') {
    const root = (hints.exports as Record<string, unknown>)['.'];
    if (root && typeof root === 'object') {
      const conditions = root as Record<string, unknown>;
      if (conditions.require && conditions.import) {
        const cjsOut = extractDir(conditions.require as string);
        const esmOut = extractDir(conditions.import as string);
        targets.cjs = {
          module: 'commonjs',
          outDir: cjsOut || 'dist',
          imports: 'relative',
          declarations: true,
        };
        targets.esm = {
          module: 'esnext',
          outDir: esmOut || 'dist-esm',
          imports: 'relative',
          declarations: true,
        };
        return targets;
      }
    }
  }

  // Check for bin field → CLI tool
  if (hints.bin) {
    const binPath = typeof hints.bin === 'string' ? hints.bin : Object.values(hints.bin)[0];
    const outDir = extractDir(binPath) || 'dist';
    targets.cli = {
      outDir,
      imports: 'bundle',
      bundler: 'esbuild',
      banner: '#!/usr/bin/env node',
    };
    return targets;
  }

  // Check for module field → dual output
  if (hints.module) {
    const cjsOut = extractDir(hints.main) || 'dist';
    const esmOut = extractDir(hints.module) || 'dist-esm';
    targets.cjs = {
      module: 'commonjs',
      outDir: cjsOut,
      imports: 'relative',
      declarations: true,
    };
    targets.esm = {
      module: 'esnext',
      outDir: esmOut,
      imports: 'relative',
      declarations: true,
    };
    return targets;
  }

  // main only → single CJS target
  if (hints.main) {
    const outDir = extractDir(hints.main) || 'dist';
    targets.local = {
      module: hints.type === 'module' ? 'esnext' : 'commonjs',
      outDir,
      imports: 'preserve',
      declarations: !!hints.types,
    };
    return targets;
  }

  return targets;
}

export function detectDefaults(tsHints: TsconfigHints | null): DefaultConfig {
  const defaults: DefaultConfig = {
    transpiler: 'tsc',
    typeCheck: true,
    sourceMap: true,
    clean: false,
  };
  return defaults;
}

export function detectTemplate(
  pkgHints: PackageJsonHints | null,
  isWorkspace: boolean,
): 'library' | 'cli' | 'monorepo' {
  if (isWorkspace) return 'monorepo';
  if (pkgHints?.bin) return 'cli';
  return 'library';
}

export function getTemplateTargets(template: 'library' | 'cli' | 'monorepo'): Record<string, TargetConfig> {
  switch (template) {
    case 'library':
      return {
        cjs: {
          module: 'commonjs',
          outDir: 'dist',
          imports: 'relative',
          declarations: true,
        },
        esm: {
          module: 'esnext',
          outDir: 'dist-esm',
          imports: 'relative',
          declarations: true,
        },
      };
    case 'cli':
      return {
        cli: {
          outDir: 'dist',
          imports: 'bundle',
          bundler: 'esbuild',
          banner: '#!/usr/bin/env node',
        },
      };
    case 'monorepo':
      return {
        local: {
          module: 'commonjs',
          outDir: 'dist',
          imports: 'relative',
          declarations: true,
        },
      };
  }
}

function extractDir(filePath?: string): string | undefined {
  if (!filePath) return undefined;
  const cleaned = filePath.replace(/^\.\//, '');
  const dir = path.dirname(cleaned);
  return dir === '.' ? undefined : dir;
}
