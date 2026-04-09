/**
 * @fileoverview Package listing in dependency order
 * @module tsf/cli/list
 *
 * Lists workspace packages in topological (dependency) order.
 * Useful for scripting and understanding the build graph.
 *
 * @example
 * ```bash
 * tsf list                    # List all packages
 * tsf list --condition publish # List packages with publish target
 * tsf list --filter @scope/pkg # List specific packages
 * ```
 */

import { loadBuildContextPublic, shouldSkipTarget } from '../orchestrator';
import * as logger from '../utils/logger';
import { parsePackageFlag, resolvePackageFilters } from '../utils/package-filter';

/**
 * Options for the list command.
 */
interface ListOptions {
  /** Only list packages with this target condition */
  condition?: string;
  /** Package names to list (empty = all) */
  filter: string[];
}

/**
 * Handles the `tsf list` command.
 * Outputs packages in dependency order.
 */
export function handleList(args: string[]): void {
  const options = parseListOptions(args);

  const ctx = loadBuildContextPublic();
  if (!ctx) return;

  // Resolve short package names (e.g., "stdlib" → "@sharpee/stdlib")
  if (options.filter.length > 0) {
    options.filter = resolvePackageFilters(options.filter, ctx.packages);
  }

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
      case '--package':
      case '--packageList': {
        const newI = parsePackageFlag(arg, args, i, options.filter);
        if (newI >= 0) i = newI;
        break;
      }
      default:
        if (arg.startsWith('-')) {
          logger.warn(`Unknown option: ${arg}`);
        }
    }
  }

  return options;
}
