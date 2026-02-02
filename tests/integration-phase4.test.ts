import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

const FIXTURE_DIR = path.resolve(__dirname, 'fixture');
const CLI = path.resolve(__dirname, '..', 'dist', 'cli', 'index.js');

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
}

function cli(command: string): string {
  return execSync(`node ${CLI} ${command}`, {
    cwd: FIXTURE_DIR,
    encoding: 'utf-8',
    stdio: 'pipe',
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

describe('integration: Phase 4 ecosystem', () => {
  beforeAll(() => {
    // Save original package.json files
    originalCorePkg = fs.readFileSync(CORE_PKG_PATH, 'utf-8');
    originalAppPkg = fs.readFileSync(APP_PKG_PATH, 'utf-8');

    // Build fresh
    execSync('pnpm build', { cwd: path.resolve(__dirname, '..'), stdio: 'pipe' });
    cleanFixtureOutput();
    cli('build --all');
  }, 120000);

  afterAll(() => {
    // Restore original package.json files
    fs.writeFileSync(CORE_PKG_PATH, originalCorePkg);
    fs.writeFileSync(APP_PKG_PATH, originalAppPkg);
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
    it('fails when a declared entry point is missing', () => {
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

  describe('validate: workspace specifier leaks', () => {
    it('warns on injected workspace specifier in npm output', () => {
      const npmFile = path.join(FIXTURE_DIR, 'packages/app/dist-npm/index.js');
      const original = fs.readFileSync(npmFile, 'utf-8');
      fs.writeFileSync(npmFile, original + '\nconst x = require("@test/core");\n');

      try {
        // Workspace specifier leaks are warnings (not errors), so exit code is 0
        const code = cliExitCode('validate');
        expect(code).toBe(0);
      } finally {
        fs.writeFileSync(npmFile, original);
      }
    });
  });

  describe('full pipeline: build --sync-package-json → validate', () => {
    beforeAll(() => {
      // Restore originals, clean, run full pipeline
      fs.writeFileSync(CORE_PKG_PATH, originalCorePkg);
      fs.writeFileSync(APP_PKG_PATH, originalAppPkg);
      cleanFixtureOutput();
      cli('build --all --sync-package-json');
    }, 120000);

    it('builds all outputs', () => {
      expect(fs.existsSync(path.join(FIXTURE_DIR, 'packages/core/dist/index.js'))).toBe(true);
      expect(fs.existsSync(path.join(FIXTURE_DIR, 'packages/core/dist-npm/index.js'))).toBe(true);
      expect(fs.existsSync(path.join(FIXTURE_DIR, 'packages/app/dist/index.js'))).toBe(true);
      expect(fs.existsSync(path.join(FIXTURE_DIR, 'packages/app/dist-npm/index.js'))).toBe(true);
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
});
