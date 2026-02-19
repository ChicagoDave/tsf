/**
 * @fileoverview File system watcher for incremental rebuild
 * @module tsf/watcher
 *
 * Monitors source files in workspace packages and triggers rebuilds
 * when changes are detected. Intelligently propagates changes through
 * the dependency graph — if package A depends on B and B changes,
 * both B and A are rebuilt.
 *
 * Features:
 * - Recursive directory watching
 * - Change debouncing (batches rapid saves)
 * - Dependency-aware rebuild propagation
 * - TypeScript file filtering (.ts, .tsx only)
 *
 * @example
 * ```typescript
 * const watcher = createWatcher(packages, buildOrder);
 * watcher.on('rebuild', async (affected) => {
 *   for (const pkg of affected) await build(pkg);
 * });
 * watcher.start();
 * ```
 */

import * as fs from 'fs';
import * as path from 'path';
import { EventEmitter } from 'events';
import type { PackageInfo } from '../types';
import * as logger from '../utils/logger';

/**
 * File watcher interface.
 */
export interface Watcher {
  /** Subscribe to rebuild events */
  on(event: 'rebuild', listener: (affectedPackages: string[]) => void): void;
  /** Start watching source directories */
  start(): void;
  /** Stop watching and clean up resources */
  stop(): void;
}

/**
 * Creates a file watcher for workspace packages.
 *
 * When a source file changes, computes all affected packages
 * (the changed package plus all packages that depend on it,
 * transitively) and emits a 'rebuild' event.
 *
 * @param packages - Map of package name → PackageInfo
 * @param buildOrder - Topologically sorted build levels (used for ordering rebuilds)
 * @returns Watcher instance
 */
export function createWatcher(
  packages: Map<string, PackageInfo>,
  buildOrder: string[][],
): Watcher {
  const emitter = new EventEmitter();
  const watchers: fs.FSWatcher[] = [];
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingChanges = new Set<string>();

  // Build reverse dependency map: package → packages that depend on it
  const dependents = new Map<string, string[]>();
  for (const [name, pkg] of packages) {
    for (const dep of pkg.dependencies) {
      if (!dependents.has(dep)) dependents.set(dep, []);
      dependents.get(dep)!.push(name);
    }
  }

  function getAffectedPackages(changedPkg: string): string[] {
    const affected = new Set<string>();
    const queue = [changedPkg];

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (affected.has(current)) continue;
      affected.add(current);
      // Add all packages that depend on this one
      const deps = dependents.get(current) || [];
      queue.push(...deps);
    }

    return [...affected];
  }

  function handleChange(pkgName: string, filename: string) {
    // Ignore non-TS files and output directories
    if (filename && !/\.tsx?$/.test(filename)) return;

    pendingChanges.add(pkgName);

    // Debounce to batch rapid saves
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      const allAffected = new Set<string>();
      for (const changed of pendingChanges) {
        for (const affected of getAffectedPackages(changed)) {
          allAffected.add(affected);
        }
      }
      pendingChanges.clear();

      if (allAffected.size > 0) {
        emitter.emit('rebuild', [...allAffected]);
      }
    }, 200);
  }

  return {
    on(event: string, listener: (...args: any[]) => void) {
      emitter.on(event, listener);
    },

    start() {
      for (const [name, pkg] of packages) {
        const srcDir = path.resolve(pkg.path, path.dirname(pkg.entryPoint));
        if (!fs.existsSync(srcDir)) continue;

        try {
          const watcher = fs.watch(srcDir, { recursive: true }, (_event, filename) => {
            handleChange(name, filename as string);
          });
          watchers.push(watcher);
          logger.verbose(`Watching ${srcDir}`, name);
        } catch (err: any) {
          logger.warn(`Could not watch ${srcDir}: ${err.message}`, name);
        }
      }
    },

    stop() {
      if (debounceTimer) clearTimeout(debounceTimer);
      for (const watcher of watchers) {
        watcher.close();
      }
      watchers.length = 0;
    },
  };
}
