import * as fs from 'fs';
import * as path from 'path';
import { detectWorkspace } from '../resolver/workspace';
import * as logger from '../utils/logger';

export function generateGitHubAction(rootDir?: string): void {
  const dir = rootDir || process.cwd();
  const outDir = path.join(dir, '.github', 'workflows');
  const outPath = path.join(outDir, 'tsf.yml');

  if (fs.existsSync(outPath)) {
    logger.warn('.github/workflows/tsf.yml already exists');
    return;
  }

  const workspace = detectWorkspace(dir);
  const pm = workspace?.type === 'pnpm' ? 'pnpm' : workspace?.type === 'yarn' ? 'yarn' : 'npm';

  const installCmd = pm === 'pnpm' ? 'pnpm install --frozen-lockfile' :
                     pm === 'yarn' ? 'yarn install --frozen-lockfile' :
                     'npm ci';

  const setupPnpm = pm === 'pnpm' ? `
      - name: Setup pnpm
        uses: pnpm/action-setup@v4
` : '';

  const yaml = `name: TSF Build

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  build:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        node-version: [18, 20, 22]

    steps:
      - name: Checkout
        uses: actions/checkout@v4
${setupPnpm}
      - name: Setup Node.js \${{ matrix.node-version }}
        uses: actions/setup-node@v4
        with:
          node-version: \${{ matrix.node-version }}
          cache: '${pm}'

      - name: Install dependencies
        run: ${installCmd}

      - name: Type check
        run: npx tsf check

      - name: Build
        run: npx tsf build --all

      - name: Validate outputs
        run: npx tsf validate
`;

  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(outPath, yaml, 'utf-8');
  logger.success(`Created ${outPath}`);
}
