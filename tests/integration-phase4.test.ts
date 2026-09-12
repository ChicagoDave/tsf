import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';

const FIXTURE_DIR = path.resolve(__dirname, 'fixture');
const CLI = path.resolve(__dirname, '..', 'dist', 'cli', 'index.js');
const TEST_STAGING_DIR = path.join(os.tmpdir(), '.tsf-publish-phase4-test');

const CORE_PKG_PATH = path.join(FIXTURE_DIR, 'packages/core/package.json');
const APP_PKG_PATH = path.join(FIXTURE_DIR, 'packages/app/package.json');

let originalCorePkg: string;
let originalAppPkg: string;

function cleanFixtureOutput() {
  for (const pkg of ['core', 'app']) {
    for (const dir of ['dist', 'dist-npm']) {
      const p = path.join(FIXTURE_DIR, 'packages', pkg, dir);
      if (fs.existsSync(p)) fs.rmSync(p, { recursive: true });
    }
  }
  if (fs.existsSync(TEST_STAGING_DIR)) fs.rmSync(TEST_STAGING_DIR, { recursive: true });
  const cacheDir = path.join(FIXTURE_DIR, '.tsf-cache');
  try { if (fs.existsSync(cacheDir)) fs.rmSync(cacheDir, { recursive: true, force: true }); } catch {}
}

function cli(command: string, extraEnv?: Record<string, string>): string {
  return execSync(`node ${CLI} ${command}`, {
    cwd: FIXTURE_DIR,
    encoding: 'utf-8',
    stdio: 'pipe',
    env: { ...process.env, ...extraEnv },
  });
}

function cliExitCode(command: string): number {
  try {
    execSync(`node ${CLI} ${command}`, {
      cwd: FIXTURE_DIR,
      encoding: 'utf-8',
      stdio: 'pipe',
    });
    return 0;
  } catch (e: any) {
    return e.status ?? 1;
  }
}

function cliResult(
  command: string,
  extraEnv?: Record<string, string>,
): { code: number; stdout: string; stderr: string } {
  try {
    const stdout = execSync(`node ${CLI} ${command}`, {
      cwd: FIXTURE_DIR,
      encoding: 'utf-8',
      stdio: 'pipe',
      env: { ...process.env, ...extraEnv },
    });
    return { code: 0, stdout, stderr: '' };
  } catch (e: any) {
    return {
      code: e.status ?? 1,
      stdout: e.stdout?.toString() ?? '',
      stderr: e.stderr?.toString() ?? '',
    };
  }
}

describe('integration: Phase 4 ecosystem', () => {
  beforeAll(() => {
    // Save original package.json files
    originalCorePkg = fs.readFileSync(CORE_PKG_PATH, 'utf-8');
    originalAppPkg = fs.readFileSync(APP_PKG_PATH, 'utf-8');

    // Build fresh (local targets only)
    execSync('pnpm build', { cwd: path.resolve(__dirname, '..'), stdio: 'pipe' });
    cleanFixtureOutput();
    cli('build');
  }, 120000);

  afterAll(() => {
    // Restore original package.json files
    fs.writeFileSync(CORE_PKG_PATH, originalCorePkg);
    fs.writeFileSync(APP_PKG_PATH, originalAppPkg);
    if (fs.existsSync(TEST_STAGING_DIR)) fs.rmSync(TEST_STAGING_DIR, { recursive: true });
  });

  describe('sync: package.json field generation', () => {
    beforeAll(() => {
      // Restore originals before sync test
      fs.writeFileSync(CORE_PKG_PATH, originalCorePkg);
      fs.writeFileSync(APP_PKG_PATH, originalAppPkg);
      cli('sync');
    });

    it('adds main field to package.json', () => {
      const pkg = JSON.parse(fs.readFileSync(CORE_PKG_PATH, 'utf-8'));
      expect(pkg.main).toBeDefined();
      expect(pkg.main).toContain('index.js');
    });

    it('adds types field to package.json', () => {
      const pkg = JSON.parse(fs.readFileSync(CORE_PKG_PATH, 'utf-8'));
      expect(pkg.types).toBeDefined();
      expect(pkg.types).toContain('.d.ts');
    });

    it('preserves existing fields', () => {
      const pkg = JSON.parse(fs.readFileSync(APP_PKG_PATH, 'utf-8'));
      expect(pkg.name).toBe('@test/app');
      expect(pkg.version).toBe('1.0.0');
      expect(pkg.dependencies).toEqual({ '@test/core': '1.0.0' });
    });

    it('adds exports field', () => {
      const pkg = JSON.parse(fs.readFileSync(CORE_PKG_PATH, 'utf-8'));
      expect(pkg.exports).toBeDefined();
    });
  });

  describe('validate: successful build', () => {
    it('passes validation after a clean build', () => {
      const code = cliExitCode('validate');
      expect(code).toBe(0);
    });
  });

  describe('validate: detects missing files', () => {
    it('fails when a declared entry point is missing', { timeout: 15000 }, () => {
      const distFile = path.join(FIXTURE_DIR, 'packages/core/dist/index.js');
      const backup = fs.readFileSync(distFile);
      fs.unlinkSync(distFile);

      try {
        const code = cliExitCode('validate');
        expect(code).toBe(1);
      } finally {
        fs.writeFileSync(distFile, backup);
      }
    });
  });

  describe('full pipeline: build + build --npm + sync → validate', () => {
    beforeAll(() => {
      // Restore originals, clean, run full pipeline
      fs.writeFileSync(CORE_PKG_PATH, originalCorePkg);
      fs.writeFileSync(APP_PKG_PATH, originalAppPkg);
      cleanFixtureOutput();
      cli('build --sync-package-json');
      cli('build --npm', { TSF_PUBLISH_DIR: TEST_STAGING_DIR });
    }, 120000);

    it('builds local outputs', () => {
      expect(fs.existsSync(path.join(FIXTURE_DIR, 'packages/core/dist/index.js'))).toBe(true);
      expect(fs.existsSync(path.join(FIXTURE_DIR, 'packages/app/dist/index.js'))).toBe(true);
    });

    it('builds npm outputs to staging', () => {
      expect(fs.existsSync(path.join(TEST_STAGING_DIR, 'test/core/index.js'))).toBe(true);
      expect(fs.existsSync(path.join(TEST_STAGING_DIR, 'test/app/index.js'))).toBe(true);
    });

    it('does not write npm output to package tree', () => {
      expect(fs.existsSync(path.join(FIXTURE_DIR, 'packages/core/dist-npm'))).toBe(false);
      expect(fs.existsSync(path.join(FIXTURE_DIR, 'packages/app/dist-npm'))).toBe(false);
    });

    it('syncs package.json fields', () => {
      const pkg = JSON.parse(fs.readFileSync(CORE_PKG_PATH, 'utf-8'));
      expect(pkg.main).toBeDefined();
      expect(pkg.types).toBeDefined();
    });

    it('passes validation', () => {
      const code = cliExitCode('validate');
      expect(code).toBe(0);
    });
  });
  describe('publish gate: staged manifest must reach every file it names', () => {
    beforeAll(() => {
      fs.writeFileSync(CORE_PKG_PATH, originalCorePkg);
      fs.writeFileSync(APP_PKG_PATH, originalAppPkg);
      cleanFixtureOutput();
      cli('build --npm', { TSF_PUBLISH_DIR: TEST_STAGING_DIR });
    }, 120000);

    it('publishes nothing and exits 1 when a staged entry point is absent from the tarball', () => {
      const coreStagingDir = path.join(TEST_STAGING_DIR, 'test/core');
      const stagedEntry = path.join(coreStagingDir, 'index.js');
      const backup = fs.readFileSync(stagedEntry);
      fs.unlinkSync(stagedEntry);

      try {
        const result = cliResult('publish --dry-run --filter @test/core', {
          TSF_PUBLISH_DIR: TEST_STAGING_DIR,
        });

        expect(result.code).toBe(1);
        expect(result.stderr).toContain('Staged manifests are not publishable');
        expect(result.stderr).toContain('"main" points to "./index.js" which does not exist');
        // The gate fires before npm pack, so no tarball is left in staging.
        expect(fs.readdirSync(coreStagingDir).filter((f) => f.endsWith('.tgz'))).toEqual([]);
      } finally {
        fs.writeFileSync(stagedEntry, backup);
      }
    });

    it('clears the gate when every staged target exists', () => {
      const result = cliResult('publish --dry-run --filter @test/core', {
        TSF_PUBLISH_DIR: TEST_STAGING_DIR,
      });

      expect(result.stderr).not.toContain('Staged manifests are not publishable');
      // Reaching the packing step is the observable proof the gate cleared; it is
      // logged before `npm pack` runs, so this holds with or without a registry.
      expect(result.stdout).toContain('Packing @test/core');
    });
  });
});
