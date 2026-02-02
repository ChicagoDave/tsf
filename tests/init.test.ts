import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
  readPackageJsonHints,
  readTsconfigHints,
  detectFromPackageJson,
  detectTemplate,
  getTemplateTargets,
} from '../src/cli/detect';
import { init } from '../src/cli/init';

const TMP_DIR = path.resolve(__dirname, '.init-test-tmp');

beforeEach(() => {
  fs.mkdirSync(TMP_DIR, { recursive: true });
});

afterEach(() => {
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
});

describe('detect', () => {
  it('reads package.json hints', () => {
    fs.writeFileSync(
      path.join(TMP_DIR, 'package.json'),
      JSON.stringify({ main: 'dist/index.js', types: 'dist/index.d.ts', bin: { cli: 'dist/cli.js' } }),
    );
    const hints = readPackageJsonHints(TMP_DIR);
    expect(hints).not.toBeNull();
    expect(hints!.main).toBe('dist/index.js');
    expect(hints!.types).toBe('dist/index.d.ts');
    expect(hints!.bin).toEqual({ cli: 'dist/cli.js' });
  });

  it('reads tsconfig hints', () => {
    fs.writeFileSync(
      path.join(TMP_DIR, 'tsconfig.json'),
      JSON.stringify({ compilerOptions: { module: 'esnext', target: 'es2022', declaration: true } }),
    );
    const hints = readTsconfigHints(TMP_DIR);
    expect(hints).not.toBeNull();
    expect(hints!.module).toBe('esnext');
    expect(hints!.target).toBe('es2022');
    expect(hints!.declaration).toBe(true);
  });

  it('detects dual CJS+ESM from exports', () => {
    const targets = detectFromPackageJson({
      exports: {
        '.': {
          require: './dist/index.js',
          import: './dist-esm/index.mjs',
        },
      },
    });
    expect(targets.cjs).toBeDefined();
    expect(targets.esm).toBeDefined();
    expect(targets.cjs.module).toBe('commonjs');
    expect(targets.esm.module).toBe('esnext');
  });

  it('detects CLI target from bin', () => {
    const targets = detectFromPackageJson({ bin: 'dist/cli.js' });
    expect(targets.cli).toBeDefined();
    expect(targets.cli.imports).toBe('bundle');
    expect(targets.cli.banner).toContain('#!/usr/bin/env node');
  });

  it('detects single CJS from main', () => {
    const targets = detectFromPackageJson({ main: 'dist/index.js' });
    expect(targets.local).toBeDefined();
    expect(targets.local.module).toBe('commonjs');
  });

  it('detects template types', () => {
    expect(detectTemplate(null, true)).toBe('monorepo');
    expect(detectTemplate({ bin: 'dist/cli.js' }, false)).toBe('cli');
    expect(detectTemplate({ main: 'dist/index.js' }, false)).toBe('library');
  });

  it('provides template targets', () => {
    const lib = getTemplateTargets('library');
    expect(lib.cjs).toBeDefined();
    expect(lib.esm).toBeDefined();

    const cli = getTemplateTargets('cli');
    expect(cli.cli).toBeDefined();
    expect(cli.cli.imports).toBe('bundle');
  });
});

describe('init', () => {
  it('creates config from package.json hints', () => {
    fs.writeFileSync(
      path.join(TMP_DIR, 'package.json'),
      JSON.stringify({ name: 'test', main: 'dist/index.js', types: 'dist/index.d.ts' }),
    );
    fs.writeFileSync(
      path.join(TMP_DIR, 'tsconfig.json'),
      JSON.stringify({ compilerOptions: { module: 'commonjs' } }),
    );

    init(TMP_DIR);

    const configPath = path.join(TMP_DIR, 'ts-forge.config.json');
    expect(fs.existsSync(configPath)).toBe(true);
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(config.projects).toBeDefined();
    expect(config.targets).toBeDefined();
  });

  it('merges targets on re-run (idempotent)', () => {
    // Create initial config
    fs.writeFileSync(
      path.join(TMP_DIR, 'tsconfig.json'),
      JSON.stringify({ compilerOptions: {} }),
    );
    fs.writeFileSync(
      path.join(TMP_DIR, 'package.json'),
      JSON.stringify({ name: 'test' }),
    );

    init(TMP_DIR);

    const configPath = path.join(TMP_DIR, 'ts-forge.config.json');
    const first = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    const targetCount = Object.keys(first.targets).length;

    // Re-run should not duplicate targets
    init(TMP_DIR);
    const second = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(Object.keys(second.targets).length).toBe(targetCount);
  });
});
