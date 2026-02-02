import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';

const FIXTURE_DIR = path.resolve(__dirname, 'fixture');
const CLI = path.resolve(__dirname, '..', 'dist', 'cli', 'index.js');
const TEST_STAGING_DIR = path.join(os.tmpdir(), '.tsf-publish-test');

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

describe('integration: full build', () => {
  beforeAll(() => {
    // Ensure ts-forge is built
    execSync('pnpm build', { cwd: path.resolve(__dirname, '..'), stdio: 'pipe' });
    cleanFixtureOutput();
    // Build local targets
    execSync(`node ${CLI} build`, { cwd: FIXTURE_DIR, stdio: 'pipe' });
    // Build npm targets to staging
    execSync(`node ${CLI} build --npm`, {
      cwd: FIXTURE_DIR,
      stdio: 'pipe',
      env: { ...process.env, TSF_PUBLISH_DIR: TEST_STAGING_DIR },
    });
  }, 120000);

  afterAll(() => {
    if (fs.existsSync(TEST_STAGING_DIR)) fs.rmSync(TEST_STAGING_DIR, { recursive: true });
  });

  describe('local target (preserve imports)', () => {
    it('compiles core package', () => {
      const outDir = path.join(FIXTURE_DIR, 'packages/core/dist');
      expect(fs.existsSync(path.join(outDir, 'index.js'))).toBe(true);
      expect(fs.existsSync(path.join(outDir, 'index.d.ts'))).toBe(true);
    });

    it('compiles app package', () => {
      const outDir = path.join(FIXTURE_DIR, 'packages/app/dist');
      expect(fs.existsSync(path.join(outDir, 'index.js'))).toBe(true);
    });

    it('preserves workspace imports in local target', () => {
      const content = fs.readFileSync(
        path.join(FIXTURE_DIR, 'packages/app/dist/index.js'),
        'utf-8',
      );
      expect(content).toContain('@test/core');
      expect(content).not.toContain('../');
    });
  });

  describe('npm target (relative imports via --npm staging)', () => {
    it('compiles core and app to staging dir', () => {
      expect(fs.existsSync(path.join(TEST_STAGING_DIR, 'test/core/index.js'))).toBe(true);
      expect(fs.existsSync(path.join(TEST_STAGING_DIR, 'test/app/index.js'))).toBe(true);
    });

    it('rewrites workspace imports to relative paths', () => {
      const content = fs.readFileSync(
        path.join(TEST_STAGING_DIR, 'test/app/index.js'),
        'utf-8',
      );
      expect(content).not.toContain('@test/core');
    });

    it('generates clean package.json in staging', () => {
      const manifest = JSON.parse(
        fs.readFileSync(path.join(TEST_STAGING_DIR, 'test/core/package.json'), 'utf-8'),
      );
      expect(manifest.name).toBe('@test/core');
      expect(manifest.main).toBe('./index.js');
      // No workspace deps
      if (manifest.dependencies) {
        for (const v of Object.values(manifest.dependencies)) {
          expect(v).not.toMatch(/^workspace:/);
        }
      }
      expect(manifest.devDependencies).toBeUndefined();
    });

    it('does not write npm output to package tree', () => {
      expect(fs.existsSync(path.join(FIXTURE_DIR, 'packages/core/dist-npm'))).toBe(false);
      expect(fs.existsSync(path.join(FIXTURE_DIR, 'packages/app/dist-npm'))).toBe(false);
    });

    it('generates declaration files in staging', () => {
      expect(fs.existsSync(path.join(TEST_STAGING_DIR, 'test/app/index.d.ts'))).toBe(true);
      expect(fs.existsSync(path.join(TEST_STAGING_DIR, 'test/core/index.d.ts'))).toBe(true);
    });
  });

  describe('info command', () => {
    it('displays build plan without error', () => {
      const output = execSync(`node ${CLI} info`, { cwd: FIXTURE_DIR, encoding: 'utf-8' });
      expect(output).toContain('Build Plan');
      expect(output).toContain('@test/core');
      expect(output).toContain('@test/app');
      expect(output).toContain('Build Order');
    });
  });
});
