import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import type { PackageInfo, ResolvedTarget } from '../src/types';
import { generateFields, syncPackageJson } from '../src/sync/package-json';

const TMP_DIR = path.resolve(__dirname, '.sync-test-tmp');

function makePkg(overrides: Partial<PackageInfo> = {}): PackageInfo {
  return {
    name: '@test/lib',
    path: TMP_DIR,
    tsconfig: path.join(TMP_DIR, 'tsconfig.json'),
    dependencies: [],
    entryPoint: 'src/index.ts',
    ...overrides,
  };
}

beforeEach(() => {
  fs.mkdirSync(TMP_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(TMP_DIR, 'package.json'),
    JSON.stringify({ name: '@test/lib', version: '1.0.0' }),
  );
});

afterEach(() => {
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
});

describe('generateFields', () => {
  it('generates main from CJS target', () => {
    const targets: ResolvedTarget[] = [
      { name: 'cjs', config: { module: 'commonjs', outDir: 'dist', imports: 'relative' } },
    ];
    const fields = generateFields(makePkg(), targets);
    expect(fields.main).toBe('./dist/index.js');
  });

  it('generates module from ESM target', () => {
    const targets: ResolvedTarget[] = [
      { name: 'esm', config: { module: 'esnext', outDir: 'dist-esm', imports: 'relative' } },
    ];
    const fields = generateFields(makePkg(), targets);
    expect(fields.module).toBe('./dist-esm/index.js');
  });

  it('generates types from target with declarations', () => {
    const targets: ResolvedTarget[] = [
      { name: 'cjs', config: { module: 'commonjs', outDir: 'dist', imports: 'relative', declarations: true } },
    ];
    const fields = generateFields(makePkg(), targets);
    expect(fields.types).toBe('./dist/index.d.ts');
  });

  it('generates exports with conditions', () => {
    const targets: ResolvedTarget[] = [
      { name: 'cjs', config: { module: 'commonjs', outDir: 'dist', imports: 'relative', declarations: true } },
      { name: 'esm', config: { module: 'esnext', outDir: 'dist-esm', imports: 'relative' } },
    ];
    const fields = generateFields(makePkg(), targets);
    expect(fields.exports).toBeDefined();
    const root = fields.exports!['.'] as Record<string, string>;
    expect(root.require).toBe('./dist/index.js');
    expect(root.import).toBe('./dist-esm/index.js');
    expect(root.types).toBe('./dist/index.d.ts');
  });

  it('generates bin from shebang target', () => {
    const targets: ResolvedTarget[] = [
      { name: 'cli', config: { outDir: 'dist', imports: 'bundle', bundler: 'esbuild', banner: '#!/usr/bin/env node' } },
    ];
    // Write package.json with name for bin key inference
    fs.writeFileSync(
      path.join(TMP_DIR, 'package.json'),
      JSON.stringify({ name: '@test/my-cli', version: '1.0.0' }),
    );
    const fields = generateFields(makePkg(), targets);
    expect(fields.bin).toBeDefined();
    expect((fields.bin as Record<string, string>)['my-cli']).toBe('./dist/index.js');
  });
});

describe('syncPackageJson', () => {
  it('writes generated fields to package.json', () => {
    const targets: ResolvedTarget[] = [
      { name: 'cjs', config: { module: 'commonjs', outDir: 'dist', imports: 'relative', declarations: true } },
    ];
    syncPackageJson(makePkg(), targets);

    const pkg = JSON.parse(fs.readFileSync(path.join(TMP_DIR, 'package.json'), 'utf-8'));
    expect(pkg.main).toBe('./dist/index.js');
    expect(pkg.types).toBe('./dist/index.d.ts');
    // Preserves existing fields
    expect(pkg.name).toBe('@test/lib');
    expect(pkg.version).toBe('1.0.0');
  });

  it('is idempotent', () => {
    const targets: ResolvedTarget[] = [
      { name: 'cjs', config: { module: 'commonjs', outDir: 'dist', imports: 'relative' } },
    ];
    syncPackageJson(makePkg(), targets);
    const first = fs.readFileSync(path.join(TMP_DIR, 'package.json'), 'utf-8');
    syncPackageJson(makePkg(), targets);
    const second = fs.readFileSync(path.join(TMP_DIR, 'package.json'), 'utf-8');
    expect(first).toBe(second);
  });
});
