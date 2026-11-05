import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { compileWithEsbuild } from '../src/compilers/esbuild';
import type { PackageInfo, ResolvedTarget } from '../src/types';

const TARGET: ResolvedTarget = { name: 'local', config: { imports: 'preserve' } };

let root: string;

function addPackage(name: string, source: string): PackageInfo {
  const dir = path.join(root, 'packages', name.replace('@test/', ''));
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, version: '1.0.0' }));
  fs.writeFileSync(path.join(dir, 'src', 'index.ts'), source);
  fs.writeFileSync(
    path.join(dir, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: { target: 'ES2022', module: 'commonjs', strict: true, skipLibCheck: true },
      include: ['src/**/*'],
    }),
  );
  return {
    name,
    path: dir,
    tsconfig: path.join(dir, 'tsconfig.json'),
    dependencies: [],
    entryPoint: 'src/index.ts',
  };
}

describe('compileWithEsbuild', () => {
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'tsf-esbuild-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('transpiles in a workspace with more than one package', () => {
    const core = addPackage('@test/core', 'export const coreValue = 1;\n');
    const app = addPackage(
      '@test/app',
      "import { coreValue } from '@test/core';\nexport const appValue = coreValue + 1;\n",
    );
    const packages = new Map([
      [core.name, core],
      [app.name, app],
    ]);

    const coreResult = compileWithEsbuild(core, TARGET, root, packages);
    expect(coreResult.diagnostics).toEqual([]);
    expect(coreResult.success).toBe(true);
    expect(fs.existsSync(path.join(core.path, 'dist', 'index.js'))).toBe(true);

    const appResult = compileWithEsbuild(app, TARGET, root, packages);
    expect(appResult.diagnostics).toEqual([]);
    expect(appResult.success).toBe(true);
    const appOutput = fs.readFileSync(path.join(app.path, 'dist', 'index.js'), 'utf-8');
    expect(appOutput).toContain('@test/core');
  });
});
