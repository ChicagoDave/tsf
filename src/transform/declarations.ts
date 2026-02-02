import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';
import { globSync } from 'glob';
import type { PackageInfo, ResolvedTarget } from '../types';
import * as logger from '../utils/logger';

// Same patterns as imports.ts but for .d.ts content
const IMPORT_EXPORT_RE = /((?:import|export)\s+.*?\s+from\s+)["']([^"']+)["']/g;
const IMPORT_TYPE_RE = /(import\s+type\s+.*?\s+from\s+)["']([^"']+)["']/g;
const REFERENCE_RE = /(\/\/\/\s*<reference\s+types=")([^"]+)("\s*\/>)/g;
const DECLARE_MODULE_RE = /(declare\s+module\s+")([^"]+)(")/g;

export function transformDeclarations(
  pkg: PackageInfo,
  target: ResolvedTarget,
  packages: Map<string, PackageInfo>,
): void {
  if (target.config.imports === 'preserve') return;
  if (target.config.imports !== 'relative') return;
  if (!target.config.declarations) return;

  const outDir = path.resolve(pkg.path, target.config.outDir!);
  if (!fs.existsSync(outDir)) return;

  const dtsFiles = globSync('**/*.d.ts', { cwd: outDir, absolute: true });
  const context = `${pkg.name}:${target.name}`;

  for (const file of dtsFiles) {
    let content = fs.readFileSync(file, 'utf-8');
    let changed = false;

    // Rewrite import/export from specifiers
    content = content.replace(IMPORT_EXPORT_RE, (match, prefix: string, specifier: string) => {
      const rewritten = rewriteSpecifier(specifier, file, pkg, target, packages);
      if (rewritten !== specifier) {
        changed = true;
        return `${prefix}"${rewritten}"`;
      }
      return match;
    });

    // Rewrite import type specifiers
    content = content.replace(IMPORT_TYPE_RE, (match, prefix: string, specifier: string) => {
      const rewritten = rewriteSpecifier(specifier, file, pkg, target, packages);
      if (rewritten !== specifier) {
        changed = true;
        return `${prefix}"${rewritten}"`;
      }
      return match;
    });

    // Rewrite /// <reference types="..." />
    content = content.replace(REFERENCE_RE, (match, prefix: string, specifier: string, suffix: string) => {
      const rewritten = rewriteSpecifier(specifier, file, pkg, target, packages);
      if (rewritten !== specifier) {
        changed = true;
        return `${prefix}${rewritten}${suffix}`;
      }
      return match;
    });

    // Rewrite declare module "..."
    content = content.replace(DECLARE_MODULE_RE, (match, prefix: string, specifier: string, suffix: string) => {
      const rewritten = rewriteSpecifier(specifier, file, pkg, target, packages);
      if (rewritten !== specifier) {
        changed = true;
        return `${prefix}${rewritten}${suffix}`;
      }
      return match;
    });

    if (changed) {
      fs.writeFileSync(file, content, 'utf-8');
      logger.verbose(`Rewrote declarations in ${path.relative(outDir, file)}`, context);
    }

    // Apply extension mapping to .d.ts files
    if (target.config.extensionMap) {
      applyExtensionMap(file, target.config.extensionMap, outDir, context);
    }
  }

  // Fix up .d.ts.map files
  const mapFiles = globSync('**/*.d.ts.map', { cwd: outDir, absolute: true });
  for (const mapFile of mapFiles) {
    fixupDeclarationMap(mapFile, pkg, target, outDir, context);
  }
}

function rewriteSpecifier(
  specifier: string,
  fromFile: string,
  currentPkg: PackageInfo,
  target: ResolvedTarget,
  packages: Map<string, PackageInfo>,
): string {
  const depPkg = findMatchingPackage(specifier, packages);
  if (!depPkg) return specifier;

  if (target.config.relativeMode === 'peer') return specifier;

  const depOutDir = path.resolve(depPkg.path, target.config.outDir!);
  const depOutputEntry = getOutputEntryPoint(depPkg);
  const depOutputFile = path.join(depOutDir, depOutputEntry);

  let relativePath = path.relative(path.dirname(fromFile), depOutputFile);
  if (!relativePath.startsWith('.')) relativePath = './' + relativePath;
  // Remove .d.ts extension — TypeScript resolves without it
  relativePath = relativePath.replace(/\.d\.ts$/, '');
  return relativePath.replace(/\\/g, '/');
}

function getOutputEntryPoint(pkg: PackageInfo): string {
  let rootDir = 'src';
  try {
    const configFile = ts.readConfigFile(pkg.tsconfig, ts.sys.readFile);
    if (configFile.config?.compilerOptions?.rootDir) {
      rootDir = configFile.config.compilerOptions.rootDir;
    }
  } catch {
    // Fall back to default
  }

  let entry = pkg.entryPoint;
  const rootDirPrefix = rootDir.replace(/\/$/, '') + '/';
  if (entry.startsWith(rootDirPrefix)) {
    entry = entry.slice(rootDirPrefix.length);
  } else if (entry === rootDir) {
    entry = '';
  }

  return entry.replace(/\.tsx?$/, '.d.ts');
}

function findMatchingPackage(specifier: string, packages: Map<string, PackageInfo>): PackageInfo | undefined {
  if (packages.has(specifier)) return packages.get(specifier);
  for (const [name, pkg] of packages) {
    if (specifier.startsWith(name + '/')) return pkg;
  }
  return undefined;
}

function applyExtensionMap(
  file: string,
  extensionMap: Record<string, string>,
  outDir: string,
  context: string,
): void {
  for (const [from, to] of Object.entries(extensionMap)) {
    if (file.endsWith(from)) {
      const newFile = file.slice(0, -from.length) + to;
      fs.renameSync(file, newFile);
      logger.verbose(`Renamed ${path.relative(outDir, file)} → ${path.relative(outDir, newFile)}`, context);
      break;
    }
  }
}

function fixupDeclarationMap(
  mapFile: string,
  pkg: PackageInfo,
  target: ResolvedTarget,
  outDir: string,
  context: string,
): void {
  try {
    const raw = fs.readFileSync(mapFile, 'utf-8');
    const map = JSON.parse(raw);

    // Adjust sources to point to original source relative to this output location
    if (Array.isArray(map.sources)) {
      const mapDir = path.dirname(mapFile);
      map.sources = map.sources.map((source: string) => {
        // Recompute relative path from map location to source
        const absSource = path.resolve(mapDir, source);
        return path.relative(mapDir, absSource).replace(/\\/g, '/');
      });
    }

    // Update file field if extension mapping applies
    if (target.config.extensionMap && typeof map.file === 'string') {
      for (const [from, to] of Object.entries(target.config.extensionMap)) {
        if (map.file.endsWith(from)) {
          map.file = map.file.slice(0, -from.length) + to;
          break;
        }
      }
    }

    fs.writeFileSync(mapFile, JSON.stringify(map), 'utf-8');
    logger.verbose(`Fixed declaration map ${path.relative(outDir, mapFile)}`, context);
  } catch {
    logger.warn(`Could not fix declaration map: ${mapFile}`, context);
  }
}
