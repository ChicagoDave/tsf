import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import type { PackageInfo, ResolvedTarget } from '../src/types';
import { generateFields, syncPackageJson, stripWorkspaceDeps, generatePublishManifest, writePublishManifest } from '../src/sync/package-json';

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

  it('does not strip workspace deps', () => {
    fs.writeFileSync(
      path.join(TMP_DIR, 'package.json'),
      JSON.stringify({
        name: '@test/lib',
        version: '1.0.0',
        dependencies: { '@scope/core': 'workspace:*' },
      }),
    );
    const targets: ResolvedTarget[] = [
      { name: 'npm', config: { module: 'commonjs', outDir: 'dist', imports: 'relative' } },
    ];
    syncPackageJson(makePkg(), targets);

    const pkg = JSON.parse(fs.readFileSync(path.join(TMP_DIR, 'package.json'), 'utf-8'));
    expect(pkg.dependencies).toEqual({ '@scope/core': 'workspace:*' });
  });
});

describe('stripWorkspaceDeps', () => {
  it('removes workspace: entries from all dep fields', () => {
    const pkgJson: Record<string, unknown> = {
      dependencies: { a: 'workspace:*', b: '^1.0.0' },
      devDependencies: { c: 'workspace:^' },
      optionalDependencies: { d: 'workspace:~', e: '1.0.0' },
    };
    const count = stripWorkspaceDeps(pkgJson);
    expect(count).toBe(3);
    expect(pkgJson.dependencies).toEqual({ b: '^1.0.0' });
    expect(pkgJson.devDependencies).toBeUndefined();
    expect(pkgJson.optionalDependencies).toEqual({ e: '1.0.0' });
  });

  it('removes file: and link: entries', () => {
    const pkgJson: Record<string, unknown> = {
      dependencies: { a: 'file:../a', b: 'link:../b', c: '^1.0.0' },
    };
    const count = stripWorkspaceDeps(pkgJson);
    expect(count).toBe(2);
    expect(pkgJson.dependencies).toEqual({ c: '^1.0.0' });
  });

  it('returns 0 when no workspace deps exist', () => {
    const pkgJson: Record<string, unknown> = {
      dependencies: { a: '^1.0.0' },
    };
    expect(stripWorkspaceDeps(pkgJson)).toBe(0);
  });
});

describe('generatePublishManifest', () => {
  it('strips workspace deps and devDependencies', () => {
    fs.writeFileSync(
      path.join(TMP_DIR, 'package.json'),
      JSON.stringify({
        name: '@test/lib',
        version: '2.0.0',
        dependencies: { '@scope/core': 'workspace:*', 'lz-string': '^2.0.0' },
        devDependencies: { vitest: '^3.0.0' },
        publishConfig: { access: 'public' },
      }),
    );
    const manifest = generatePublishManifest(makePkg());
    expect(manifest.name).toBe('@test/lib');
    expect(manifest.version).toBe('2.0.0');
    expect(manifest.dependencies).toEqual({ 'lz-string': '^2.0.0' });
    expect(manifest.devDependencies).toBeUndefined();
    expect(manifest.publishConfig).toEqual({ access: 'public' });
  });

  it('sets entry points relative to root', () => {
    fs.writeFileSync(
      path.join(TMP_DIR, 'package.json'),
      JSON.stringify({ name: '@test/lib', version: '1.0.0' }),
    );
    const manifest = generatePublishManifest(makePkg());
    expect(manifest.main).toBe('./index.js');
    expect(manifest.types).toBe('./index.d.ts');
    const exports = manifest.exports as Record<string, Record<string, string>>;
    expect(exports['.']).toBeDefined();
    expect(exports['.'].require).toBe('./index.js');
    expect(exports['.'].types).toBe('./index.d.ts');
  });

  it('resolves workspace: deps to real versions', () => {
    fs.writeFileSync(
      path.join(TMP_DIR, 'package.json'),
      JSON.stringify({
        name: '@test/lib',
        version: '1.0.0',
        dependencies: { '@test/core': 'workspace:*', '@test/utils': 'workspace:^', '@test/data': 'workspace:~' },
      }),
    );
    const packages = new Map<string, PackageInfo>([
      ['@test/core', makePkg({ name: '@test/core', version: '2.0.0' })],
      ['@test/utils', makePkg({ name: '@test/utils', version: '3.1.0' })],
      ['@test/data', makePkg({ name: '@test/data', version: '0.5.0' })],
    ]);
    const manifest = generatePublishManifest(makePkg(), packages);
    const deps = manifest.dependencies as Record<string, string>;
    expect(deps['@test/core']).toBe('^2.0.0');
    expect(deps['@test/utils']).toBe('^3.1.0');
    expect(deps['@test/data']).toBe('~0.5.0');
  });

  it('resolves file: and link: deps to real versions', () => {
    fs.writeFileSync(
      path.join(TMP_DIR, 'package.json'),
      JSON.stringify({
        name: '@test/lib',
        version: '1.0.0',
        dependencies: { '@test/core': 'file:../core', '@test/utils': 'link:../utils', 'lodash': '^4.0.0' },
      }),
    );
    const packages = new Map<string, PackageInfo>([
      ['@test/core', makePkg({ name: '@test/core', version: '2.0.0' })],
      ['@test/utils', makePkg({ name: '@test/utils', version: '3.1.0' })],
    ]);
    const manifest = generatePublishManifest(makePkg(), packages);
    const deps = manifest.dependencies as Record<string, string>;
    expect(deps['@test/core']).toBe('^2.0.0');
    expect(deps['@test/utils']).toBe('^3.1.0');
    expect(deps['lodash']).toBe('^4.0.0');
  });

  it('removes file: deps when version cannot be resolved', () => {
    fs.writeFileSync(
      path.join(TMP_DIR, 'package.json'),
      JSON.stringify({
        name: '@test/lib',
        version: '1.0.0',
        dependencies: { '@test/unknown': 'file:../unknown', 'lodash': '^4.0.0' },
      }),
    );
    const manifest = generatePublishManifest(makePkg(), new Map());
    const deps = manifest.dependencies as Record<string, string>;
    expect(deps['@test/unknown']).toBeUndefined();
    expect(deps['lodash']).toBe('^4.0.0');
  });

  it('does not modify source package.json', () => {
    const original = JSON.stringify({
      name: '@test/lib',
      version: '1.0.0',
      dependencies: { '@scope/core': 'workspace:*' },
    });
    fs.writeFileSync(path.join(TMP_DIR, 'package.json'), original);
    generatePublishManifest(makePkg());
    const afterCall = fs.readFileSync(path.join(TMP_DIR, 'package.json'), 'utf-8');
    expect(afterCall).toBe(original);
  });
});

describe('generatePublishManifest exports preservation', () => {
  function writeSource(exports: unknown, main = './dist/index.js') {
    fs.writeFileSync(
      path.join(TMP_DIR, 'package.json'),
      JSON.stringify({ name: '@test/lib', version: '1.0.0', main, exports }),
    );
  }

  it('carries plain subpath exports through with the outDir stripped', () => {
    writeSource({
      '.': { types: './dist/index.d.ts', require: './dist/index.js' },
      './channels': {
        types: './dist/channels/index.d.ts',
        require: './dist/channels/index.js',
      },
      './channels/prose': {
        types: './dist/channels/prose.d.ts',
        require: './dist/channels/prose.js',
      },
    });
    const exports = generatePublishManifest(makePkg()).exports as Record<string, unknown>;

    expect(exports['./channels']).toEqual({
      types: './channels/index.d.ts',
      require: './channels/index.js',
    });
    expect(exports['./channels/prose']).toEqual({
      types: './channels/prose.d.ts',
      require: './channels/prose.js',
    });
  });

  it('keeps the wildcard intact and strips only the outDir prefix', () => {
    writeSource({
      '.': { require: './dist/index.js' },
      './styles/*': './styles/*',
      './chunks/*': './dist/chunks/*',
    });
    const exports = generatePublishManifest(makePkg()).exports as Record<string, unknown>;

    expect(exports['./styles/*']).toBe('./styles/*');
    expect(exports['./chunks/*']).toBe('./chunks/*');
  });

  it('passes ./package.json through unchanged', () => {
    writeSource({ '.': { require: './dist/index.js' }, './package.json': './package.json' });
    const exports = generatePublishManifest(makePkg()).exports as Record<string, unknown>;

    expect(exports['./package.json']).toBe('./package.json');
  });

  it('drops conditions pointing at an outDir that is not published', () => {
    writeSource({
      '.': { require: './dist/index.js' },
      './channels': {
        types: './dist/channels/index.d.ts',
        import: './dist-esm/channels/index.js',
        require: './dist/channels/index.js',
      },
    });
    const exports = generatePublishManifest(makePkg()).exports as Record<string, unknown>;

    expect(exports['./channels']).toEqual({
      types: './channels/index.d.ts',
      require: './channels/index.js',
    });
    expect(exports['./channels']).not.toHaveProperty('import');
  });

  it('drops a subpath entirely when no condition survives', () => {
    writeSource({
      '.': { require: './dist/index.js' },
      './esm-only': { import: './dist-esm/esm-only.js' },
    });
    const exports = generatePublishManifest(makePkg()).exports as Record<string, unknown>;

    expect(exports).not.toHaveProperty('./esm-only');
    expect(exports['.']).toBeDefined();
  });

  it('synthesizes "." from the entry point, overriding the source value', () => {
    writeSource({
      '.': { types: './dist/other.d.ts', require: './dist/other.js' },
      './sub': './dist/sub.js',
    });
    const exports = generatePublishManifest(makePkg()).exports as Record<string, unknown>;

    expect(exports['.']).toEqual({
      types: './index.d.ts',
      require: './index.js',
      default: './index.js',
    });
  });

  it('adds "." when the source exports map omits it', () => {
    writeSource({ './sub': './dist/sub.js' });
    const exports = generatePublishManifest(makePkg()).exports as Record<string, unknown>;

    expect(exports['.']).toEqual({
      types: './index.d.ts',
      require: './index.js',
      default: './index.js',
    });
    expect(exports['./sub']).toBe('./sub.js');
  });

  it('falls back to a "."-only map when the source declares no exports', () => {
    fs.writeFileSync(
      path.join(TMP_DIR, 'package.json'),
      JSON.stringify({ name: '@test/lib', version: '1.0.0', main: './dist/index.js' }),
    );
    const exports = generatePublishManifest(makePkg()).exports as Record<string, unknown>;

    expect(Object.keys(exports)).toEqual(['.']);
  });

  it('strips any dist prefix and drops nothing when main gives no outDir', () => {
    writeSource(
      { './a': './dist/a.js', './b': './dist-esm/b.js' },
      'index.js',
    );
    const exports = generatePublishManifest(makePkg()).exports as Record<string, unknown>;

    expect(exports['./a']).toBe('./a.js');
    expect(exports['./b']).toBe('./b.js');
  });
});

describe('writePublishManifest (real staging path)', () => {
  const STAGING_DIR = path.resolve(__dirname, '.sync-test-staging');

  beforeEach(() => {
    fs.mkdirSync(STAGING_DIR, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(STAGING_DIR, { recursive: true, force: true });
  });

  it('writes a staged package.json whose exports reach every staged subpath file', () => {
    fs.writeFileSync(
      path.join(TMP_DIR, 'package.json'),
      JSON.stringify({
        name: '@test/lib',
        version: '3.1.0',
        main: './dist/index.js',
        types: './dist/index.d.ts',
        type: 'module',
        scripts: { build: 'tsf build' },
        devDependencies: { vitest: '^1.0.0' },
        exports: {
          './package.json': './package.json',
          './styles/*': './styles/*',
          '.': {
            types: './dist/index.d.ts',
            import: './dist-esm/index.js',
            require: './dist/index.js',
          },
          './assertion-core': {
            types: './dist/assertion-core.d.ts',
            require: './dist/assertion-core.js',
          },
        },
      }),
    );

    // Stage the files the way an npm build leaves them: flat, outDir stripped.
    fs.writeFileSync(path.join(STAGING_DIR, 'index.js'), 'module.exports = {};');
    fs.writeFileSync(path.join(STAGING_DIR, 'index.d.ts'), 'export {};');
    fs.writeFileSync(path.join(STAGING_DIR, 'assertion-core.js'), 'module.exports = {};');
    fs.writeFileSync(path.join(STAGING_DIR, 'assertion-core.d.ts'), 'export {};');
    fs.mkdirSync(path.join(STAGING_DIR, 'styles'), { recursive: true });
    fs.writeFileSync(path.join(STAGING_DIR, 'styles', 'base.css'), 'body{}');

    writePublishManifest(makePkg(), undefined, STAGING_DIR);

    const staged = JSON.parse(
      fs.readFileSync(path.join(STAGING_DIR, 'package.json'), 'utf-8'),
    );

    // The defect in issue #1: this key was absent from the published manifest.
    expect(staged.exports['./assertion-core']).toEqual({
      types: './assertion-core.d.ts',
      require: './assertion-core.js',
    });
    expect(staged.exports['./styles/*']).toBe('./styles/*');
    expect(staged.exports['./package.json']).toBe('./package.json');
    expect(staged.exports['.'].import).toBeUndefined();

    // Every non-wildcard target the staged manifest names must exist in the tarball.
    for (const [key, value] of Object.entries(staged.exports)) {
      const targets = typeof value === 'string' ? [value] : Object.values(value as Record<string, string>);
      for (const target of targets) {
        if (target.includes('*')) continue;
        expect(
          fs.existsSync(path.join(STAGING_DIR, target)),
          `exports["${key}"] → ${target} missing from staging dir`,
        ).toBe(true);
      }
    }

    // Publish-manifest hygiene still holds on the file that actually ships.
    expect(staged.type).toBeUndefined();
    expect(staged.scripts).toBeUndefined();
    expect(staged.devDependencies).toBeUndefined();
  });
});
