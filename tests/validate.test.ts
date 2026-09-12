import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import type { PackageInfo, ResolvedTarget } from '../src/types';
import {
  validatePackageOutputs,
  validateManifestTargets,
  exportTargetExists,
  filterPublishablePackages,
} from '../src/validate';

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

  it('passes a wildcard subpath export when the pattern matches files', () => {
    const stylesDir = path.join(TMP_DIR, 'styles', 'themes');
    fs.mkdirSync(stylesDir, { recursive: true });
    fs.writeFileSync(path.join(TMP_DIR, 'styles', 'base.css'), '');

    fs.writeFileSync(
      path.join(TMP_DIR, 'package.json'),
      JSON.stringify({ name: '@test/lib', exports: { './styles/*': './styles/*' } }),
    );
    const issues = validatePackageOutputs(makePkg(), []);
    expect(issues.filter((i) => i.level === 'error')).toHaveLength(0);
  });

  it('reports a wildcard subpath export whose directory is missing', () => {
    fs.writeFileSync(
      path.join(TMP_DIR, 'package.json'),
      JSON.stringify({ name: '@test/lib', exports: { './styles/*': './styles/*' } }),
    );
    const issues = validatePackageOutputs(makePkg(), []);
    expect(issues.some((i) => i.level === 'error' && i.message.includes('./styles/*'))).toBe(true);
  });
});

describe('exportTargetExists', () => {
  it('returns true for a literal path that exists', () => {
    fs.mkdirSync(path.join(TMP_DIR, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(TMP_DIR, 'dist', 'index.js'), '');
    expect(exportTargetExists(TMP_DIR, './dist/index.js')).toBe(true);
  });

  it('returns false for a literal path that does not exist', () => {
    expect(exportTargetExists(TMP_DIR, './dist/index.js')).toBe(false);
  });

  it('matches wildcard files in nested subdirectories', () => {
    const themesDir = path.join(TMP_DIR, 'styles', 'themes');
    fs.mkdirSync(themesDir, { recursive: true });
    fs.writeFileSync(path.join(themesDir, 'dark.css'), '');
    expect(exportTargetExists(TMP_DIR, './styles/*')).toBe(true);
  });

  it('returns false for a wildcard directory containing no files', () => {
    fs.mkdirSync(path.join(TMP_DIR, 'styles', 'empty'), { recursive: true });
    expect(exportTargetExists(TMP_DIR, './styles/*')).toBe(false);
  });

  it('honors a static suffix after the wildcard', () => {
    fs.mkdirSync(path.join(TMP_DIR, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(TMP_DIR, 'dist', 'chunk-abc.js'), '');
    expect(exportTargetExists(TMP_DIR, './dist/*.js')).toBe(true);
    expect(exportTargetExists(TMP_DIR, './dist/*.css')).toBe(false);
  });
});

describe('filterPublishablePackages', () => {
  function makePkgDir(name: string, manifest: Record<string, unknown> | null): PackageInfo {
    const dir = path.join(TMP_DIR, name.replace(/[^a-z0-9]/gi, '-'));
    fs.mkdirSync(dir, { recursive: true });
    if (manifest) {
      fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, ...manifest }));
    }
    return makePkg({ name, path: dir });
  }

  it('keeps packages with publishConfig and drops those without', () => {
    const packages = new Map<string, PackageInfo>([
      ['@test/published', makePkgDir('@test/published', { publishConfig: { access: 'public' } })],
      ['@test/story', makePkgDir('@test/story', {})],
    ]);
    const out = filterPublishablePackages(packages);
    expect([...out.keys()]).toEqual(['@test/published']);
  });

  it('drops private packages even when publishConfig is present', () => {
    const packages = new Map<string, PackageInfo>([
      ['@test/private', makePkgDir('@test/private', { publishConfig: { access: 'public' }, private: true })],
    ]);
    expect(filterPublishablePackages(packages).size).toBe(0);
  });

  it('drops packages whose package.json is missing', () => {
    const packages = new Map<string, PackageInfo>([
      ['@test/broken', makePkgDir('@test/broken', null)],
    ]);
    expect(filterPublishablePackages(packages).size).toBe(0);
  });

  it('does not mutate the input map', () => {
    const packages = new Map<string, PackageInfo>([
      ['@test/story', makePkgDir('@test/story', {})],
    ]);
    filterPublishablePackages(packages);
    expect(packages.size).toBe(1);
  });
});

describe('validateManifestTargets', () => {
  it('resolves a manifest against the directory it is given, not a package tree', () => {
    // The publish gate hands it a staging directory; the same manifest must pass
    // or fail purely on what that directory contains.
    const stagingDir = path.join(TMP_DIR, 'staging');
    fs.mkdirSync(stagingDir, { recursive: true });
    fs.writeFileSync(path.join(stagingDir, 'index.js'), '');
    const manifest = {
      name: '@test/lib',
      main: './index.js',
      exports: { './sub': './sub.js' },
    };

    const issues = validateManifestTargets(
      manifest,
      stagingDir,
      path.join(stagingDir, 'package.json'),
    );

    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('exports["./sub"]');
    expect(issues[0].file).toBe(path.join(stagingDir, 'package.json'));
  });
});
