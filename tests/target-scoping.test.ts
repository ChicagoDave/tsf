import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { shouldSkipTarget } from '../src/orchestrator';
import type { PackageInfo, ResolvedTarget } from '../src/types';

const TMP_DIR = path.resolve(__dirname, '.target-scoping-tmp');

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

function makeTarget(name: string, condition?: string): ResolvedTarget {
  return {
    name,
    config: {
      module: 'commonjs',
      outDir: name === 'npm' ? 'dist-npm' : 'dist',
      imports: condition ? 'relative' : 'preserve',
      declarations: true,
      ...(condition ? { condition } : {}),
    },
  };
}

beforeEach(() => {
  fs.mkdirSync(TMP_DIR, { recursive: true });
});

afterEach(() => {
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
});

describe('shouldSkipTarget', () => {
  it('never skips unconditional targets', () => {
    fs.writeFileSync(path.join(TMP_DIR, 'package.json'), JSON.stringify({ name: '@test/lib' }));
    const pkg = makePkg();
    const target = makeTarget('local');
    expect(shouldSkipTarget(pkg, target)).toBe(false);
  });

  it('skips publish target for packages without publishConfig', () => {
    fs.writeFileSync(path.join(TMP_DIR, 'package.json'), JSON.stringify({ name: '@test/lib' }));
    const pkg = makePkg();
    const target = makeTarget('npm', 'publish');
    expect(shouldSkipTarget(pkg, target)).toBe(true);
  });

  it('skips publish target for private packages without publishConfig', () => {
    fs.writeFileSync(path.join(TMP_DIR, 'package.json'), JSON.stringify({ name: '@test/lib', private: true }));
    const pkg = makePkg();
    const target = makeTarget('npm', 'publish');
    expect(shouldSkipTarget(pkg, target)).toBe(true);
  });

  it('includes publish target for packages with publishConfig', () => {
    fs.writeFileSync(path.join(TMP_DIR, 'package.json'), JSON.stringify({
      name: '@test/lib',
      publishConfig: { access: 'public' },
    }));
    const pkg = makePkg();
    const target = makeTarget('npm', 'publish');
    expect(shouldSkipTarget(pkg, target)).toBe(false);
  });

  it('includes publish target for private packages with publishConfig', () => {
    fs.writeFileSync(path.join(TMP_DIR, 'package.json'), JSON.stringify({
      name: '@test/lib',
      private: true,
      publishConfig: { access: 'public' },
    }));
    const pkg = makePkg();
    const target = makeTarget('npm', 'publish');
    expect(shouldSkipTarget(pkg, target)).toBe(false);
  });

  it('skips when package.json is missing', () => {
    const pkg = makePkg({ path: path.join(TMP_DIR, 'nonexistent') });
    const target = makeTarget('npm', 'publish');
    expect(shouldSkipTarget(pkg, target)).toBe(true);
  });
});
