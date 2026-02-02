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
    // For workspaces, use the workspace globs with /tsconfig.json appended
    const projects: string[] = [];
    for (const glob of packageGlobs) {
      const pattern = glob.replace(/\/?\*?$/, '') + '/*/tsconfig.json';
      const found: string[] = globSync(pattern, {
        cwd: dir,
        ignore: ['node_modules/**'],
        absolute: false,
      });
      projects.push(...found);
    }
    if (projects.length > 0) return projects;
    // Fall back to glob patterns if no tsconfigs found yet
    return packageGlobs.map((g) => g.replace(/\/?\*?$/, '') + '/*/tsconfig.json');
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
