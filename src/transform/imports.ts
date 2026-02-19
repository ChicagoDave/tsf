/**
 * @fileoverview Import specifier rewriting for JavaScript output
 * @module tsf/transform/imports
 *
 * Rewrites workspace package imports (`@scope/pkg`) to relative paths in
 * compiled JavaScript files. This is the key transformation that enables
 * npm publishing — published packages must use relative imports since
 * workspace symlinks don't exist in consumer environments.
 *
 * Handles all JavaScript import patterns:
 * - CommonJS: `require("@scope/pkg")`
 * - ESM: `import foo from "@scope/pkg"`
 * - Re-exports: `export { bar } from "@scope/pkg"`
 * - Side effects: `import "@scope/pkg"`
 * - Deep imports: `@scope/pkg/utils` → `../pkg/dist/utils.js`
 *
 * @example
 * Before: `import { utils } from "@scope/core";`
 * After:  `import { utils } from "../core/dist/index.js";`
 */

import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';
import { globSync } from 'glob';
import type { PackageInfo, ResolvedTarget } from '../types';
import * as logger from '../utils/logger';

// ============================================================================
// Import Pattern Regular Expressions
// ============================================================================

/**
 * Matches CommonJS require calls.
 * Captures: require("specifier") or require('specifier')
 */
const REQUIRE_RE = /require\(["']([^"']+)["']\)/g;

/**
 * Matches ESM import/export with `from` clause.
 * Captures: import/export ... from "specifier"
 */
const ESM_FROM_RE = /((?:import|export)\s+.*?\s+from\s+)["']([^"']+)["']/g;

/**
 * Matches side-effect imports (no bindings).
 * Captures: import "specifier"
 */
const ESM_SIDE_EFFECT_RE = /(import\s+)["']([^"']+)["']/g;

// ============================================================================
// Public API
// ============================================================================

/**
 * Rewrites workspace imports to relative paths in all JavaScript files.
 * Only processes targets with `imports: "relative"`.
 *
 * @param pkg - Package being transformed
 * @param target - Build target configuration
 * @param packages - All workspace packages (for resolving imports)
 *
 * @example
 * ```typescript
 * transformImports(corePackage, npmTarget, allPackages);
 * // All @scope/* imports in core's dist/ are now relative paths
 * ```
 */
export function transformImports(
  pkg: PackageInfo,
  target: ResolvedTarget,
  packages: Map<string, PackageInfo>,
): void {
  if (target.config.imports === 'preserve') return;
  if (target.config.imports !== 'relative') return; // bundle/specifier-map handled in later phases

  const outDir = path.resolve(pkg.path, target.config.outDir!);
  if (!fs.existsSync(outDir)) return;

  const jsFiles = globSync('**/*.js', { cwd: outDir, absolute: true });
  const context = `${pkg.name}:${target.name}`;

  for (const file of jsFiles) {
    let content = fs.readFileSync(file, 'utf-8');
    let changed = false;

    content = content.replace(REQUIRE_RE, (match, specifier: string) => {
      const rewritten = rewriteSpecifier(specifier, file, pkg, target, packages);
      if (rewritten !== specifier) {
        changed = true;
        return `require("${rewritten}")`;
      }
      return match;
    });

    content = content.replace(ESM_FROM_RE, (match, prefix: string, specifier: string) => {
      const rewritten = rewriteSpecifier(specifier, file, pkg, target, packages);
      if (rewritten !== specifier) {
        changed = true;
        return `${prefix}"${rewritten}"`;
      }
      return match;
    });

    content = content.replace(ESM_SIDE_EFFECT_RE, (match, prefix: string, specifier: string) => {
      const rewritten = rewriteSpecifier(specifier, file, pkg, target, packages);
      if (rewritten !== specifier) {
        changed = true;
        return `${prefix}"${rewritten}"`;
      }
      return match;
    });

    if (changed) {
      fs.writeFileSync(file, content, 'utf-8');
      logger.verbose(`Rewrote imports in ${path.relative(outDir, file)}`, context);
    }
  }
}

// ============================================================================
// Internal Helpers
// ============================================================================

/**
 * Rewrites a single import specifier to a relative path.
 *
 * @param specifier - Original import specifier (e.g., "@scope/pkg")
 * @param fromFile - Absolute path to the file containing this import
 * @param currentPkg - Package being transformed
 * @param target - Build target configuration
 * @param packages - All workspace packages
 * @returns Rewritten specifier (relative path) or original if not a workspace import
 */
function rewriteSpecifier(
  specifier: string,
  fromFile: string,
  currentPkg: PackageInfo,
  target: ResolvedTarget,
  packages: Map<string, PackageInfo>,
): string {
  // Check if specifier matches a workspace package
  // Handle both exact matches (@scope/pkg) and deep imports (@scope/pkg/foo)
  const depPkg = findMatchingPackage(specifier, packages);
  if (!depPkg) return specifier;

  if (target.config.relativeMode === 'peer') {
    // In peer mode, keep the specifier as-is (assumes installed as dependency)
    return specifier;
  }

  // Compute relative path from this output file to the dependency's output entry point
  // The output path = entryPoint relative to the dep's rootDir (tsc strips rootDir prefix)
  const depOutDir = path.resolve(depPkg.path, target.config.outDir!);
  const depOutputEntry = getOutputEntryPoint(depPkg);
  const depOutputFile = path.join(depOutDir, depOutputEntry);

  let relativePath = path.relative(path.dirname(fromFile), depOutputFile);
  if (!relativePath.startsWith('.')) {
    relativePath = './' + relativePath;
  }

  // Normalize to forward slashes (cross-platform)
  relativePath = relativePath.replace(/\\/g, '/');

  // Handle deep imports: @scope/pkg/sub → relative to dep outDir + sub
  const subpath = getSubpath(specifier, depPkg.name);
  if (subpath) {
    const subOutputFile = path.join(depOutDir, subpath.replace(/\.tsx?$/, '.js'));
    let subRelative = path.relative(path.dirname(fromFile), subOutputFile);
    if (!subRelative.startsWith('.')) subRelative = './' + subRelative;
    return subRelative.replace(/\\/g, '/');
  }

  return relativePath;
}

/**
 * Finds the workspace package matching an import specifier.
 * Handles both exact matches and deep imports.
 *
 * @param specifier - Import specifier to match
 * @param packages - All workspace packages
 * @returns Matching package, or undefined if not a workspace import
 *
 * @example
 * findMatchingPackage("@scope/core", packages) → PackageInfo for @scope/core
 * findMatchingPackage("@scope/core/utils", packages) → PackageInfo for @scope/core
 * findMatchingPackage("lodash", packages) → undefined (external)
 */
function findMatchingPackage(specifier: string, packages: Map<string, PackageInfo>): PackageInfo | undefined {
  // Exact match
  if (packages.has(specifier)) return packages.get(specifier);

  // Scoped package deep import: @scope/pkg/sub
  for (const [name, pkg] of packages) {
    if (specifier.startsWith(name + '/')) return pkg;
  }

  return undefined;
}

/**
 * Computes the output-relative path for a package's entry point.
 *
 * TypeScript's tsc strips the `rootDir` prefix when outputting files.
 * For example, with `rootDir: "src"`:
 * - Source: `src/index.ts`
 * - Output: `dist/index.js` (not `dist/src/index.js`)
 *
 * This function replicates that logic to compute where the entry point
 * will be in the output directory.
 *
 * @param pkg - Package to compute entry point for
 * @returns Output entry point path relative to outDir
 */
function getOutputEntryPoint(pkg: PackageInfo): string {
  let rootDir = 'src'; // default assumption
  try {
    const configFile = ts.readConfigFile(pkg.tsconfig, ts.sys.readFile);
    if (configFile.config?.compilerOptions?.rootDir) {
      rootDir = configFile.config.compilerOptions.rootDir;
    }
  } catch {
    // Fall back to default
  }

  let entry = pkg.entryPoint;
  // Strip rootDir prefix (e.g., "src/index.ts" with rootDir "src" → "index.ts")
  const rootDirPrefix = rootDir.replace(/\/$/, '') + '/';
  if (entry.startsWith(rootDirPrefix)) {
    entry = entry.slice(rootDirPrefix.length);
  } else if (entry === rootDir) {
    entry = '';
  }

  return entry.replace(/\.tsx?$/, '.js');
}

/**
 * Extracts the subpath from a deep import.
 *
 * @param specifier - Full import specifier
 * @param packageName - Package name to strip
 * @returns Subpath after package name, or null if exact match
 *
 * @example
 * getSubpath("@scope/pkg/utils", "@scope/pkg") → "utils"
 * getSubpath("@scope/pkg", "@scope/pkg") → null
 */
function getSubpath(specifier: string, packageName: string): string | null {
  if (specifier === packageName) return null;
  if (specifier.startsWith(packageName + '/')) {
    return specifier.slice(packageName.length + 1);
  }
  return null;
}
