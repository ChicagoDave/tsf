import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import type { PackageInfo, ResolvedTarget } from '../src/types';
import { bundleWithEsbuild } from '../src/compilers/esbuild-bundler';
import { getBundler } from '../src/compilers';
import { bundleWithRollup } from '../src/compilers/rollup-bundler';

const TMP_DIR = path.resolve(__dirname, '.bundler-test-tmp');

function makePkg(overrides: Partial<PackageInfo> = {}): PackageInfo {
  return {
    name: '@test/app',
    path: path.join(TMP_DIR, 'app'),
    tsconfig: path.join(TMP_DIR, 'app', 'tsconfig.json'),
    dependencies: [],
    entryPoint: 'src/index.ts',
    ...overrides,
  };
}

function makeTarget(overrides: Partial<ResolvedTarget> = {}): ResolvedTarget {
  return {
    name: 'bundle',
    config: {
      format: 'cjs',
      outDir: 'dist',
      imports: 'bundle',
      bundler: 'esbuild',
    },
    ...overrides,
  };
}

function writePackageSource(pkgDir: string, entry: string, content: string): void {
  const dir = path.dirname(path.join(pkgDir, entry));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(pkgDir, entry), content, 'utf-8');
}

function writeTsconfig(pkgDir: string): void {
  fs.mkdirSync(pkgDir, { recursive: true });
  fs.writeFileSync(
    path.join(pkgDir, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        target: 'es2020',
        module: 'esnext',
        moduleResolution: 'node',
        outDir: 'dist',
        rootDir: 'src',
        esModuleInterop: true,
        declaration: true,
      },
      include: ['src'],
    }),
    'utf-8',
  );
}

beforeEach(() => {
  fs.mkdirSync(TMP_DIR, { recursive: true });
});

afterEach(() => {
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
});

describe('esbuild bundler', () => {
  it('produces output in outDir', async () => {
    const pkg = makePkg();
    writeTsconfig(pkg.path);
    writePackageSource(pkg.path, 'src/index.ts', 'export const hello = "world";');

    const target = makeTarget();
    const result = await bundleWithEsbuild(pkg, target, TMP_DIR);

    expect(result.success).toBe(true);
    expect(result.outputFiles.length).toBeGreaterThan(0);

    const outDir = path.resolve(pkg.path, 'dist');
    expect(fs.existsSync(outDir)).toBe(true);
  });

  it('produces single file with outFile', async () => {
    const pkg = makePkg();
    writeTsconfig(pkg.path);
    writePackageSource(pkg.path, 'src/index.ts', 'export const hello = "world";');

    const target = makeTarget({
      config: {
        format: 'cjs',
        outFile: 'dist/bundle.js',
        imports: 'bundle',
        bundler: 'esbuild',
      },
    });
    const result = await bundleWithEsbuild(pkg, target, TMP_DIR);

    expect(result.success).toBe(true);
    const outFile = path.resolve(pkg.path, 'dist/bundle.js');
    expect(fs.existsSync(outFile)).toBe(true);
  });

  it('resolves and inlines workspace imports', async () => {
    const corePkgDir = path.join(TMP_DIR, 'core');
    writeTsconfig(corePkgDir);
    writePackageSource(corePkgDir, 'src/index.ts', 'export const coreValue = 42;');

    const pkg = makePkg({ dependencies: ['@test/core'] });
    writeTsconfig(pkg.path);
    writePackageSource(
      pkg.path,
      'src/index.ts',
      'import { coreValue } from "@test/core";\nexport const result = coreValue + 1;',
    );

    const corePkg: PackageInfo = {
      name: '@test/core',
      path: corePkgDir,
      tsconfig: path.join(corePkgDir, 'tsconfig.json'),
      dependencies: [],
      entryPoint: 'src/index.ts',
    };

    const packages = new Map<string, PackageInfo>();
    packages.set('@test/core', corePkg);
    packages.set('@test/app', pkg);

    const target = makeTarget({
      config: { format: 'cjs', outFile: 'dist/bundle.js', imports: 'bundle', bundler: 'esbuild' },
    });
    const result = await bundleWithEsbuild(pkg, target, TMP_DIR, packages);

    expect(result.success).toBe(true);
    const outFile = path.resolve(pkg.path, 'dist/bundle.js');
    const content = fs.readFileSync(outFile, 'utf-8');
    expect(content).toContain('coreValue');
    expect(content).not.toContain('@test/core');
  });

  it('marks external packages as external', async () => {
    const pkg = makePkg();
    writeTsconfig(pkg.path);
    writePackageSource(
      pkg.path,
      'src/index.ts',
      'import * as fs from "fs";\nexport const x = fs.existsSync;',
    );

    const target = makeTarget({
      config: {
        format: 'cjs',
        outFile: 'dist/bundle.js',
        imports: 'bundle',
        bundler: 'esbuild',
        external: ['fs'],
      },
    });
    const result = await bundleWithEsbuild(pkg, target, TMP_DIR);

    expect(result.success).toBe(true);
    const content = fs.readFileSync(path.resolve(pkg.path, 'dist/bundle.js'), 'utf-8');
    expect(content).toContain('require("fs")');
  });

  it('supports esm format', async () => {
    const pkg = makePkg();
    writeTsconfig(pkg.path);
    writePackageSource(pkg.path, 'src/index.ts', 'export const hello = "world";');

    const target = makeTarget({
      config: { format: 'esm', outFile: 'dist/bundle.mjs', imports: 'bundle', bundler: 'esbuild' },
    });
    const result = await bundleWithEsbuild(pkg, target, TMP_DIR);

    expect(result.success).toBe(true);
    const content = fs.readFileSync(path.resolve(pkg.path, 'dist/bundle.mjs'), 'utf-8');
    expect(content).toContain('hello');
  });

  it('supports iife format', async () => {
    const pkg = makePkg();
    writeTsconfig(pkg.path);
    writePackageSource(pkg.path, 'src/index.ts', 'export const hello = "world";');

    const target = makeTarget({
      config: { format: 'iife', outFile: 'dist/bundle.js', imports: 'bundle', bundler: 'esbuild' },
    });
    const result = await bundleWithEsbuild(pkg, target, TMP_DIR);

    expect(result.success).toBe(true);
    const content = fs.readFileSync(path.resolve(pkg.path, 'dist/bundle.js'), 'utf-8');
    expect(content).toContain('(()');
  });

  it('injects banner when configured', async () => {
    const pkg = makePkg();
    writeTsconfig(pkg.path);
    writePackageSource(pkg.path, 'src/index.ts', 'export const hello = "world";');

    const target = makeTarget({
      config: {
        format: 'cjs',
        outFile: 'dist/bundle.js',
        imports: 'bundle',
        bundler: 'esbuild',
        banner: '/* my banner */',
      },
    });
    const result = await bundleWithEsbuild(pkg, target, TMP_DIR);

    expect(result.success).toBe(true);
    const content = fs.readFileSync(path.resolve(pkg.path, 'dist/bundle.js'), 'utf-8');
    expect(content).toContain('/* my banner */');
  });
});

describe('bundler exports', () => {
  it('bundleWithEsbuild is a function', () => {
    expect(typeof bundleWithEsbuild).toBe('function');
  });

  it('bundleWithRollup is a function', () => {
    expect(typeof bundleWithRollup).toBe('function');
  });

  it('getBundler is a function', () => {
    expect(typeof getBundler).toBe('function');
  });
});
