import type { PackageInfo } from '../types';

export function getBuildOrder(packages: Map<string, PackageInfo>): string[][] {
  // Kahn's algorithm for topological sort, returning parallel levels
  const inDegree = new Map<string, number>();
  const dependents = new Map<string, string[]>(); // pkg -> packages that depend on it

  for (const [name, pkg] of packages) {
    inDegree.set(name, 0);
    dependents.set(name, []);
  }

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

  const levels: string[][] = [];
  let queue = [...inDegree.entries()]
    .filter(([, deg]) => deg === 0)
    .map(([name]) => name);

  let processed = 0;

  while (queue.length > 0) {
    levels.push(queue.sort()); // Sort for deterministic order
    const nextQueue: string[] = [];

    for (const name of queue) {
      processed++;
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

  if (processed !== packages.size) {
    const remaining = [...inDegree.entries()]
      .filter(([, deg]) => deg > 0)
      .map(([name]) => name);
    throw new Error(`Circular dependency detected among: ${remaining.join(', ')}`);
  }

  return levels;
}
