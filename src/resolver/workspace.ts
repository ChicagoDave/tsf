import * as fs from 'fs';
import * as path from 'path';
import type { WorkspaceType } from '../types';

export interface WorkspaceInfo {
  type: WorkspaceType;
  rootDir: string;
  packageGlobs: string[];
}

export function detectWorkspace(rootDir: string): WorkspaceInfo | null {
  // Check pnpm first
  const pnpmWorkspace = path.join(rootDir, 'pnpm-workspace.yaml');
  if (fs.existsSync(pnpmWorkspace)) {
    const globs = parsePnpmWorkspace(pnpmWorkspace);
    return { type: 'pnpm', rootDir, packageGlobs: globs };
  }

  // Check package.json workspaces (npm / yarn)
  const pkgJsonPath = path.join(rootDir, 'package.json');
  if (fs.existsSync(pkgJsonPath)) {
    const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8'));

    if (Array.isArray(pkgJson.workspaces)) {
      const type: WorkspaceType = fs.existsSync(path.join(rootDir, 'yarn.lock')) ? 'yarn' : 'npm';
      return { type, rootDir, packageGlobs: pkgJson.workspaces };
    }

    // yarn workspaces can also be an object with "packages"
    if (pkgJson.workspaces?.packages && Array.isArray(pkgJson.workspaces.packages)) {
      return { type: 'yarn', rootDir, packageGlobs: pkgJson.workspaces.packages };
    }
  }

  return null;
}

function parsePnpmWorkspace(filePath: string): string[] {
  // Minimal YAML parser for pnpm-workspace.yaml
  // Format is: packages:\n  - "glob"\n  - "glob"
  const content = fs.readFileSync(filePath, 'utf-8');
  const globs: string[] = [];
  let inPackages = false;

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === 'packages:') {
      inPackages = true;
      continue;
    }
    if (inPackages) {
      if (trimmed.startsWith('- ')) {
        const glob = trimmed.slice(2).replace(/^['"]|['"]$/g, '');
        globs.push(glob);
      } else if (trimmed && !trimmed.startsWith('#')) {
        break; // Next top-level key
      }
    }
  }

  return globs;
}
