import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

vi.mock('child_process', () => ({
  execSync: vi.fn(),
}));

import { execSync } from 'child_process';
import {
  buildPublishCommand,
  checkNpmLogin,
  parsePackFilename,
  validateStagedManifests,
} from '../src/cli/publish';

const execSyncMock = vi.mocked(execSync);

describe('buildPublishCommand', () => {
  it('publishes with public access and the given tag, using only npm-recognized flags', () => {
    const cmd = buildPublishCommand('/staging/pkg/pkg-1.0.0.tgz', 'latest', false);
    expect(cmd).toBe('npm publish /staging/pkg/pkg-1.0.0.tgz --access public --tag latest');
    expect(cmd).not.toContain('--no-git-checks');
  });

  it('appends --dry-run for dry runs', () => {
    const cmd = buildPublishCommand('/staging/pkg/pkg-1.0.0.tgz', 'beta', true);
    expect(cmd).toBe('npm publish /staging/pkg/pkg-1.0.0.tgz --access public --tag beta --dry-run');
  });
});

describe('parsePackFilename', () => {
  it('reads the npm <= 11 array shape', () => {
    expect(parsePackFilename([{ filename: 'scope-pkg-1.0.0.tgz' }])).toBe('scope-pkg-1.0.0.tgz');
  });

  it('reads the npm 12 object-keyed-by-package-name shape', () => {
    expect(
      parsePackFilename({ '@scope/pkg': { id: '@scope/pkg@1.0.0', filename: 'scope-pkg-1.0.0.tgz' } }),
    ).toBe('scope-pkg-1.0.0.tgz');
  });

  it('reads a bare result object with a filename field', () => {
    expect(parsePackFilename({ filename: 'scope-pkg-1.0.0.tgz' })).toBe('scope-pkg-1.0.0.tgz');
  });

  it('throws when no filename is present in any recognized shape', () => {
    expect(() => parsePackFilename([])).toThrow(/tarball filename/);
    expect(() => parsePackFilename({ '@scope/pkg': { id: 'x' } })).toThrow(/tarball filename/);
    expect(() => parsePackFilename(null)).toThrow(/tarball filename/);
  });
});

describe('checkNpmLogin', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    execSyncMock.mockReset();
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called');
    }) as never);
  });

  afterEach(() => {
    exitSpy.mockRestore();
  });

  it('skips the whoami check entirely for dry runs', () => {
    checkNpmLogin(true, {});
    expect(execSyncMock).not.toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('skips the whoami check when OIDC credentials are available', () => {
    checkNpmLogin(false, { ACTIONS_ID_TOKEN_REQUEST_URL: 'https://token.actions.githubusercontent.com/req' });
    expect(execSyncMock).not.toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('runs npm whoami and proceeds when logged in', () => {
    execSyncMock.mockReturnValue(Buffer.from('davidcornelson\n'));
    checkNpmLogin(false, {});
    expect(execSyncMock).toHaveBeenCalledWith('npm whoami', { stdio: 'pipe' });
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('exits with code 1 when not logged in and no OIDC credentials exist', () => {
    execSyncMock.mockImplementation(() => {
      throw new Error('not logged in');
    });
    expect(() => checkNpmLogin(false, {})).toThrow('process.exit called');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('still enforces the login gate when the OIDC env var is set but empty', () => {
    execSyncMock.mockImplementation(() => {
      throw new Error('not logged in');
    });
    expect(() => checkNpmLogin(false, { ACTIONS_ID_TOKEN_REQUEST_URL: '' })).toThrow('process.exit called');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

describe('validateStagedManifests', () => {
  const STAGING_ROOT = path.resolve(__dirname, '.publish-test-staging');
  const PKG_STAGING_DIR = path.join(STAGING_ROOT, 'test/lib');

  /** Writes a staged manifest plus the given staged files, the way an npm build leaves them. */
  function stage(manifest: Record<string, unknown>, files: string[] = []): void {
    fs.mkdirSync(PKG_STAGING_DIR, { recursive: true });
    for (const file of files) {
      const full = path.join(PKG_STAGING_DIR, file);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, '');
    }
    fs.writeFileSync(
      path.join(PKG_STAGING_DIR, 'package.json'),
      JSON.stringify(manifest, null, 2),
    );
  }

  beforeEach(() => {
    fs.rmSync(STAGING_ROOT, { recursive: true, force: true });
  });

  afterEach(() => {
    fs.rmSync(STAGING_ROOT, { recursive: true, force: true });
  });

  it('reports an exports subpath whose target is absent from the staging directory', () => {
    stage(
      {
        name: '@test/lib',
        main: './index.js',
        types: './index.d.ts',
        exports: {
          '.': { types: './index.d.ts', require: './index.js', default: './index.js' },
          './assertion-core': { types: './assertion-core.d.ts', require: './assertion-core.js' },
        },
      },
      ['index.js', 'index.d.ts'],
    );

    const problems = validateStagedManifests(['@test/lib'], STAGING_ROOT);

    expect(problems.map((p) => p.message)).toEqual([
      'exports["./assertion-core"].types points to "./assertion-core.d.ts" which does not exist in the staging directory',
      'exports["./assertion-core"].require points to "./assertion-core.js" which does not exist in the staging directory',
    ]);
    expect(problems[0].pkg).toBe('@test/lib');
    expect(problems[0].fix).toContain('tsf build --npm');
  });

  it('accepts a wildcard target backed by at least one staged file', () => {
    stage(
      {
        name: '@test/lib',
        main: './index.js',
        types: './index.d.ts',
        exports: { '.': './index.js', './styles/*': './styles/*' },
      },
      ['index.js', 'index.d.ts', 'styles/base.css'],
    );

    expect(validateStagedManifests(['@test/lib'], STAGING_ROOT)).toEqual([]);
  });

  it('reports a wildcard target with no staged file behind it', () => {
    stage(
      { name: '@test/lib', main: './index.js', exports: { './styles/*': './styles/*' } },
      ['index.js'],
    );

    const problems = validateStagedManifests(['@test/lib'], STAGING_ROOT);
    expect(problems).toHaveLength(1);
    expect(problems[0].message).toContain('exports["./styles/*"]');
  });

  it('accepts the ./package.json passthrough export', () => {
    stage(
      { name: '@test/lib', main: './index.js', exports: { './package.json': './package.json' } },
      ['index.js'],
    );

    expect(validateStagedManifests(['@test/lib'], STAGING_ROOT)).toEqual([]);
  });

  it('reports missing main, types, module and bin targets', () => {
    stage({
      name: '@test/lib',
      main: './index.js',
      types: './index.d.ts',
      module: './index.mjs',
      bin: { lib: './cli/index.js' },
    });

    const problems = validateStagedManifests(['@test/lib'], STAGING_ROOT);
    expect(problems.map((p) => p.message)).toEqual([
      '"main" points to "./index.js" which does not exist in the staging directory',
      '"types" points to "./index.d.ts" which does not exist in the staging directory',
      '"module" points to "./index.mjs" which does not exist in the staging directory',
      'bin "lib" points to "./cli/index.js" which does not exist in the staging directory',
    ]);
  });

  it('still reports unresolved workspace: protocols in staged dependencies', () => {
    stage(
      {
        name: '@test/lib',
        main: './index.js',
        dependencies: { '@test/core': 'workspace:*', lodash: '^4.0.0' },
        peerDependencies: { '@test/peer': 'workspace:^' },
      },
      ['index.js'],
    );

    const problems = validateStagedManifests(['@test/lib'], STAGING_ROOT);
    expect(problems.map((p) => p.message)).toEqual([
      'dependencies.@test/core: workspace:*',
      'peerDependencies.@test/peer: workspace:^',
    ]);
    expect(problems[0].fix).toContain('version ranges');
  });

  it('returns no problems for a fully staged manifest', () => {
    stage(
      {
        name: '@test/lib',
        version: '1.0.0',
        main: './index.js',
        types: './index.d.ts',
        dependencies: { '@test/core': '^1.0.0' },
        exports: {
          '.': { types: './index.d.ts', require: './index.js', default: './index.js' },
          './assertion-core': { types: './assertion-core.d.ts', require: './assertion-core.js' },
          './package.json': './package.json',
        },
        bin: { lib: './cli/index.js' },
      },
      ['index.js', 'index.d.ts', 'assertion-core.js', 'assertion-core.d.ts', 'cli/index.js'],
    );

    expect(validateStagedManifests(['@test/lib'], STAGING_ROOT)).toEqual([]);
  });

  it('skips packages that have no staged manifest', () => {
    fs.mkdirSync(STAGING_ROOT, { recursive: true });
    expect(validateStagedManifests(['@test/lib'], STAGING_ROOT)).toEqual([]);
  });
});
