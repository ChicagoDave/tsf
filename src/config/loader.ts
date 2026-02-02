import * as fs from 'fs';
import * as path from 'path';
import type { TsForgeConfig, PackageOverride } from '../types';

const CONFIG_FILENAME = 'ts-forge.config.json';
const PACKAGE_CONFIG_FILENAME = 'ts-forge.json';

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

export function loadConfig(configPath: string): TsForgeConfig {
  const raw = fs.readFileSync(configPath, 'utf-8');
  return JSON.parse(raw) as TsForgeConfig;
}

export function loadPackageOverride(packageDir: string): PackageOverride | null {
  const filePath = path.join(packageDir, PACKAGE_CONFIG_FILENAME);
  if (!fs.existsSync(filePath)) return null;
  const raw = fs.readFileSync(filePath, 'utf-8');
  return JSON.parse(raw) as PackageOverride;
}
