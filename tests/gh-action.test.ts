import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { generateGitHubAction } from '../src/cli/gh-action';

const TMP_DIR = path.resolve(__dirname, '.gh-action-test-tmp');

beforeEach(() => {
  // Clean up from any previous run first
  try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch {}
  fs.mkdirSync(TMP_DIR, { recursive: true });
});

afterEach(() => {
  // Retry cleanup — on Windows/WSL, directories may briefly lock
  for (let i = 0; i < 3; i++) {
    try {
      fs.rmSync(TMP_DIR, { recursive: true, force: true });
      break;
    } catch {
      if (i < 2) {
        const wait = Date.now() + 100;
        while (Date.now() < wait) { /* spin */ }
      }
    }
  }
});

describe('generateGitHubAction', () => {
  it('creates workflow file', () => {
    fs.writeFileSync(
      path.join(TMP_DIR, 'package.json'),
      JSON.stringify({ name: 'test' }),
    );
    generateGitHubAction(TMP_DIR);
    const outPath = path.join(TMP_DIR, '.github', 'workflows', 'tsf.yml');
    expect(fs.existsSync(outPath)).toBe(true);
  });

  it('includes build and validate steps', () => {
    fs.writeFileSync(
      path.join(TMP_DIR, 'package.json'),
      JSON.stringify({ name: 'test' }),
    );
    generateGitHubAction(TMP_DIR);
    const content = fs.readFileSync(
      path.join(TMP_DIR, '.github', 'workflows', 'tsf.yml'),
      'utf-8',
    );
    expect(content).toContain('tsf build --all');
    expect(content).toContain('tsf validate');
    expect(content).toContain('tsf check');
  });

  it('detects pnpm and includes setup step', () => {
    fs.writeFileSync(
      path.join(TMP_DIR, 'package.json'),
      JSON.stringify({ name: 'test' }),
    );
    fs.writeFileSync(
      path.join(TMP_DIR, 'pnpm-workspace.yaml'),
      'packages:\n  - "packages/*"\n',
    );
    generateGitHubAction(TMP_DIR);
    const content = fs.readFileSync(
      path.join(TMP_DIR, '.github', 'workflows', 'tsf.yml'),
      'utf-8',
    );
    expect(content).toContain('pnpm/action-setup');
    expect(content).toContain('pnpm install --frozen-lockfile');
  });

  it('uses npm ci for non-workspace projects', () => {
    fs.writeFileSync(
      path.join(TMP_DIR, 'package.json'),
      JSON.stringify({ name: 'test' }),
    );
    generateGitHubAction(TMP_DIR);
    const content = fs.readFileSync(
      path.join(TMP_DIR, '.github', 'workflows', 'tsf.yml'),
      'utf-8',
    );
    expect(content).toContain('npm ci');
  });

  it('does not overwrite existing workflow', () => {
    const outDir = path.join(TMP_DIR, '.github', 'workflows');
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'tsf.yml'), 'existing');

    generateGitHubAction(TMP_DIR);
    const content = fs.readFileSync(path.join(outDir, 'tsf.yml'), 'utf-8');
    expect(content).toBe('existing');
  });
});
