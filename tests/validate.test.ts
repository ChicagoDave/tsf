import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import type { PackageInfo, ResolvedTarget } from '../src/types';
import { validatePackageOutputs } from '../src/validate';

const TMP_DIR = path.resolve(__dirname, '.validate-test-tmp');

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
});

afterEach(() => {
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
});

describe('validatePackageOutputs', () => {
  it('reports missing main entry', () => {
    fs.writeFileSync(
      path.join(TMP_DIR, 'package.json'),
      JSON.stringify({ name: '@test/lib', main: './dist/index.js' }),
    );
    const issues = validatePackageOutputs(makePkg(), []);
    expect(issues.some((i) => i.level === 'error' && i.message.includes('main'))).toBe(true);
  });

  it('reports missing types entry', () => {
    fs.writeFileSync(
      path.join(TMP_DIR, 'package.json'),
      JSON.stringify({ name: '@test/lib', types: './dist/index.d.ts' }),
    );
    const issues = validatePackageOutputs(makePkg(), []);
    expect(issues.some((i) => i.level === 'error' && i.message.includes('types'))).toBe(true);
  });

  it('reports missing exports entry', () => {
    fs.writeFileSync(
      path.join(TMP_DIR, 'package.json'),
      JSON.stringify({
        name: '@test/lib',
        exports: { '.': { require: './dist/index.js' } },
      }),
    );
    const issues = validatePackageOutputs(makePkg(), []);
    expect(issues.some((i) => i.level === 'error' && i.message.includes('exports'))).toBe(true);
  });

  it('passes when all files exist', () => {
    const distDir = path.join(TMP_DIR, 'dist');
    fs.mkdirSync(distDir, { recursive: true });
    fs.writeFileSync(path.join(distDir, 'index.js'), 'module.exports = {}');
    fs.writeFileSync(path.join(distDir, 'index.d.ts'), 'export {}');

    fs.writeFileSync(
      path.join(TMP_DIR, 'package.json'),
      JSON.stringify({
        name: '@test/lib',
        main: './dist/index.js',
        types: './dist/index.d.ts',
      }),
    );
    const issues = validatePackageOutputs(makePkg(), []);
    expect(issues.filter((i) => i.level === 'error')).toHaveLength(0);
  });

  it('warns about missing declaration files alongside JS', () => {
    const distDir = path.join(TMP_DIR, 'dist');
    fs.mkdirSync(distDir, { recursive: true });
    fs.writeFileSync(path.join(distDir, 'index.js'), 'module.exports = {}');
    // No .d.ts file

    fs.writeFileSync(
      path.join(TMP_DIR, 'package.json'),
      JSON.stringify({ name: '@test/lib' }),
    );

    const targets: ResolvedTarget[] = [
      { name: 'cjs', config: { module: 'commonjs', outDir: 'dist', imports: 'relative', declarations: true } },
    ];
    const issues = validatePackageOutputs(makePkg(), targets);
    expect(issues.some((i) => i.level === 'warning' && i.message.includes('declaration'))).toBe(true);
  });

  it('warns about workspace specifiers in output', () => {
    const distDir = path.join(TMP_DIR, 'dist');
    fs.mkdirSync(distDir, { recursive: true });
    fs.writeFileSync(
      path.join(distDir, 'index.js'),
      'const core = require("@workspace/core");\nmodule.exports = core;',
    );

    fs.writeFileSync(
      path.join(TMP_DIR, 'package.json'),
      JSON.stringify({ name: '@test/lib' }),
    );

    const targets: ResolvedTarget[] = [
      { name: 'cjs', config: { module: 'commonjs', outDir: 'dist', imports: 'relative' } },
    ];
    const issues = validatePackageOutputs(makePkg(), targets);
    expect(issues.some((i) => i.level === 'warning' && i.message.includes('@workspace/core'))).toBe(true);
  });

  it('does not warn about workspace specifiers when imports=preserve', () => {
    const distDir = path.join(TMP_DIR, 'dist');
    fs.mkdirSync(distDir, { recursive: true });
    fs.writeFileSync(
      path.join(distDir, 'index.js'),
      'const core = require("@workspace/core");',
    );

    fs.writeFileSync(
      path.join(TMP_DIR, 'package.json'),
      JSON.stringify({ name: '@test/lib' }),
    );

    const targets: ResolvedTarget[] = [
      { name: 'local', config: { module: 'commonjs', outDir: 'dist', imports: 'preserve' } },
    ];
    const issues = validatePackageOutputs(makePkg(), targets);
    expect(issues.filter((i) => i.message.includes('@workspace/core'))).toHaveLength(0);
  });

  it('reports missing bin entry', () => {
    fs.writeFileSync(
      path.join(TMP_DIR, 'package.json'),
      JSON.stringify({ name: '@test/cli', bin: { cli: './dist/cli.js' } }),
    );
    const issues = validatePackageOutputs(makePkg(), []);
    expect(issues.some((i) => i.level === 'error' && i.message.includes('bin'))).toBe(true);
  });
});
