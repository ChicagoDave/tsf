/**
 * @fileoverview Configuration file discovery and loading
 * @module tsf/config/loader
 *
 * Handles finding and parsing TSF configuration files:
 * - `ts-forge.config.json` - Workspace root configuration
 * - `ts-forge.json` - Per-package overrides
 *
 * The loader walks up the directory tree to find the root config,
 * enabling TSF commands to be run from any subdirectory.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { TsForgeConfig, PackageOverride } from '../types';

/** Root configuration filename */
const CONFIG_FILENAME = 'ts-forge.config.json';

/** Per-package override filename */
const PACKAGE_CONFIG_FILENAME = 'ts-forge.json';

/**
 * Searches for the TSF config file by walking up the directory tree.
 * Starts from the given directory and checks each parent until found.
 *
 * @param startDir - Directory to start searching from
 * @returns Absolute path to config file, or null if not found
 *
 * @example
 * ```typescript
 * const configPath = findConfigFile(process.cwd());
 * if (!configPath) {
 *   console.error('No ts-forge.config.json found');
 *   process.exit(1);
 * }
 * ```
 */
export function findConfigFile(startDir: string): string | null {
  let dir = path.resolve(startDir);
  while (true) {
    const candidate = path.join(dir, CONFIG_FILENAME);
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Loads and parses a TSF configuration file.
 *
 * @param configPath - Absolute path to ts-forge.config.json
 * @returns Parsed configuration object
 * @throws {Error} If file cannot be read or contains invalid JSON
 */
export function loadConfig(configPath: string): TsForgeConfig {
  const raw = fs.readFileSync(configPath, 'utf-8');
  return JSON.parse(raw) as TsForgeConfig;
}

/**
 * Loads per-package configuration overrides.
 * Packages can customize target settings via a `ts-forge.json` file.
 *
 * @param packageDir - Absolute path to package directory
 * @returns Override configuration, or null if no override file exists
 *
 * @example
 * ```typescript
 * const override = loadPackageOverride('/workspace/packages/foo');
 * if (override?.targets?.npm?.skip) {
 *   console.log('Package opts out of npm target');
 * }
 * ```
 */
export function loadPackageOverride(packageDir: string): PackageOverride | null {
  const filePath = path.join(packageDir, PACKAGE_CONFIG_FILENAME);
  if (!fs.existsSync(filePath)) return null;
  const raw = fs.readFileSync(filePath, 'utf-8');
  return JSON.parse(raw) as PackageOverride;
}
