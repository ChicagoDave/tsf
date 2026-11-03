/**
 * @fileoverview `tsf --version` reports the version from package.json
 * @module tsf/tests/cli-version
 *
 * Runs the built CLI (dist/cli/index.js) and asserts its output equals the
 * version field of the repo's package.json, so a bump can never leave the
 * binary reporting a stale hardcoded string.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

const ROOT = path.resolve(__dirname, '..');
const CLI = path.join(ROOT, 'dist', 'cli', 'index.js');

describe('tsf --version', () => {
  beforeAll(() => {
    execSync('pnpm build', { cwd: ROOT, stdio: 'pipe' });
  }, 120000);

  it('prints the version from package.json', () => {
    const expected = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8')).version;
    const printed = execSync(`node ${CLI} --version`, { cwd: ROOT, encoding: 'utf-8' }).trim();

    expect(printed).toBe(expected);
    expect(printed).not.toBe('0.1.0');
  });
});
