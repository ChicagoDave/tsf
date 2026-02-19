/**
 * @fileoverview Declaration file (.d.ts) import rewriting
 * @module tsf/transform/declarations
 *
 * Rewrites workspace package imports in TypeScript declaration files.
 * This complements `transform/imports.ts` — both JS and .d.ts files must
 * have matching import paths for consumers to get proper type resolution.
 *
 * Handles declaration-specific patterns:
 * - `import type { Foo } from "@scope/pkg"`
 * - `export { Bar } from "@scope/pkg"`
 * - `/// <reference types="@scope/pkg" />`
 * - `declare module "@scope/pkg" { ... }`
 *
 * Also handles:
 * - Extension mapping (.d.ts → .d.mts for ESM)
 * - Source map fixup for declaration maps
 *
 * @example
 * Before: `import type { Config } from "@scope/core";`
 * After:  `import type { Config } from "../core/dist/index";`
 */

import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';
import { globSync } from 'glob';
import type { PackageInfo, ResolvedTarget } from '../types';
import * as logger from '../utils/logger';

// ============================================================================
// Declaration Import Pattern Regular Expressions
// ============================================================================

/** Matches import/export ... from "specifier" */
const IMPORT_EXPORT_RE = /((?:import|export)\s+.*?\s+from\s+)["']([^"']+)["']/g;

/** Matches import type ... from "specifier" */
const IMPORT_TYPE_RE = /(import\s+type\s+.*?\s+from\s+)["']([^"']+)["']/g;

/** Matches /// <reference types="specifier" /> */
const REFERENCE_RE = /(\/\/\/\s*<reference\s+types=")([^"]+)("\s*\/>)/g;

/** Matches declare module "specifier" { ... } */
const DECLARE_MODULE_RE = /(declare\s+module\s+")([^"]+)(")/g;

// ============================================================================
// Public API
// ============================================================================

/**
 * Rewrites workspace imports in all declaration files.
 * Only processes targets with `imports: "relative"` and `declarations: true`.
 *
 * @param pkg - Package being transformed
 * @param target - Build target configuration
 * @param packages - All workspace packages (for resolving imports)
 *
 * @example
 * ```typescript
 * transformDeclarations(corePackage, npmTarget, allPackages);
 * // All @scope/* imports in core's .d.ts files are now relative paths
 * ```
 */
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

// ============================================================================
// Internal Helpers
// ============================================================================

/**
 * Rewrites a single import specifier to a relative path.
 * Similar to imports.ts but outputs paths without extension
 * (TypeScript resolves .d.ts automatically).
 *
 * @param specifier - Original import specifier
 * @param fromFile - Absolute path to the .d.ts file containing this import
 * @param currentPkg - Package being transformed
 * @param target - Build target configuration
 * @param packages - All workspace packages
 * @returns Rewritten specifier or original if not a workspace import
 */
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

/**
 * Computes the output declaration file path for a package's entry point.
 * Mirrors getOutputEntryPoint in imports.ts but returns .d.ts extension.
 *
 * @param pkg - Package to compute entry point for
 * @returns Output .d.ts path relative to outDir
 */
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

/**
 * Finds the workspace package matching an import specifier.
 * @see imports.ts findMatchingPackage for details
 */
function findMatchingPackage(specifier: string, packages: Map<string, PackageInfo>): PackageInfo | undefined {
  if (packages.has(specifier)) return packages.get(specifier);
  for (const [name, pkg] of packages) {
    if (specifier.startsWith(name + '/')) return pkg;
  }
  return undefined;
}

/**
 * Applies extension mapping to rename declaration files.
 * Used for ESM targets that require .d.mts extensions.
 *
 * @param file - Absolute path to declaration file
 * @param extensionMap - Mapping of old → new extensions
 * @param outDir - Output directory (for logging)
 * @param context - Logging context
 *
 * @example
 * With extensionMap: { ".d.ts": ".d.mts" }
 * `foo.d.ts` → `foo.d.mts`
 */
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

/**
 * Fixes source paths in declaration map files (.d.ts.map).
 * After import rewriting, source map paths may need adjustment.
 * Also updates the `file` field if extension mapping was applied.
 *
 * @param mapFile - Path to .d.ts.map file
 * @param pkg - Package being processed
 * @param target - Build target configuration
 * @param outDir - Output directory (for logging)
 * @param context - Logging context
 */
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

    // Normalize source paths relative to map location
    if (Array.isArray(map.sources)) {
      const mapDir = path.dirname(mapFile);
      map.sources = map.sources.map((source: string) => {
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
