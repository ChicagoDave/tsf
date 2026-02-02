import { loadBuildContextPublic, shouldSkipTarget } from '../orchestrator';
import * as logger from '../utils/logger';

interface ListOptions {
  condition?: string;
  filter: string[];
}

export function handleList(args: string[]): void {
  const options = parseListOptions(args);

  const ctx = loadBuildContextPublic();
  if (!ctx) return;

  let packages = [...ctx.packages.values()];

  // Filter by condition (only packages that have a non-skipped target with this condition)
  if (options.condition) {
    const conditionTargets = ctx.targets.filter((t) => t.config.condition === options.condition);
    packages = packages.filter((pkg) => conditionTargets.some((t) => !shouldSkipTarget(pkg, t)));
  }

  // Filter by name
  if (options.filter.length > 0) {
    packages = packages.filter((pkg) => options.filter.includes(pkg.name));
  }

  // Output in dependency order
  const packageNames = new Set(packages.map((p) => p.name));
  for (const level of ctx.buildOrder) {
    for (const name of level) {
      if (packageNames.has(name)) {
        console.log(name);
      }
    }
  }
}

function parseListOptions(args: string[]): ListOptions {
  const options: ListOptions = {
    filter: [],
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case '--condition':
        options.condition = args[++i];
        break;
      case '--filter':
        options.filter.push(args[++i]);
        break;
      default:
        if (arg.startsWith('-')) {
          logger.warn(`Unknown option: ${arg}`);
        }
    }
  }

  return options;
}
