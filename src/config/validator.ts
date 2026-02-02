import type { TsForgeConfig, TargetConfig } from '../types';

const VALID_IMPORTS = ['preserve', 'relative', 'bundle', 'specifier-map'] as const;
const VALID_MODULES = ['commonjs', 'esnext', 'es2015', 'es2020', 'es2022', 'node16', 'nodenext'] as const;
const VALID_FORMATS = ['cjs', 'esm', 'iife', 'umd'] as const;
const VALID_TRANSPILERS = ['tsc', 'esbuild', 'swc'] as const;
const VALID_BUNDLERS = ['esbuild', 'rollup'] as const;

export function validateConfig(config: unknown): string[] {
  const errors: string[] = [];

  if (!config || typeof config !== 'object') {
    return ['Config must be an object'];
  }

  const c = config as Record<string, unknown>;

  if (!Array.isArray(c.projects) || c.projects.length === 0) {
    errors.push('"projects" is required and must be a non-empty array of glob strings');
  } else {
    for (const p of c.projects) {
      if (typeof p !== 'string') {
        errors.push(`Each entry in "projects" must be a string, got ${typeof p}`);
      }
    }
  }

  if (c.targets !== undefined) {
    if (typeof c.targets !== 'object' || c.targets === null) {
      errors.push('"targets" must be an object');
    } else {
      for (const [name, target] of Object.entries(c.targets as Record<string, unknown>)) {
        errors.push(...validateTarget(name, target));
      }
    }
  }

  return errors;
}

function validateTarget(name: string, target: unknown): string[] {
  const errors: string[] = [];
  const prefix = `targets.${name}`;

  if (!target || typeof target !== 'object') {
    return [`${prefix} must be an object`];
  }

  const t = target as Record<string, unknown>;

  if (t.imports !== undefined && !includes(VALID_IMPORTS, t.imports)) {
    errors.push(`${prefix}.imports must be one of: ${VALID_IMPORTS.join(', ')}`);
  }
  if (t.module !== undefined && !includes(VALID_MODULES, t.module)) {
    errors.push(`${prefix}.module must be one of: ${VALID_MODULES.join(', ')}`);
  }
  if (t.format !== undefined && !includes(VALID_FORMATS, t.format)) {
    errors.push(`${prefix}.format must be one of: ${VALID_FORMATS.join(', ')}`);
  }
  if (t.transpiler !== undefined && !includes(VALID_TRANSPILERS, t.transpiler)) {
    errors.push(`${prefix}.transpiler must be one of: ${VALID_TRANSPILERS.join(', ')}`);
  }
  if (t.bundler !== undefined && !includes(VALID_BUNDLERS, t.bundler)) {
    errors.push(`${prefix}.bundler must be one of: ${VALID_BUNDLERS.join(', ')}`);
  }
  if (t.imports === 'bundle' && !t.bundler) {
    errors.push(`${prefix}: imports="bundle" requires a "bundler" to be specified`);
  }
  if (t.outDir !== undefined && typeof t.outDir !== 'string') {
    errors.push(`${prefix}.outDir must be a string`);
  }
  if (t.outFile !== undefined && typeof t.outFile !== 'string') {
    errors.push(`${prefix}.outFile must be a string`);
  }
  if (!t.outDir && !t.outFile) {
    errors.push(`${prefix}: either "outDir" or "outFile" is required`);
  }

  return errors;
}

function includes(arr: readonly string[], value: unknown): boolean {
  return typeof value === 'string' && (arr as readonly string[]).includes(value);
}
