/**
 * @fileoverview TypeScript 6.0 compatibility tests for the tsc adapter
 * @module tsf/tests/ts6-compat
 *
 * Real-path tests: each case writes a small workspace whose tsconfigs are
 * valid on TypeScript 5.9 and 6.0 alike and carry no deprecated option of their
 * own (nodenext resolution, no baseUrl, explicit types), drives `compile()` from
 * src/compilers/tsc.ts against it with no stubs, and asserts on the files tsc
 * actually emitted and on the diagnostics it returned.
 *
 * Cases marked `expectRedOnTs6` fail today under TypeScript 6.x because TSF
 * itself injects a deprecated option (`baseUrl`, or `moduleResolution node10`);
 * under 5.x the same cases pass. Each maps to a row in
 * docs/work/typescript-6-compat/findings.md (B3, B4). Phase 2 of the plan
 * flips them to plain `it` once the adapter no longer injects those options.
 */

import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';
import { compile } from '../src/compilers/tsc';
import type { PackageInfo, ResolvedTarget } from '../src/types';

const TMP = path.resolve(__dirname, '.ts6-compat-tmp');
const TS6 = Number(ts.versionMajorMinor.split('.')[0]) >= 6;

/** Under 6.x the case is expected red until Phase 2; under 5.x it must pass. */
const expectRedOnTs6 = TS6 ? it.fails : it;

const DEPRECATION = /deprecated/i;

interface TsconfigJson {
  compilerOptions: Record<string, unknown>;
  include: string[];
}

/**
 * A tsconfig valid on 5.9 and 6.0 that emits CommonJS (no "type": "module" in
 * package.json) and carries no deprecated option. `bundler` + `commonjs` is
 * not an option here: 6.0 allows it, 5.x rejects it (TS5095).
 */
const CLEAN_TSCONFIG: TsconfigJson = {
  compilerOptions: {
    target: 'ES2022',
    module: 'nodenext',
    moduleResolution: 'nodenext',
    rootDir: 'src',
    outDir: 'dist',
    declaration: true,
    strict: true,
    skipLibCheck: true,
    types: [],
  },
  include: ['src/**/*'],
};

/** A bundler-resolution tsconfig, valid on both versions, used to provoke the node10 downgrade. */
const BUNDLER_TSCONFIG: TsconfigJson = {
  compilerOptions: { ...CLEAN_TSCONFIG.compilerOptions, module: 'esnext', moduleResolution: 'bundler' },
  include: ['src/**/*'],
};

interface Workspace {
  root: string;
  packages: Map<string, PackageInfo>;
  core: PackageInfo;
  app: PackageInfo;
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

/**
 * Writes a two-package workspace (core, app → core) under TMP.
 * Per-package tsconfig overrides let a case model a legacy user or a bundler setup.
 */
function makeWorkspace(
  appTsconfig: TsconfigJson = CLEAN_TSCONFIG,
  coreTsconfig: TsconfigJson = CLEAN_TSCONFIG,
): Workspace {
  fs.rmSync(TMP, { recursive: true, force: true });
  const root = TMP;
  const corePath = path.join(root, 'packages', 'core');
  const appPath = path.join(root, 'packages', 'app');

  writeJson(path.join(corePath, 'package.json'), { name: '@test/core', version: '1.0.0', main: 'dist/index.js' });
  writeJson(path.join(corePath, 'tsconfig.json'), coreTsconfig);
  fs.mkdirSync(path.join(corePath, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(corePath, 'src', 'index.ts'),
    'export const greet = (name: string): string => `hi ${name}`;\n',
  );

  writeJson(path.join(appPath, 'package.json'), {
    name: '@test/app',
    version: '1.0.0',
    main: 'dist/index.js',
    dependencies: { '@test/core': '1.0.0' },
  });
  writeJson(path.join(appPath, 'tsconfig.json'), appTsconfig);
  fs.mkdirSync(path.join(appPath, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(appPath, 'src', 'index.ts'),
    "import { greet } from '@test/core';\nexport const run = (): string => greet('tsf');\n",
  );

  const core: PackageInfo = {
    name: '@test/core',
    path: corePath,
    tsconfig: path.join(corePath, 'tsconfig.json'),
    dependencies: [],
    entryPoint: 'src/index.ts',
  };
  const app: PackageInfo = {
    name: '@test/app',
    path: appPath,
    tsconfig: path.join(appPath, 'tsconfig.json'),
    dependencies: ['@test/core'],
    entryPoint: 'src/index.ts',
  };
  const packages = new Map<string, PackageInfo>([
    [core.name, core],
    [app.name, app],
  ]);
  return { root, packages, core, app };
}

function localTarget(extra: Partial<ResolvedTarget['config']> = {}): ResolvedTarget {
  return { name: 'local', config: { imports: 'preserve', outDir: 'dist', declarations: true, ...extra } };
}

/** The shape the orchestrator hands compile() for `tsf build --npm`. */
function npmTarget(stagingDir: string, pkg: PackageInfo): ResolvedTarget {
  return {
    name: 'npm',
    config: {
      imports: 'preserve',
      publishImports: 'relative',
      outDir: path.join(stagingDir, pkg.name.replace(/^@/, '')),
      declarations: true,
    },
  };
}

function deprecations(diagnostics: string[]): string[] {
  return diagnostics.filter((d) => DEPRECATION.test(d));
}

describe('ts6-compat: tsc adapter under TypeScript ' + ts.version, () => {
  let ws: Workspace;

  beforeEach(() => {
    ws = makeWorkspace();
  });

  afterAll(() => {
    fs.rmSync(TMP, { recursive: true, force: true });
  });

  it('compiles a package with no workspace deps and no injected options cleanly', () => {
    const result = compile(ws.core, localTarget(), ws.root, ws.packages);

    expect(result.diagnostics).toEqual([]);
    expect(result.success).toBe(true);
    const out = path.join(ws.core.path, 'dist', 'index.js');
    expect(fs.existsSync(out)).toBe(true);
    expect(fs.readFileSync(out, 'utf-8')).toContain('exports.greet');
    expect(fs.existsSync(path.join(ws.core.path, 'dist', 'index.d.ts'))).toBe(true);
  });

  // Findings B3 — injected baseUrl, local (preserve) build with workspace paths.
  expectRedOnTs6('local build of a dependent package injects no deprecated option', () => {
    compile(ws.core, localTarget(), ws.root, ws.packages);
    const result = compile(ws.app, localTarget(), ws.root, ws.packages);

    expect(deprecations(result.diagnostics)).toEqual([]);
    expect(result.success).toBe(true);
    const out = path.join(ws.app.path, 'dist', 'index.js');
    expect(fs.existsSync(out)).toBe(true);
    expect(fs.readFileSync(out, 'utf-8')).toContain('@test/core');
  });

  // Findings B3 — injected baseUrl, npm build as the orchestrator drives it.
  expectRedOnTs6('npm staging build (orchestrator shape) injects no deprecated option', () => {
    const staging = path.join(ws.root, 'staging');
    compile(ws.core, npmTarget(staging, ws.core), ws.root, ws.packages, staging);
    const result = compile(ws.app, npmTarget(staging, ws.app), ws.root, ws.packages, staging);

    expect(deprecations(result.diagnostics)).toEqual([]);
    expect(result.success).toBe(true);
    expect(fs.existsSync(path.join(staging, 'test', 'app', 'index.js'))).toBe(true);
    expect(fs.existsSync(path.join(staging, 'test', 'app', 'index.d.ts'))).toBe(true);
  });

  // Findings B3 — injected baseUrl, the adapter's own `imports: relative` staging branch.
  expectRedOnTs6('relative-imports staging build injects no deprecated option', () => {
    const staging = path.join(ws.root, 'staging');
    compile(ws.core, npmTarget(staging, ws.core), ws.root, ws.packages, staging);
    const relativeTarget: ResolvedTarget = {
      name: 'npm',
      config: { imports: 'relative', outDir: path.join(staging, 'test', 'app'), declarations: true },
    };
    const result = compile(ws.app, relativeTarget, ws.root, ws.packages, staging);

    expect(deprecations(result.diagnostics)).toEqual([]);
    expect(result.success).toBe(true);
    expect(fs.existsSync(path.join(staging, 'test', 'app', 'index.js'))).toBe(true);
  });

  // Findings B4 — bundler resolution + commonjs target override downgrades to node10.
  expectRedOnTs6('commonjs target over a bundler-resolution tsconfig injects no node10', () => {
    ws = makeWorkspace(BUNDLER_TSCONFIG, BUNDLER_TSCONFIG);
    const result = compile(ws.core, localTarget({ module: 'commonjs' }), ws.root, ws.packages);

    expect(deprecations(result.diagnostics)).toEqual([]);
    expect(result.success).toBe(true);
    const out = path.join(ws.core.path, 'dist', 'index.js');
    expect(fs.existsSync(out)).toBe(true);
    expect(fs.readFileSync(out, 'utf-8')).toContain('exports.greet');
  });

  // Findings B6 — a user's own deprecated option must be surfaced, never swallowed.
  it("surfaces the user's own baseUrl deprecation on 6.x and honors it on 5.x", () => {
    ws = makeWorkspace({
      compilerOptions: {
        ...CLEAN_TSCONFIG.compilerOptions,
        baseUrl: '.',
        paths: { '@test/core': ['../core/src/index.ts'] },
      },
      include: ['src/**/*'],
    });
    compile(ws.core, localTarget(), ws.root, ws.packages);
    const result = compile(ws.app, localTarget(), ws.root, ws.packages);

    if (TS6) {
      expect(result.success).toBe(false);
      expect(result.diagnostics.some((d) => /baseUrl/.test(d) && DEPRECATION.test(d))).toBe(true);
    } else {
      expect(result.success).toBe(true);
      expect(fs.existsSync(path.join(ws.app.path, 'dist', 'index.js'))).toBe(true);
    }
  });
});
