import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

const FIXTURE_DIR = path.resolve(__dirname, 'fixture');
const CLI = path.resolve(__dirname, '..', 'dist', 'cli', 'index.js');

function cleanFixtureOutput() {
  for (const pkg of ['core', 'app']) {
    for (const dir of ['dist', 'dist-npm']) {
      const p = path.join(FIXTURE_DIR, 'packages', pkg, dir);
      if (fs.existsSync(p)) fs.rmSync(p, { recursive: true });
    }
  }
}

describe('integration: full build', () => {
  beforeAll(() => {
    // Ensure ts-forge is built
    execSync('pnpm build', { cwd: path.resolve(__dirname, '..'), stdio: 'pipe' });
    cleanFixtureOutput();
    execSync(`node ${CLI} build --all`, { cwd: FIXTURE_DIR, stdio: 'pipe' });
  }, 30000);

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

  describe('npm target (relative imports)', () => {
    it('compiles core and app packages', () => {
      expect(fs.existsSync(path.join(FIXTURE_DIR, 'packages/core/dist-npm/index.js'))).toBe(true);
      expect(fs.existsSync(path.join(FIXTURE_DIR, 'packages/app/dist-npm/index.js'))).toBe(true);
    });

    it('rewrites workspace imports to relative paths', () => {
      const content = fs.readFileSync(
        path.join(FIXTURE_DIR, 'packages/app/dist-npm/index.js'),
        'utf-8',
      );
      expect(content).not.toContain('@test/core');
      expect(content).toContain('../../core/dist-npm/index.js');
    });

    it('output is flat (no nested packages/ directory)', () => {
      const outDir = path.join(FIXTURE_DIR, 'packages/app/dist-npm');
      expect(fs.existsSync(path.join(outDir, 'packages'))).toBe(false);
      expect(fs.existsSync(path.join(outDir, 'index.js'))).toBe(true);
    });

    it('generates declaration files', () => {
      expect(fs.existsSync(path.join(FIXTURE_DIR, 'packages/app/dist-npm/index.d.ts'))).toBe(true);
      expect(fs.existsSync(path.join(FIXTURE_DIR, 'packages/core/dist-npm/index.d.ts'))).toBe(true);
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
