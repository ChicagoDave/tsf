/**
 * @fileoverview Dependency graph analysis and build ordering
 * @module tsf/resolver/graph
 *
 * Computes the build order for workspace packages using topological sort.
 * Packages are grouped into "levels" that can be built in parallel:
 * - Level 0: Packages with no workspace dependencies
 * - Level 1: Packages depending only on level 0 packages
 * - Level N: Packages depending on levels 0..N-1
 *
 * This enables maximum parallelism while respecting dependency constraints.
 *
 * @example Build order for a diamond dependency:
 * ```
 *       A
 *      / \
 *     B   C
 *      \ /
 *       D
 *
 * Levels: [[D], [B, C], [A]]
 * - Level 0: D (no deps) - build first
 * - Level 1: B, C (both depend on D) - build in parallel after D
 * - Level 2: A (depends on B and C) - build last
 * ```
 */

import type { PackageInfo } from '../types';

/**
 * Computes build order using Kahn's algorithm for topological sort.
 * Returns packages grouped by parallel build levels.
 *
 * Algorithm:
 * 1. Count incoming edges (dependencies) for each package
 * 2. Start with packages that have no dependencies (in-degree 0)
 * 3. Remove them from graph, decrement dependents' in-degree
 * 4. Repeat until all packages are processed
 * 5. Detect cycles if any packages remain unprocessed
 *
 * @param packages - Map of package name → PackageInfo
 * @returns Array of build levels; packages in each level can build in parallel
 * @throws {Error} If circular dependencies are detected
 *
 * @example
 * ```typescript
 * const order = getBuildOrder(packages);
 * for (const level of order) {
 *   await Promise.all(level.map(pkg => buildPackage(pkg)));
 * }
 * ```
 */
export function getBuildOrder(packages: Map<string, PackageInfo>): string[][] {
  // Track in-degree (number of dependencies) for each package
  const inDegree = new Map<string, number>();
  // Track reverse edges: package → packages that depend on it
  const dependents = new Map<string, string[]>();

  // Initialize with zero in-degree
  for (const [name] of packages) {
    inDegree.set(name, 0);
    dependents.set(name, []);
  }

  // Calculate actual in-degrees from dependency relationships
  for (const [name, pkg] of packages) {
    let degree = 0;
    for (const dep of pkg.dependencies) {
      if (packages.has(dep)) {
        degree++;
        dependents.get(dep)!.push(name);
      }
    }
    inDegree.set(name, degree);
  }

  // Process packages level by level
  const levels: string[][] = [];
  let queue = [...inDegree.entries()]
    .filter(([, deg]) => deg === 0)
    .map(([name]) => name);

  let processed = 0;

  while (queue.length > 0) {
    // Sort for deterministic build order across runs
    levels.push(queue.sort());
    const nextQueue: string[] = [];

    for (const name of queue) {
      processed++;
      // Decrement in-degree for all packages that depend on this one
      for (const dependent of dependents.get(name)!) {
        const newDeg = inDegree.get(dependent)! - 1;
        inDegree.set(dependent, newDeg);
        if (newDeg === 0) {
          nextQueue.push(dependent);
        }
      }
    }

    queue = nextQueue;
  }

  // Cycle detection: if not all packages processed, there's a cycle
  if (processed !== packages.size) {
    const remaining = [...inDegree.entries()]
      .filter(([, deg]) => deg > 0)
      .map(([name]) => name);
    throw new Error(`Circular dependency detected among: ${remaining.join(', ')}`);
  }

  return levels;
}
