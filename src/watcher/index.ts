import * as fs from 'fs';
import * as path from 'path';
import { EventEmitter } from 'events';
import type { PackageInfo } from '../types';
import * as logger from '../utils/logger';

export interface Watcher {
  on(event: 'rebuild', listener: (affectedPackages: string[]) => void): void;
  start(): void;
  stop(): void;
}

/**
 * Create a file watcher that monitors workspace packages and emits
 * rebuild events with the list of affected packages (including dependents).
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
