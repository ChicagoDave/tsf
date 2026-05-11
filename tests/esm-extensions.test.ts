/**
 * @fileoverview Unit tests for `transformEsmExtensions`.
 *
 * These tests build minimal `outDir` trees in a temp directory, write
 * representative import patterns into a JS file, run the transformer,
 * and assert on the resulting file contents. The transformer is
 * exercised directly (no CLI / orchestrator involvement) so each test
 * isolates one rewrite rule.
 *
 * Behavior coverage:
 * - DOES — appends `.js` for `./foo` when `./foo.js` exists
 * - DOES — appends `/index.js` for `./foo` when `./foo/index.js` exists
 * - DOES — handles `import from`, `export from`, side-effect `import`, dynamic `import()`
 * - REJECTS (no-op) — already-extensioned specifiers
 * - REJECTS (no-op) — bare specifiers (`@scope/pkg`, `lodash`, `node:fs`)
 * - REJECTS (no-op) — unresolvable relative specifiers (left alone, not broken)
 * - DOES — idempotent (second run on the same file changes nothing)
 * - REJECTS — gated by `esmExtensions === true`
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { transformEsmExtensions } from '../src/transform/imports';
import type { PackageInfo, ResolvedTarget } from '../src/types';

interface TestEnv {
  pkgDir: string;
  outDir: string;
  pkg: PackageInfo;
  target: ResolvedTarget;
}

function setupEnv(options: { esmExtensions?: boolean } = {}): TestEnv {
  const pkgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsf-esm-ext-'));
  const outDir = path.join(pkgDir, 'dist-esm');
  fs.mkdirSync(outDir, { recursive: true });
  const pkg: PackageInfo = {
    name: '@scope/pkg',
    path: pkgDir,
    tsconfig: path.join(pkgDir, 'tsconfig.json'),
    dependencies: [],
    entryPoint: 'src/index.ts',
  };
  const target: ResolvedTarget = {
    name: 'esm',
    config: {
      module: 'es2022',
      outDir: 'dist-esm',
      imports: 'preserve',
      esmExtensions: options.esmExtensions ?? true,
    },
  };
  return { pkgDir, outDir, pkg, target };
}

function tearDown(env: TestEnv): void {
  fs.rmSync(env.pkgDir, { recursive: true, force: true });
}

function write(env: TestEnv, relPath: string, content: string): string {
  const abs = path.join(env.outDir, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf-8');
  return abs;
}

function read(env: TestEnv, relPath: string): string {
  return fs.readFileSync(path.join(env.outDir, relPath), 'utf-8');
}

describe('transformEsmExtensions — file-target rewrites', () => {
  let env: TestEnv;
  beforeEach(() => {
    env = setupEnv();
  });
  afterEach(() => tearDown(env));

  it('appends .js when the relative target is an emitted file', () => {
    write(env, 'foo.js', '/* foo */');
    write(env, 'index.js', `export { x } from './foo';\n`);

    transformEsmExtensions(env.pkg, env.target);

    expect(read(env, 'index.js')).toBe(`export { x } from "./foo.js";\n`);
  });

  it('handles multi-line `export { ... } from "..."` declarations', () => {
    write(env, 'standard.js', '');
    write(
      env,
      'index.js',
      `export {\n  A,\n  B,\n  C,\n} from './standard';\n`,
    );

    transformEsmExtensions(env.pkg, env.target);

    expect(read(env, 'index.js')).toContain(`from "./standard.js"`);
  });

  it('handles `import from` and `export from` together', () => {
    write(env, 'foo.js', '');
    write(env, 'bar.js', '');
    write(
      env,
      'index.js',
      `import { a } from './foo';\nexport * from './bar';\n`,
    );

    transformEsmExtensions(env.pkg, env.target);

    const content = read(env, 'index.js');
    expect(content).toContain(`from "./foo.js"`);
    expect(content).toContain(`from "./bar.js"`);
  });

  it('rewrites side-effect `import "./x"`', () => {
    write(env, 'effects.js', '');
    write(env, 'index.js', `import './effects';\n`);

    transformEsmExtensions(env.pkg, env.target);

    expect(read(env, 'index.js')).toContain(`import "./effects.js"`);
  });

  it('rewrites dynamic `import("./x")`', () => {
    write(env, 'lazy.js', '');
    write(env, 'index.js', `const m = await import("./lazy");\n`);

    transformEsmExtensions(env.pkg, env.target);

    expect(read(env, 'index.js')).toContain(`import("./lazy.js")`);
  });
});

describe('transformEsmExtensions — directory-target rewrites', () => {
  let env: TestEnv;
  beforeEach(() => {
    env = setupEnv();
  });
  afterEach(() => tearDown(env));

  it('appends /index.js when the relative target is a directory with index.js', () => {
    write(env, 'audio/index.js', '/* audio barrel */');
    write(env, 'index.js', `export * from './audio';\n`);

    transformEsmExtensions(env.pkg, env.target);

    expect(read(env, 'index.js')).toContain(`from "./audio/index.js"`);
  });

  it('preserves a trailing slash on the specifier when expanding to index.js', () => {
    write(env, 'audio/index.js', '');
    write(env, 'index.js', `export * from './audio/';\n`);

    transformEsmExtensions(env.pkg, env.target);

    // No double slash — `./audio/` already ends with `/`, so we add
    // only `index.js`.
    expect(read(env, 'index.js')).toContain(`from "./audio/index.js"`);
  });

  it('walks `../` paths to a sibling directory with index.js', () => {
    write(env, 'sub/audio/index.js', '');
    write(env, 'sub/peer.js', '');
    write(env, 'sub/inner.js', `import { x } from '../sub/audio';\n`);

    transformEsmExtensions(env.pkg, env.target);

    expect(read(env, 'sub/inner.js')).toContain(`from "../sub/audio/index.js"`);
  });
});

describe('transformEsmExtensions — no-op cases', () => {
  let env: TestEnv;
  beforeEach(() => {
    env = setupEnv();
  });
  afterEach(() => tearDown(env));

  it('leaves an already-extensioned `.js` specifier alone', () => {
    write(env, 'foo.js', '');
    const original = `import { x } from './foo.js';\n`;
    write(env, 'index.js', original);

    transformEsmExtensions(env.pkg, env.target);

    expect(read(env, 'index.js')).toBe(original);
  });

  it('leaves a `.json` specifier alone', () => {
    write(env, 'data.json', '{}');
    const original = `import data from './data.json';\n`;
    write(env, 'index.js', original);

    transformEsmExtensions(env.pkg, env.target);

    expect(read(env, 'index.js')).toBe(original);
  });

  it('leaves bare specifiers (`lodash`, `@scope/pkg`, `node:fs`) alone', () => {
    const original =
      `import _ from 'lodash';\n` +
      `import { x } from '@scope/other';\n` +
      `import * as fs from 'node:fs';\n`;
    write(env, 'index.js', original);

    transformEsmExtensions(env.pkg, env.target);

    expect(read(env, 'index.js')).toBe(original);
  });

  it('leaves unresolvable relative specifiers alone (does not break broken imports)', () => {
    // Note: no `./missing.js` and no `./missing/index.js` exist.
    const original = `export * from './missing';\n`;
    write(env, 'index.js', original);

    transformEsmExtensions(env.pkg, env.target);

    expect(read(env, 'index.js')).toBe(original);
  });

  it('is idempotent — second run on the same output changes nothing', () => {
    write(env, 'foo.js', '');
    write(env, 'index.js', `export { x } from './foo';\n`);

    transformEsmExtensions(env.pkg, env.target);
    const afterFirst = read(env, 'index.js');
    transformEsmExtensions(env.pkg, env.target);
    const afterSecond = read(env, 'index.js');

    expect(afterSecond).toBe(afterFirst);
    expect(afterSecond).toContain(`from "./foo.js"`);
  });

  it('does nothing when `esmExtensions` is false', () => {
    env = setupEnv({ esmExtensions: false });
    write(env, 'foo.js', '');
    const original = `export { x } from './foo';\n`;
    write(env, 'index.js', original);

    transformEsmExtensions(env.pkg, env.target);

    expect(read(env, 'index.js')).toBe(original);
  });

  it('does nothing when the outDir does not exist', () => {
    fs.rmSync(env.outDir, { recursive: true, force: true });
    // Should not throw.
    expect(() => transformEsmExtensions(env.pkg, env.target)).not.toThrow();
  });
});
