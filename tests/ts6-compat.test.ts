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
 * The suite is the acceptance gate for ADR-0002: the adapter injects only
 * absolute `paths` entries, never `baseUrl`, and downgrades bundler resolution
 * to node10 only on TypeScript 5.x. It also covers the 6.0 default changes TSF
 * pins or warns about (rootDir, module). Cases map to rows B3-B5, B7 and D1-D3
 * in docs/work/archive/typescript-6-compat/findings.md. The suite must pass on 5.9 and 6.0.
 */

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';
import { compile } from '../src/compilers/tsc';
import { compileWithEsbuild } from '../src/compilers/esbuild';
import { resolveRootDir } from '../src/utils/tsconfig';
import * as logger from '../src/utils/logger';
import type { PackageInfo, ResolvedTarget } from '../src/types';

const TMP = path.resolve(__dirname, '.ts6-compat-tmp');
const TS6 = Number(ts.versionMajorMinor.split('.')[0]) >= 6;

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

  // Findings B3 — local (preserve) build with injected workspace paths, no baseUrl.
  it('local build of a dependent package injects no deprecated option', () => {
    compile(ws.core, localTarget(), ws.root, ws.packages);
    const result = compile(ws.app, localTarget(), ws.root, ws.packages);

    expect(deprecations(result.diagnostics)).toEqual([]);
    expect(result.success).toBe(true);
    const out = path.join(ws.app.path, 'dist', 'index.js');
    expect(fs.existsSync(out)).toBe(true);
    expect(fs.readFileSync(out, 'utf-8')).toContain('@test/core');
  });

  // Findings B3 — npm build as the orchestrator drives it, no baseUrl.
  it('npm staging build (orchestrator shape) injects no deprecated option', () => {
    const staging = path.join(ws.root, 'staging');
    compile(ws.core, npmTarget(staging, ws.core), ws.root, ws.packages, staging);
    const result = compile(ws.app, npmTarget(staging, ws.app), ws.root, ws.packages, staging);

    expect(deprecations(result.diagnostics)).toEqual([]);
    expect(result.success).toBe(true);
    expect(fs.existsSync(path.join(staging, 'test', 'app', 'index.js'))).toBe(true);
    expect(fs.existsSync(path.join(staging, 'test', 'app', 'index.d.ts'))).toBe(true);
  });

  // Findings B3 — the adapter's own `imports: relative` staging branch, no baseUrl.
  it('relative-imports staging build injects no deprecated option', () => {
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
    const dts = path.join(staging, 'test', 'app', 'index.d.ts');
    expect(fs.existsSync(dts)).toBe(true);
    expect(fs.readFileSync(dts, 'utf-8')).toContain('run');
  });

  // Findings B4 — bundler resolution + commonjs target override: node10 only on 5.x.
  it('commonjs target over a bundler-resolution tsconfig injects no node10', () => {
    ws = makeWorkspace(BUNDLER_TSCONFIG, BUNDLER_TSCONFIG);
    const result = compile(ws.core, localTarget({ module: 'commonjs' }), ws.root, ws.packages);

    expect(deprecations(result.diagnostics)).toEqual([]);
    expect(result.success).toBe(true);
    const out = path.join(ws.core.path, 'dist', 'index.js');
    expect(fs.existsSync(out)).toBe(true);
    expect(fs.readFileSync(out, 'utf-8')).toContain('exports.greet');
  });

  // Findings B5 — rootDir shapes the widened-rootDir check must keep handling
  // once entries are absolute: `./src`-prefixed and nested, local and npm-staging.
  describe('rootDir shapes', () => {
    function withRootDir(rootDir: string, entry: string): Workspace {
      const tsconfig: TsconfigJson = {
        compilerOptions: { ...CLEAN_TSCONFIG.compilerOptions, rootDir },
        include: [`${entry.split('/')[0]}/**/*`],
      };
      const w = makeWorkspace(tsconfig, tsconfig);
      for (const pkg of [w.core, w.app]) {
        const from = path.join(pkg.path, 'src', 'index.ts');
        const to = path.join(pkg.path, entry);
        fs.mkdirSync(path.dirname(to), { recursive: true });
        if (from !== to) fs.renameSync(from, to);
        pkg.entryPoint = entry;
      }
      return w;
    }

    /** Every file under `dir`, relative to it. */
    function filesUnder(dir: string): string[] {
      if (!fs.existsSync(dir)) return [];
      return fs
        .readdirSync(dir, { recursive: true, encoding: 'utf-8' })
        .filter((f) => fs.statSync(path.join(dir, f)).isFile())
        .sort();
    }

    // The widened-rootDir flatten (`flattenWidenedOutput`) assumes the package
    // source dir is `src`; with a nested rootDir such as `src/lib` the dependent
    // package's output lands at `dist/lib/index.js` instead of `dist/index.js`.
    // Pre-existing, independent of ADR-0002 (the widening decision is unchanged),
    // and the fourth instance of the pattern open issue 3 tracks. The expectation
    // below is the correct layout; `it.fails` until issue 3 lands.
    for (const [label, rootDir, entry, dependentIt] of [
      ['./src-prefixed rootDir', './src', 'src/index.ts', it],
      ['nested rootDir', 'src/lib', 'src/lib/index.ts', it.fails],
    ] as const) {
      dependentIt(`${label}: local build flattens the dependent package to outDir root`, () => {
        ws = withRootDir(rootDir, entry);
        const coreResult = compile(ws.core, localTarget(), ws.root, ws.packages);
        const result = compile(ws.app, localTarget(), ws.root, ws.packages);

        expect(coreResult.diagnostics).toEqual([]);
        expect(filesUnder(path.join(ws.core.path, 'dist'))).toEqual(['index.d.ts', 'index.js']);
        expect(deprecations(result.diagnostics)).toEqual([]);
        expect(result.success).toBe(true);
        expect(filesUnder(path.join(ws.app.path, 'dist'))).toEqual(['index.d.ts', 'index.js']);
        expect(fs.readFileSync(path.join(ws.app.path, 'dist', 'index.js'), 'utf-8')).toContain('@test/core');
      });

      dependentIt(`${label}: npm staging build flattens the dependent package to its staging root`, () => {
        ws = withRootDir(rootDir, entry);
        const staging = path.join(ws.root, 'staging');
        compile(ws.core, npmTarget(staging, ws.core), ws.root, ws.packages, staging);
        const result = compile(ws.app, npmTarget(staging, ws.app), ws.root, ws.packages, staging);

        expect(deprecations(result.diagnostics)).toEqual([]);
        expect(result.success).toBe(true);
        expect(filesUnder(path.join(staging, 'test', 'core'))).toEqual(['index.d.ts', 'index.js']);
        expect(filesUnder(path.join(staging, 'test', 'app'))).toEqual(['index.d.ts', 'index.js']);
        expect(fs.readFileSync(path.join(staging, 'test', 'app', 'index.d.ts'), 'utf-8')).toContain('run');
      });
    }
  });

  // ADR-0002 Decision 2 — user-authored paths (no baseUrl) are honored, not overridden.
  it('honors user-declared paths without baseUrl and injects nothing for them', () => {
    ws = makeWorkspace({
      compilerOptions: {
        ...CLEAN_TSCONFIG.compilerOptions,
        paths: { '@test/core': ['../core/src/index.ts'] },
      },
      include: ['src/**/*'],
    });
    compile(ws.core, localTarget(), ws.root, ws.packages);
    const result = compile(ws.app, localTarget(), ws.root, ws.packages);

    expect(result.diagnostics).toEqual([]);
    expect(result.success).toBe(true);
    expect(fs.existsSync(path.join(ws.app.path, 'dist', 'index.js'))).toBe(true);
  });

  // Findings D3 — 6.0 defaults rootDir to the tsconfig directory; TSF pins the
  // common source directory so `src/index.ts` keeps landing at `dist/index.js`.
  describe('rootDir omitted by the user', () => {
    function withoutRootDir(): Workspace {
      const { rootDir: _omitted, ...rest } = CLEAN_TSCONFIG.compilerOptions;
      const tsconfig: TsconfigJson = { compilerOptions: rest, include: ['src/**/*'] };
      return makeWorkspace(tsconfig, tsconfig);
    }

    it('local build emits the entry point at outDir root on 5.x and 6.0 alike', () => {
      ws = withoutRootDir();
      const coreResult = compile(ws.core, localTarget(), ws.root, ws.packages);
      const result = compile(ws.app, localTarget(), ws.root, ws.packages);

      expect(coreResult.diagnostics).toEqual([]);
      expect(fs.readdirSync(path.join(ws.core.path, 'dist')).sort()).toEqual(['index.d.ts', 'index.js']);
      expect(result.diagnostics).toEqual([]);
      expect(fs.existsSync(path.join(ws.app.path, 'dist', 'index.js'))).toBe(true);
      expect(fs.existsSync(path.join(ws.app.path, 'dist', 'src'))).toBe(false);
    });

    it('npm staging build places and resolves the dependency entry point at the staging root', () => {
      ws = withoutRootDir();
      const staging = path.join(ws.root, 'staging');
      compile(ws.core, npmTarget(staging, ws.core), ws.root, ws.packages, staging);
      const result = compile(ws.app, npmTarget(staging, ws.app), ws.root, ws.packages, staging);

      expect(result.diagnostics).toEqual([]);
      expect(fs.existsSync(path.join(staging, 'test', 'core', 'index.d.ts'))).toBe(true);
      expect(fs.existsSync(path.join(staging, 'test', 'app', 'index.d.ts'))).toBe(true);
      expect(fs.existsSync(path.join(staging, 'test', 'app', 'src'))).toBe(false);
    });
  });

  // Findings D3 — the esbuild adapter's declaration-only tsc pass pins rootDir the same way.
  it('esbuild declaration emit places .d.ts at outDir root when rootDir is omitted', () => {
    const { rootDir: _omitted, ...rest } = BUNDLER_TSCONFIG.compilerOptions;
    const tsconfig: TsconfigJson = { compilerOptions: rest, include: ['src/**/*'] };
    ws = makeWorkspace(tsconfig, tsconfig);
    const target: ResolvedTarget = {
      name: 'fast',
      config: { imports: 'preserve', outDir: 'dist', declarations: true, module: 'esnext', transpiler: 'esbuild' },
    };
    // Single-package map: with another workspace package present the adapter passes
    // `external` without `bundle`, which esbuild rejects (pre-existing, issue 7).
    const onlyCore = new Map([[ws.core.name, ws.core]]);
    const result = compileWithEsbuild(ws.core, target, ws.root, onlyCore);

    expect(result.diagnostics).toEqual([]);
    expect(result.success).toBe(true);
    expect(fs.existsSync(path.join(ws.core.path, 'dist', 'index.js'))).toBe(true);
    expect(fs.existsSync(path.join(ws.core.path, 'dist', 'index.d.ts'))).toBe(true);
    expect(fs.existsSync(path.join(ws.core.path, 'dist', 'src'))).toBe(false);
  });

  describe('resolveRootDir', () => {
    it('returns the declared rootDir resolved against the tsconfig directory', () => {
      expect(resolveRootDir(ws.core.tsconfig)).toBe(path.join(ws.core.path, 'src'));
    });

    it('infers the common source directory when rootDir is omitted', () => {
      const { rootDir: _omitted, ...rest } = CLEAN_TSCONFIG.compilerOptions;
      writeJson(ws.core.tsconfig, { compilerOptions: rest, include: ['src/**/*'] });
      expect(resolveRootDir(ws.core.tsconfig)).toBe(path.join(ws.core.path, 'src'));

      fs.mkdirSync(path.join(ws.core.path, 'lib'), { recursive: true });
      fs.writeFileSync(path.join(ws.core.path, 'lib', 'extra.ts'), 'export const x = 1;\n');
      writeJson(ws.core.tsconfig, { compilerOptions: rest, include: ['src/**/*', 'lib/**/*'] });
      expect(resolveRootDir(ws.core.tsconfig)).toBe(ws.core.path);
    });

    it('falls back to the tsconfig directory when there are no input files', () => {
      const { rootDir: _omitted, ...rest } = CLEAN_TSCONFIG.compilerOptions;
      writeJson(ws.core.tsconfig, { compilerOptions: rest, include: ['nothing/**/*'] });
      expect(resolveRootDir(ws.core.tsconfig)).toBe(ws.core.path);
    });
  });

  // Findings D1 — 6.0 defaults `module` to esnext regardless of target (5.x: es2015
  // for ES2015+ targets, commonjs for ES3/ES5). TSF does not pin it but warns; the
  // emitted format follows the installed compiler, ESM for this ES2022 fixture on both.
  it('warns when neither the target nor the tsconfig sets module, and emits the compiler default', () => {
    // Neither `module` nor `moduleResolution`: 5.x rejects bundler resolution with its
    // default commonjs module (TS5095), so the resolution default must float too.
    const { module: _m, moduleResolution: _r, ...rest } = CLEAN_TSCONFIG.compilerOptions;
    const tsconfig: TsconfigJson = { compilerOptions: rest, include: ['src/**/*'] };
    ws = makeWorkspace(tsconfig, tsconfig);
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    try {
      const result = compile(ws.core, localTarget(), ws.root, ws.packages);

      expect(result.diagnostics).toEqual([]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('"module"'), '@test/core:local');
      const out = fs.readFileSync(path.join(ws.core.path, 'dist', 'index.js'), 'utf-8');
      expect(out).toContain('export const greet');
    } finally {
      warn.mockRestore();
    }
  });

  it('does not warn when the target sets module, and maps preserve', () => {
    ws = makeWorkspace(BUNDLER_TSCONFIG, BUNDLER_TSCONFIG);
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    try {
      const result = compile(ws.core, localTarget({ module: 'preserve' }), ws.root, ws.packages);

      expect(result.diagnostics).toEqual([]);
      expect(warn).not.toHaveBeenCalled();
      expect(fs.readFileSync(path.join(ws.core.path, 'dist', 'index.js'), 'utf-8')).toContain('export const greet');
    } finally {
      warn.mockRestore();
    }
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
