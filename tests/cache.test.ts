import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { computeCacheKey, isCached, recordBuild, loadCacheEntry, cleanCache } from '../src/cache';
import type { PackageInfo, ResolvedTarget } from '../src/types';

const TMP_DIR = path.resolve(__dirname, '.cache-test-tmp');
const CACHE_DIR = path.join(TMP_DIR, '.tsf-cache');
const PKG_DIR = path.join(TMP_DIR, 'pkg-a');

function makePkg(overrides: Partial<PackageInfo> = {}): PackageInfo {
  return {
    name: '@test/a',
    path: PKG_DIR,
    tsconfig: 'tsconfig.json',
    dependencies: [],
    entryPoint: 'src/index.ts',
    ...overrides,
  };
}

function makeTarget(overrides: Partial<ResolvedTarget> = {}): ResolvedTarget {
  return {
    name: 'local',
    config: { module: 'commonjs', outDir: 'dist', imports: 'preserve' },
    ...overrides,
  };
}

function writeSource(content: string): void {
  const srcDir = path.join(PKG_DIR, 'src');
  fs.mkdirSync(srcDir, { recursive: true });
  fs.writeFileSync(path.join(srcDir, 'index.ts'), content, 'utf-8');
}

function writeTsconfig(): void {
  fs.writeFileSync(
    path.join(PKG_DIR, 'tsconfig.json'),
    JSON.stringify({ compilerOptions: { outDir: 'dist' } }),
    'utf-8',
  );
}

function writeOutputFiles(pkg: PackageInfo, target: ResolvedTarget): string[] {
  const outDir = path.join(pkg.path, target.config.outDir!);
  fs.mkdirSync(outDir, { recursive: true });
  const files = [path.join(outDir, 'index.js'), path.join(outDir, 'index.d.ts')];
  for (const f of files) fs.writeFileSync(f, '// output', 'utf-8');
  return files;
}

beforeEach(() => {
  fs.mkdirSync(TMP_DIR, { recursive: true });
  writeSource('export const x = 1;');
  writeTsconfig();
});

afterEach(() => {
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
});

describe('computeCacheKey', () => {
  it('returns consistent hash for same inputs', () => {
    const pkg = makePkg();
    const target = makeTarget();
    const key1 = computeCacheKey(pkg, target, TMP_DIR, new Map());
    const key2 = computeCacheKey(pkg, target, TMP_DIR, new Map());
    expect(key1).toBe(key2);
    expect(key1).toMatch(/^[a-f0-9]{64}$/);
  });

  it('returns different hash when source changes', () => {
    const pkg = makePkg();
    const target = makeTarget();
    const key1 = computeCacheKey(pkg, target, TMP_DIR, new Map());

    writeSource('export const x = 2;');
    const key2 = computeCacheKey(pkg, target, TMP_DIR, new Map());
    expect(key1).not.toBe(key2);
  });

  it('returns different hash when target config changes', () => {
    const pkg = makePkg();
    const key1 = computeCacheKey(pkg, makeTarget(), TMP_DIR, new Map());
    const key2 = computeCacheKey(
      pkg,
      makeTarget({ config: { module: 'esnext', outDir: 'dist-esm', imports: 'preserve' } }),
      TMP_DIR,
      new Map(),
    );
    expect(key1).not.toBe(key2);
  });

  it('returns different hash when dep cache key changes', () => {
    const pkg = makePkg({ dependencies: ['@test/core'] });
    const target = makeTarget();
    const deps1 = new Map([['@test/core', 'aaa']]);
    const deps2 = new Map([['@test/core', 'bbb']]);
    const key1 = computeCacheKey(pkg, target, TMP_DIR, deps1);
    const key2 = computeCacheKey(pkg, target, TMP_DIR, deps2);
    expect(key1).not.toBe(key2);
  });
});

describe('isCached', () => {
  it('returns null when no cache entry exists', () => {
    const pkg = makePkg();
    const target = makeTarget();
    expect(isCached(CACHE_DIR, pkg, target, TMP_DIR, new Map())).toBeNull();
  });

  it('returns key when cache is valid', () => {
    const pkg = makePkg();
    const target = makeTarget();
    const outputFiles = writeOutputFiles(pkg, target);
    const key = computeCacheKey(pkg, target, TMP_DIR, new Map());

    recordBuild(CACHE_DIR, pkg, target, key, outputFiles);

    const result = isCached(CACHE_DIR, pkg, target, TMP_DIR, new Map());
    expect(result).toBe(key);
  });

  it('returns null when output files are missing', () => {
    const pkg = makePkg();
    const target = makeTarget();
    const outputFiles = writeOutputFiles(pkg, target);
    const key = computeCacheKey(pkg, target, TMP_DIR, new Map());

    recordBuild(CACHE_DIR, pkg, target, key, outputFiles);

    // Remove an output file
    fs.unlinkSync(outputFiles[0]);

    expect(isCached(CACHE_DIR, pkg, target, TMP_DIR, new Map())).toBeNull();
  });

  it('returns null when source has changed', () => {
    const pkg = makePkg();
    const target = makeTarget();
    const outputFiles = writeOutputFiles(pkg, target);
    const key = computeCacheKey(pkg, target, TMP_DIR, new Map());

    recordBuild(CACHE_DIR, pkg, target, key, outputFiles);

    // Modify source
    writeSource('export const x = 999;');

    expect(isCached(CACHE_DIR, pkg, target, TMP_DIR, new Map())).toBeNull();
  });
});

describe('recordBuild + loadCacheEntry', () => {
  it('round-trips correctly', () => {
    const pkg = makePkg();
    const target = makeTarget();
    const key = 'abc123';
    const outputFiles = ['/tmp/dist/index.js'];

    recordBuild(CACHE_DIR, pkg, target, key, outputFiles);
    const entry = loadCacheEntry(CACHE_DIR, pkg, target);

    expect(entry).not.toBeNull();
    expect(entry!.key).toBe(key);
    expect(entry!.outputFiles).toEqual(outputFiles);
    expect(entry!.timestamp).toBeGreaterThan(0);
  });
});

describe('cleanCache', () => {
  it('removes cache directory', () => {
    const pkg = makePkg();
    const target = makeTarget();
    recordBuild(CACHE_DIR, pkg, target, 'key', []);

    expect(fs.existsSync(CACHE_DIR)).toBe(true);
    cleanCache(CACHE_DIR);
    expect(fs.existsSync(CACHE_DIR)).toBe(false);
  });
});
