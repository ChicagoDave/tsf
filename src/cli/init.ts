/**
 * @fileoverview Configuration initialization wizard
 * @module tsf/cli/init
 *
 * Generates `ts-forge.config.json` by analyzing the existing project structure.
 * Detects workspace type, tsconfig settings, and package.json hints to
 * create appropriate build targets.
 *
 * Safe to re-run: merges new targets without overwriting existing config.
 *
 * Detection logic:
 * - Workspace type (pnpm, npm, yarn)
 * - Project template (library, cli, monorepo)
 * - Module format from tsconfig.json
 * - Entry points from package.json
 *
 * @example
 * ```bash
 * tsf init    # Generate config in current directory
 * ```
 */

import * as fs from 'fs';
import * as path from 'path';
import type { TsForgeConfig, TargetConfig } from '../types';
import { detectWorkspace } from '../resolver/workspace';
import {
  readPackageJsonHints,
  readTsconfigHints,
  detectFromPackageJson,
  detectDefaults,
  detectTemplate,
  getTemplateTargets,
} from './detect';
import * as logger from '../utils/logger';

/**
 * Handles the `tsf init` command.
 * Generates configuration by analyzing the project structure.
 */
export function init(rootDir?: string): void {
  const dir = rootDir || process.cwd();
  const configPath = path.join(dir, 'ts-forge.config.json');
  const exists = fs.existsSync(configPath);

  // Detect existing environment
  const pkgHints = readPackageJsonHints(dir);
  const tsHints = readTsconfigHints(dir);
  const workspace = detectWorkspace(dir);
  const isWorkspace = workspace !== null;

  // Detect tsconfig project globs
  const projects = detectProjects(dir, isWorkspace, workspace?.packageGlobs);

  if (projects.length === 0) {
    logger.warn('No tsconfig.json files found');
    return;
  }

  // Try to infer targets from existing package.json
  let targets: Record<string, TargetConfig> = {};
  if (pkgHints) {
    targets = detectFromPackageJson(pkgHints);
  }

  // Fall back to template-based targets if detection didn't find anything
  if (Object.keys(targets).length === 0) {
    const template = detectTemplate(pkgHints, isWorkspace);
    targets = getTemplateTargets(template);
    logger.info(`Using "${template}" template`);
  } else {
    logger.info('Auto-detected targets from package.json');
  }

  const defaults = detectDefaults(tsHints);

  if (exists) {
    // Idempotent merge: add new targets without overwriting existing ones
    const existing: TsForgeConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    let merged = false;

    if (!existing.targets) existing.targets = {};
    for (const [name, config] of Object.entries(targets)) {
      if (!(name in existing.targets)) {
        existing.targets[name] = config;
        merged = true;
        logger.info(`Added target "${name}"`);
      }
    }

    // Update projects if they changed
    if (JSON.stringify(existing.projects) !== JSON.stringify(projects)) {
      existing.projects = projects;
      merged = true;
      logger.info('Updated project globs');
    }

    if (merged) {
      fs.writeFileSync(configPath, JSON.stringify(existing, null, 2) + '\n', 'utf-8');
      logger.success(`Updated ${configPath}`);
    } else {
      logger.info('Config is up to date, no changes needed');
    }
    return;
  }

  // Create new config
  const config: TsForgeConfig = {
    projects,
    targets,
    defaults,
  };

  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
  logger.success(`Created ${configPath}`);
}

function detectProjects(
  dir: string,
  isWorkspace: boolean,
  packageGlobs?: string[],
): string[] {
  const { globSync } = require('glob');

  if (isWorkspace && packageGlobs && packageGlobs.length > 0) {
    // Separate inclusion globs from negation (exclusion) patterns
    const includeGlobs: string[] = [];
    const excludeGlobs: string[] = [];

    for (const glob of packageGlobs) {
      if (glob.startsWith('!')) {
        // Convert negation to an ignore pattern: !packages/forge → packages/forge/**/tsconfig.json
        const excluded = glob.slice(1);
        excludeGlobs.push(excluded + '/tsconfig.json');
        excludeGlobs.push(excluded + '/*/tsconfig.json');
      } else {
        includeGlobs.push(glob);
      }
    }

    // For each inclusion glob, find tsconfig.json files
    const projects: string[] = [];
    const ignore = ['node_modules/**', ...excludeGlobs];

    for (const glob of includeGlobs) {
      // If glob ends with *, it matches directories directly: packages/* → packages/*/tsconfig.json
      // If it's a specific path: packages/platforms/* → packages/platforms/*/tsconfig.json
      const pattern = glob.endsWith('*')
        ? glob + '/tsconfig.json'
        : glob + '/tsconfig.json';

      const found: string[] = globSync(pattern, {
        cwd: dir,
        ignore,
        absolute: false,
      });
      projects.push(...found);
    }

    if (projects.length > 0) return projects;
    // Fall back to glob patterns if no tsconfigs found yet
    return includeGlobs.map((g) => g + '/tsconfig.json');
  }

  // Single-project: find all tsconfig files
  const tsconfigs: string[] = globSync('**/tsconfig.json', {
    cwd: dir,
    ignore: ['node_modules/**', '**/node_modules/**'],
    absolute: false,
  });

  if (tsconfigs.length === 1) return tsconfigs;
  if (tsconfigs.length > 1) return ['packages/*/tsconfig.json'];
  return [];
}
