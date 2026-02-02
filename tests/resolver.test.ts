import { describe, it, expect } from 'vitest';
import * as path from 'path';
import { getBuildOrder } from '../src/resolver/graph';
import { detectWorkspace } from '../src/resolver/workspace';
import { resolvePackages } from '../src/resolver/packages';
import type { PackageInfo } from '../src/types';

const FIXTURE_DIR = path.resolve(__dirname, 'fixture');

function makePkg(name: string, deps: string[] = []): PackageInfo {
  return {
    name,
    path: `/fake/${name}`,
    tsconfig: `/fake/${name}/tsconfig.json`,
    dependencies: deps,
    entryPoint: 'src/index.ts',
  };
}

describe('getBuildOrder', () => {
  it('returns single level for independent packages', () => {
    const packages = new Map<string, PackageInfo>([
      ['a', makePkg('a')],
      ['b', makePkg('b')],
    ]);
    const order = getBuildOrder(packages);
    expect(order).toEqual([['a', 'b']]);
  });

  it('orders dependencies before dependents', () => {
    const packages = new Map<string, PackageInfo>([
      ['app', makePkg('app', ['core'])],
      ['core', makePkg('core')],
    ]);
    const order = getBuildOrder(packages);
    expect(order).toEqual([['core'], ['app']]);
  });

  it('handles multi-level dependency chains', () => {
    const packages = new Map<string, PackageInfo>([
      ['c', makePkg('c', ['b'])],
      ['b', makePkg('b', ['a'])],
      ['a', makePkg('a')],
    ]);
    const order = getBuildOrder(packages);
    expect(order).toEqual([['a'], ['b'], ['c']]);
  });

  it('detects circular dependencies', () => {
    const packages = new Map<string, PackageInfo>([
      ['a', makePkg('a', ['b'])],
      ['b', makePkg('b', ['a'])],
    ]);
    expect(() => getBuildOrder(packages)).toThrow('Circular dependency');
  });

  it('ignores external dependencies', () => {
    const packages = new Map<string, PackageInfo>([
      ['app', makePkg('app', ['lodash', 'core'])],
      ['core', makePkg('core')],
    ]);
    const order = getBuildOrder(packages);
    expect(order).toEqual([['core'], ['app']]);
  });
});

describe('detectWorkspace', () => {
  it('detects pnpm workspace from fixture', () => {
    const ws = detectWorkspace(FIXTURE_DIR);
    expect(ws).not.toBeNull();
    expect(ws!.type).toBe('pnpm');
    expect(ws!.packageGlobs).toContain('packages/*');
  });
});

describe('resolvePackages', () => {
  it('resolves packages from fixture', () => {
    const config = { projects: ['packages/*/tsconfig.json'] };
    const packages = resolvePackages(config, FIXTURE_DIR);
    expect(packages.size).toBe(2);
    expect(packages.has('@test/core')).toBe(true);
    expect(packages.has('@test/app')).toBe(true);
  });

  it('resolves dependencies correctly', () => {
    const config = { projects: ['packages/*/tsconfig.json'] };
    const packages = resolvePackages(config, FIXTURE_DIR);
    const app = packages.get('@test/app')!;
    expect(app.dependencies).toContain('@test/core');
    const core = packages.get('@test/core')!;
    expect(core.dependencies).not.toContain('@test/app');
  });

  it('resolves entry points', () => {
    const config = { projects: ['packages/*/tsconfig.json'] };
    const packages = resolvePackages(config, FIXTURE_DIR);
    const core = packages.get('@test/core')!;
    expect(core.entryPoint).toMatch(/src\/index\.ts$/);
  });
});
