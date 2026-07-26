import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('child_process', () => ({
  execSync: vi.fn(),
}));

import { execSync } from 'child_process';
import { buildPublishCommand, checkNpmLogin, parsePackFilename } from '../src/cli/publish';

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
