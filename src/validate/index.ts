/**
 * @fileoverview Build output validation
 * @module tsf/validate
 *
 * Validates that build outputs are complete and correct before publish.
 * Catches common issues:
 * - Missing files referenced in package.json (main, types, exports, bin)
 * - Missing .d.ts files alongside .js (declaration parity)
 * - Workspace specifiers left in output (import rewriting failures)
 *
 * Run with `tsf validate` to check outputs before publishing.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { PackageInfo, ResolvedTarget } from '../types';
import { shouldSkipTarget } from '../orchestrator';
import * as logger from '../utils/logger';

/**
 * A validation issue found in build outputs.
 */
export interface ValidationIssue {
  /** Severity: 'error' prevents publish, 'warning' is informational */
  level: 'error' | 'warning';
  /** Human-readable description of the issue */
  message: string;
  /** Path to the problematic file (if applicable) */
  file?: string;
  /** Suggested fix for the issue */
  fix?: string;
}

/**
 * Validates build outputs for a single package.
 *
 * Checks:
 * 1. `main` field points to existing file
 * 2. `types`/`typings` field points to existing file
 * 3. `module` field points to existing file
 * 4. All `exports` conditions resolve to existing files
 * 5. All `bin` entries point to existing files
 * 6. Every .js file has a corresponding .d.ts (if declarations enabled)
 * 7. No workspace specifiers remain in output (if imports != preserve)
 *
 * @param pkg - Package to validate
 * @param targets - Build targets to check
 * @returns Array of validation issues (empty = valid)
 */
export function validatePackageOutputs(
  pkg: PackageInfo,
  targets: ResolvedTarget[],
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  // Read package.json
  const pkgJsonPath = path.join(pkg.path, 'package.json');
  if (!fs.existsSync(pkgJsonPath)) return issues;
  const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8'));

  // Entry-point existence checks are shared with the staged-manifest publish gate
  // so a field checked here is never left unchecked on the manifest that ships.
  issues.push(...validateManifestTargets(pkgJson, pkg.path, pkgJsonPath));

  // Check that .d.ts files exist alongside .js for targets with declarations
  for (const target of targets) {
    if (!target.config.declarations || !target.config.outDir) continue;
    const outDir = path.resolve(pkg.path, target.config.outDir);
    if (!fs.existsSync(outDir)) continue;

    checkDeclarationParity(outDir, issues, target.name);
  }

  // Check for workspace specifiers remaining in output
  for (const target of targets) {
    if (!target.config.outDir) continue;
    const outDir = path.resolve(pkg.path, target.config.outDir);
    if (!fs.existsSync(outDir)) continue;
    if (target.config.imports === 'preserve') continue; // preserve is intentional

    checkWorkspaceSpecifiers(outDir, issues, target.name);
  }

  return issues;
}

/**
 * Checks every entry-point field in a manifest against a directory tree.
 *
 * The same fields must resolve in two different trees: the source package.json
 * against the package directory (`tsf validate`), and the generated publish
 * manifest against its staging directory (`tsf publish`). Both callers share
 * this implementation, so the source tree and the tarball are held to one
 * standard rather than drifting apart.
 *
 * Wildcard export targets (`./styles/*`) are matched leniently — see
 * {@link exportTargetExists}.
 *
 * @param manifest - Parsed package.json contents (source or staged)
 * @param rootDir - Directory the manifest's relative paths resolve against
 * @param manifestPath - Manifest location, reported on each issue for context
 * @returns One error-level issue per field whose target does not exist
 */
export function validateManifestTargets(
  manifest: Record<string, unknown>,
  rootDir: string,
  manifestPath: string,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  // Check "main" field
  if (manifest.main) {
    const mainPath = path.resolve(rootDir, manifest.main as string);
    if (!fs.existsSync(mainPath)) {
      issues.push({
        level: 'error',
        message: `"main" points to "${manifest.main}" which does not exist`,
        file: manifestPath,
        fix: 'Run "tsf build" to generate output, or update "main" field',
      });
    }
  }

  // Check "types" field
  if (manifest.types || manifest.typings) {
    const typesField = (manifest.types || manifest.typings) as string;
    const typesPath = path.resolve(rootDir, typesField);
    if (!fs.existsSync(typesPath)) {
      issues.push({
        level: 'error',
        message: `"types" points to "${typesField}" which does not exist`,
        file: manifestPath,
        fix: 'Run "tsf build" with declarations enabled, or update "types" field',
      });
    }
  }

  // Check "module" field
  if (manifest.module) {
    const modulePath = path.resolve(rootDir, manifest.module as string);
    if (!fs.existsSync(modulePath)) {
      issues.push({
        level: 'error',
        message: `"module" points to "${manifest.module}" which does not exist`,
        file: manifestPath,
        fix: 'Run "tsf build" to generate ESM output, or update "module" field',
      });
    }
  }

  // Check "exports" field
  if (manifest.exports && typeof manifest.exports === 'object') {
    validateExports(rootDir, manifest.exports as Record<string, unknown>, issues, manifestPath);
  }

  // Check "bin" field
  if (manifest.bin) {
    const bins = typeof manifest.bin === 'string'
      ? { [(manifest.name as string) || 'bin']: manifest.bin }
      : manifest.bin;
    for (const [name, binPath] of Object.entries(bins as Record<string, string>)) {
      const resolved = path.resolve(rootDir, binPath);
      if (!fs.existsSync(resolved)) {
        issues.push({
          level: 'error',
          message: `bin "${name}" points to "${binPath}" which does not exist`,
          file: manifestPath,
          fix: 'Run "tsf build" to generate CLI output',
        });
      }
    }
  }

  return issues;
}

// ============================================================================
// Internal Validation Helpers
// ============================================================================

/**
 * Validates the `exports` field in package.json.
 * Recursively checks all export conditions resolve to existing files.
 */
function validateExports(
  rootDir: string,
  exports: Record<string, unknown>,
  issues: ValidationIssue[],
  pkgJsonPath: string,
): void {
  for (const [key, value] of Object.entries(exports)) {
    if (typeof value === 'string') {
      if (!exportTargetExists(rootDir, value)) {
        issues.push({
          level: 'error',
          message: `exports["${key}"] points to "${value}" which does not exist`,
          file: pkgJsonPath,
          fix: 'Run "tsf build" or update exports field',
        });
      }
    } else if (value && typeof value === 'object') {
      // Conditional exports: { "import": "./esm.js", "require": "./cjs.js" }
      const conditions = value as Record<string, unknown>;
      for (const [cond, condPath] of Object.entries(conditions)) {
        if (typeof condPath !== 'string') continue;
        if (!exportTargetExists(rootDir, condPath)) {
          issues.push({
            level: 'error',
            message: `exports["${key}"].${cond} points to "${condPath}" which does not exist`,
            file: pkgJsonPath,
            fix: 'Run "tsf build" or update exports field',
          });
        }
      }
    }
  }
}

/**
 * Does an exports target path exist? Handles npm subpath patterns: a path
 * containing `*` (e.g. "./styles/*") is a wildcard that npm expands at
 * resolve time, so a literal existence check can never pass. For patterns
 * the check is: at least one file exists under the pattern's static prefix
 * whose path ends with the static suffix. This is deliberately lenient —
 * the goal is catching missing build output, not reimplementing npm's
 * resolver.
 *
 * @param pkgPath - Absolute package directory
 * @param target - The exports target path (may contain one `*`)
 * @returns true if the literal file exists, or the pattern matches ≥1 file
 */
export function exportTargetExists(pkgPath: string, target: string): boolean {
  const starIdx = target.indexOf('*');
  if (starIdx === -1) {
    return fs.existsSync(path.resolve(pkgPath, target));
  }
  const prefix = target.slice(0, starIdx);
  const suffix = target.slice(starIdx + 1);
  // The deepest directory fully specified before the `*` — for "./styles/*"
  // that's "./styles"; for "./dist/chunk-*.js" it's "./dist".
  const prefixDir = path.resolve(
    pkgPath,
    prefix.endsWith('/') ? prefix : path.dirname(prefix),
  );
  if (!fs.existsSync(prefixDir)) return false;
  const stack = [prefixDir];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (suffix === '' || full.endsWith(suffix)) return true;
    }
  }
  return false;
}

/**
 * Filters a workspace package map down to publishable packages — those whose
 * package.json carries a `publishConfig`. Used by `tsf validate --publish` so
 * the publish gate ignores workspace members (stories, fixtures) that are
 * built but never published.
 *
 * @param packages - All workspace packages, keyed by name
 * @returns A new map containing only publishable packages
 */
export function filterPublishablePackages(
  packages: Map<string, PackageInfo>,
): Map<string, PackageInfo> {
  const out = new Map<string, PackageInfo>();
  for (const [name, pkg] of packages) {
    const pkgJsonPath = path.join(pkg.path, 'package.json');
    try {
      const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8'));
      if (pkgJson.publishConfig && pkgJson.private !== true) out.set(name, pkg);
    } catch {
      // unreadable manifest — not publishable
    }
  }
  return out;
}

/**
 * Checks that every .js file has a corresponding .d.ts file.
 * Missing declarations can cause type errors for consumers.
 */
function checkDeclarationParity(outDir: string, issues: ValidationIssue[], targetName: string): void {
  const jsFiles = findFiles(outDir, '.js');
  for (const jsFile of jsFiles) {
    const dtsFile = jsFile.replace(/\.js$/, '.d.ts');
    if (!fs.existsSync(dtsFile)) {
      const rel = path.relative(outDir, jsFile);
      issues.push({
        level: 'warning',
        message: `[${targetName}] Missing declaration file for ${rel}`,
        file: jsFile,
        fix: 'Ensure declarations are enabled for this target',
      });
    }
  }
}

/**
 * Checks for workspace specifiers that weren't rewritten.
 * These would cause runtime failures for npm consumers.
 *
 * Looks for patterns like:
 * - `require("@scope/pkg")`
 * - `from "@scope/pkg"`
 */
function checkWorkspaceSpecifiers(outDir: string, issues: ValidationIssue[], targetName: string): void {
  const jsFiles = findFiles(outDir, '.js');
  // Match scoped packages in import/require statements
  const wsPattern = /(?:require\(['"]|from\s+['"])(@[^/'"]+\/[^/'"]+)/g;

  for (const jsFile of jsFiles) {
    const content = fs.readFileSync(jsFile, 'utf-8');
    let match: RegExpExecArray | null;
    while ((match = wsPattern.exec(content)) !== null) {
      const rel = path.relative(outDir, jsFile);
      issues.push({
        level: 'warning',
        message: `[${targetName}] Workspace specifier "${match[1]}" found in ${rel}`,
        file: jsFile,
        fix: 'Use imports: "relative" or imports: "bundle" to resolve workspace imports',
      });
    }
  }
}

/**
 * Recursively finds all files with a given extension.
 */
function findFiles(dir: string, ext: string): string[] {
  const results: string[] = [];
  if (!fs.existsSync(dir)) return results;

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...findFiles(full, ext));
    } else if (entry.name.endsWith(ext)) {
      results.push(full);
    }
  }
  return results;
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Runs validation across all workspace packages.
 * Logs results and returns success status.
 *
 * @param packages - All workspace packages
 * @param targets - Build targets to validate
 * @returns true if no errors found, false if validation failed
 *
 * @example
 * ```typescript
 * const valid = runValidation(packages, targets);
 * if (!valid) process.exit(1);
 * ```
 */
export function runValidation(
  packages: Map<string, PackageInfo>,
  targets: ResolvedTarget[],
): boolean {
  let hasErrors = false;

  for (const pkg of packages.values()) {
    const applicableTargets = targets.filter((t) => !shouldSkipTarget(pkg, t));
    const issues = validatePackageOutputs(pkg, applicableTargets);
    if (issues.length === 0) {
      logger.success('Outputs valid', pkg.name);
      continue;
    }

    for (const issue of issues) {
      if (issue.level === 'error') {
        hasErrors = true;
        logger.error(issue.message, pkg.name);
      } else {
        logger.warn(issue.message, pkg.name);
      }
      if (issue.fix) {
        logger.verbose(`  Fix: ${issue.fix}`, pkg.name);
      }
    }
  }

  return !hasErrors;
}
