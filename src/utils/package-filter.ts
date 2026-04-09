/**
 * @fileoverview Package name resolution for CLI filters
 * @module tsf/utils/package-filter
 *
 * Resolves short package names (e.g., "stdlib") to full scoped names
 * (e.g., "@sharpee/stdlib") by matching against known workspace packages.
 *
 * Public interface: parsePackageFlags(), resolvePackageFilters()
 * Owner: tsf CLI
 */

import type { PackageInfo } from '../types';
import * as logger from './logger';

/**
 * Parses --package and --packageList flags from a CLI args array,
 * merging results into the provided filter array.
 *
 * Mutates `filter` in place and advances the loop index as needed.
 *
 * @param arg - Current argument being processed
 * @param args - Full args array
 * @param i - Current index (will be advanced past consumed values)
 * @param filter - Filter array to push names into
 * @returns New index position after consuming the flag's value, or -1 if not handled
 */
export function parsePackageFlag(arg: string, args: string[], i: number, filter: string[]): number {
  switch (arg) {
    case '--package': {
      const value = args[++i];
      if (value) filter.push(value);
      return i;
    }
    case '--packageList': {
      const value = args[++i];
      if (value) {
        for (const name of value.split(',')) {
          const trimmed = name.trim();
          if (trimmed) filter.push(trimmed);
        }
      }
      return i;
    }
    default:
      return -1;
  }
}

/**
 * Resolves filter entries that are short names to their full scoped package names.
 *
 * Resolution rules:
 * 1. If the filter value matches a known package name exactly, use it as-is.
 * 2. Otherwise, find packages whose name ends with `/{filter}` (scope prefix match).
 * 3. If no match is found, keep the original value and warn.
 *
 * @param filter - Array of package names (short or full)
 * @param packages - Map of full package name → PackageInfo
 * @returns Resolved array of full package names
 */
export function resolvePackageFilters(filter: string[], packages: Map<string, PackageInfo>): string[] {
  if (filter.length === 0) return filter;

  const resolved: string[] = [];
  for (const name of filter) {
    // Exact match — already a full name
    if (packages.has(name)) {
      resolved.push(name);
      continue;
    }

    // Short name — find packages ending with /{name}
    const suffix = `/${name}`;
    const matches = [...packages.keys()].filter((k) => k.endsWith(suffix));

    if (matches.length === 1) {
      resolved.push(matches[0]);
    } else if (matches.length > 1) {
      logger.warn(`Ambiguous short name "${name}" matches: ${matches.join(', ')}. Using all matches.`);
      resolved.push(...matches);
    } else {
      logger.warn(`No package found matching "${name}"`);
      resolved.push(name);
    }
  }

  return resolved;
}
