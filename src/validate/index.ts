import * as fs from 'fs';
import * as path from 'path';
import type { PackageInfo, ResolvedTarget } from '../types';
import { shouldSkipTarget } from '../orchestrator';
import * as logger from '../utils/logger';

export interface ValidationIssue {
  level: 'error' | 'warning';
  message: string;
  file?: string;
  fix?: string;
}

export function validatePackageOutputs(
  pkg: PackageInfo,
  targets: ResolvedTarget[],
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  // Read package.json
  const pkgJsonPath = path.join(pkg.path, 'package.json');
  if (!fs.existsSync(pkgJsonPath)) return issues;
  const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8'));

  // Check "main" field
  if (pkgJson.main) {
    const mainPath = path.resolve(pkg.path, pkgJson.main);
    if (!fs.existsSync(mainPath)) {
      issues.push({
        level: 'error',
        message: `"main" points to "${pkgJson.main}" which does not exist`,
        file: pkgJsonPath,
        fix: 'Run "tsf build" to generate output, or update "main" field',
      });
    }
  }

  // Check "types" field
  if (pkgJson.types || pkgJson.typings) {
    const typesField = pkgJson.types || pkgJson.typings;
    const typesPath = path.resolve(pkg.path, typesField);
    if (!fs.existsSync(typesPath)) {
      issues.push({
        level: 'error',
        message: `"types" points to "${typesField}" which does not exist`,
        file: pkgJsonPath,
        fix: 'Run "tsf build" with declarations enabled, or update "types" field',
      });
    }
  }

  // Check "module" field
  if (pkgJson.module) {
    const modulePath = path.resolve(pkg.path, pkgJson.module);
    if (!fs.existsSync(modulePath)) {
      issues.push({
        level: 'error',
        message: `"module" points to "${pkgJson.module}" which does not exist`,
        file: pkgJsonPath,
        fix: 'Run "tsf build" to generate ESM output, or update "module" field',
      });
    }
  }

  // Check "exports" field
  if (pkgJson.exports && typeof pkgJson.exports === 'object') {
    validateExports(pkg, pkgJson.exports, issues, pkgJsonPath);
  }

  // Check "bin" field
  if (pkgJson.bin) {
    const bins = typeof pkgJson.bin === 'string'
      ? { [pkgJson.name || 'bin']: pkgJson.bin }
      : pkgJson.bin;
    for (const [name, binPath] of Object.entries(bins as Record<string, string>)) {
      const resolved = path.resolve(pkg.path, binPath);
      if (!fs.existsSync(resolved)) {
        issues.push({
          level: 'error',
          message: `bin "${name}" points to "${binPath}" which does not exist`,
          file: pkgJsonPath,
          fix: 'Run "tsf build" to generate CLI output',
        });
      }
    }
  }

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

function validateExports(
  pkg: PackageInfo,
  exports: Record<string, unknown>,
  issues: ValidationIssue[],
  pkgJsonPath: string,
): void {
  for (const [key, value] of Object.entries(exports)) {
    if (typeof value === 'string') {
      const resolved = path.resolve(pkg.path, value);
      if (!fs.existsSync(resolved)) {
        issues.push({
          level: 'error',
          message: `exports["${key}"] points to "${value}" which does not exist`,
          file: pkgJsonPath,
          fix: 'Run "tsf build" or update exports field',
        });
      }
    } else if (value && typeof value === 'object') {
      const conditions = value as Record<string, unknown>;
      for (const [cond, condPath] of Object.entries(conditions)) {
        if (typeof condPath !== 'string') continue;
        const resolved = path.resolve(pkg.path, condPath);
        if (!fs.existsSync(resolved)) {
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

function checkWorkspaceSpecifiers(outDir: string, issues: ValidationIssue[], targetName: string): void {
  const jsFiles = findFiles(outDir, '.js');
  // Match typical workspace patterns: @scope/package in require() or from ''
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
