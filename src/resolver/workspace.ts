/**
 * @fileoverview Workspace type detection and package glob extraction
 * @module tsf/resolver/workspace
 *
 * Detects the package manager and workspace configuration in a monorepo.
 * Supports:
 * - **pnpm**: `pnpm-workspace.yaml`
 * - **npm**: `package.json` with `workspaces` array
 * - **yarn**: `package.json` with `workspaces` array or object
 *
 * The extracted package globs are used by the package resolver to find
 * all packages in the workspace.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { WorkspaceType } from '../types';

/**
 * Detected workspace information.
 */
export interface WorkspaceInfo {
  /** Package manager type */
  type: WorkspaceType;
  /** Workspace root directory */
  rootDir: string;
  /** Glob patterns matching package directories */
  packageGlobs: string[];
}

/**
 * Detects workspace type and extracts package globs from the root directory.
 * Checks for workspace configuration in this order:
 * 1. pnpm-workspace.yaml (pnpm)
 * 2. package.json workspaces (npm or yarn)
 *
 * @param rootDir - Directory to check for workspace configuration
 * @returns Workspace info if detected, null otherwise
 *
 * @example
 * ```typescript
 * const workspace = detectWorkspace('/path/to/monorepo');
 * if (workspace) {
 *   console.log(`Found ${workspace.type} workspace`);
 *   console.log(`Packages: ${workspace.packageGlobs.join(', ')}`);
 * }
 * ```
 */
export function detectWorkspace(rootDir: string): WorkspaceInfo | null {
  // Check pnpm first (has dedicated workspace file)
  const pnpmWorkspace = path.join(rootDir, 'pnpm-workspace.yaml');
  if (fs.existsSync(pnpmWorkspace)) {
    const globs = parsePnpmWorkspace(pnpmWorkspace);
    return { type: 'pnpm', rootDir, packageGlobs: globs };
  }

  // Check package.json workspaces (npm / yarn)
  const pkgJsonPath = path.join(rootDir, 'package.json');
  if (fs.existsSync(pkgJsonPath)) {
    const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8'));

    // npm/yarn: workspaces as array
    if (Array.isArray(pkgJson.workspaces)) {
      const type: WorkspaceType = fs.existsSync(path.join(rootDir, 'yarn.lock')) ? 'yarn' : 'npm';
      return { type, rootDir, packageGlobs: pkgJson.workspaces };
    }

    // yarn: workspaces as object with "packages" key
    if (pkgJson.workspaces?.packages && Array.isArray(pkgJson.workspaces.packages)) {
      return { type: 'yarn', rootDir, packageGlobs: pkgJson.workspaces.packages };
    }
  }

  return null;
}

/**
 * Parses pnpm-workspace.yaml to extract package globs.
 * Uses a minimal YAML parser (no external dependency) since the format is simple.
 *
 * Expected format:
 * ```yaml
 * packages:
 *   - "packages/*"
 *   - "apps/*"
 * ```
 *
 * @param filePath - Path to pnpm-workspace.yaml
 * @returns Array of package glob patterns
 */
function parsePnpmWorkspace(filePath: string): string[] {
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
        // Strip list marker and optional quotes
        const glob = trimmed.slice(2).replace(/^['"]|['"]$/g, '');
        globs.push(glob);
      } else if (trimmed && !trimmed.startsWith('#')) {
        break; // Reached next top-level key
      }
    }
  }

  return globs;
}
