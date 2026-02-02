import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { loadBuildContextPublic, shouldSkipTarget } from '../orchestrator';
import * as logger from '../utils/logger';

interface PublishOptions {
  tag: string;
  filter: string[];
  condition?: string;
  dryRun: boolean;
}

export function handlePublish(args: string[]): void {
  const options = parsePublishOptions(args);

  const ctx = loadBuildContextPublic();
  if (!ctx) return;

  // Find packages with publishConfig
  const allPackages = [...ctx.packages.values()];
  const publishable = allPackages.filter((pkg) => {
    const pkgJsonPath = path.join(pkg.path, 'package.json');
    try {
      const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8'));
      return !!pkgJson.publishConfig;
    } catch {
      return false;
    }
  });

  // Apply condition filter (uses target-aware scoping)
  let packages = publishable;
  if (options.condition) {
    const conditionTargets = ctx.targets.filter((t) => t.config.condition === options.condition);
    packages = packages.filter((pkg) => conditionTargets.some((t) => !shouldSkipTarget(pkg, t)));
  }

  // Apply name filter
  if (options.filter.length > 0) {
    packages = packages.filter((pkg) => options.filter.includes(pkg.name));
  }

  if (packages.length === 0) {
    logger.error('No publishable packages found');
    process.exit(1);
  }

  // Check npm login (skip for dry-run)
  if (!options.dryRun) {
    try {
      const user = execSync('npm whoami', { stdio: 'pipe' }).toString().trim();
      logger.info(`Logged in to npm as ${user}`);
    } catch {
      logger.error('Not logged in to npm. Run `npm login` first.');
      process.exit(1);
    }
  }

  // Build ordered list from buildOrder levels
  const packageNames = new Set(packages.map((p) => p.name));
  const ordered: typeof packages = [];
  for (const level of ctx.buildOrder) {
    for (const name of level) {
      if (packageNames.has(name)) {
        const pkg = packages.find((p) => p.name === name);
        if (pkg) ordered.push(pkg);
      }
    }
  }

  // Publish in dependency order
  const published: string[] = [];
  const dryRunFlag = options.dryRun ? '--dry-run' : '';
  const label = options.dryRun ? ' (dry run)' : '';

  for (const pkg of ordered) {
    logger.info(`Publishing ${pkg.name}${label}`);
    try {
      execSync(
        `npm publish --access public --no-git-checks --tag ${options.tag} ${dryRunFlag}`.trim(),
        { cwd: pkg.path, stdio: 'inherit' },
      );
      published.push(pkg.name);
    } catch {
      logger.error(`Failed to publish ${pkg.name}`);
      process.exit(1);
    }
  }

  logger.success(`Published ${published.length} package(s)${label}`);
}

function parsePublishOptions(args: string[]): PublishOptions {
  const options: PublishOptions = {
    tag: 'latest',
    filter: [],
    dryRun: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case '--tag':
        options.tag = args[++i];
        break;
      case '--filter':
        options.filter.push(args[++i]);
        break;
      case '--condition':
        options.condition = args[++i];
        break;
      case '--dry-run':
        options.dryRun = true;
        break;
      default:
        if (!arg.startsWith('-')) {
          // ignore positional
        } else {
          logger.warn(`Unknown option: ${arg}`);
        }
    }
  }

  return options;
}
