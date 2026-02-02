#!/usr/bin/env node

import type { BuildOptions } from '../types';
import { build, buildWatch, check, info, loadBuildContextPublic, shouldSkipTarget } from '../orchestrator';
import { init } from './init';
import { generateGitHubAction } from './gh-action';
import { syncPackageJson } from '../sync/package-json';
import { runValidation } from '../validate';
import { setVerbose } from '../utils/logger';
import * as logger from '../utils/logger';
import { handleVersion } from './version';
import { handlePublish } from './publish';
import { handleList } from './list';
import { handleChanged } from './changed';

const VERSION = '0.1.0';

function main(): void {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || command === '--help' || command === '-h') {
    printHelp();
    return;
  }

  if (command === '--version' || command === '-v') {
    console.log(VERSION);
    return;
  }

  const subArgs = args.slice(1);
  const wantsHelp = subArgs.includes('--help') || subArgs.includes('-h');

  switch (command) {
    case 'build':
      if (wantsHelp) { printBuildHelp(); return; }
      handleBuild(subArgs);
      break;
    case 'check':
      if (wantsHelp) { printCommandHelp('check', 'Run type checking only (no emit).'); return; }
      handleCheck();
      break;
    case 'info':
      if (wantsHelp) { printCommandHelp('info', 'Display resolved build plan: packages, dependency order, and targets.'); return; }
      info();
      break;
    case 'init':
      if (wantsHelp) { printCommandHelp('init', 'Generate ts-forge.config.json by detecting existing project structure.\nSafe to re-run — merges new targets without overwriting existing config.'); return; }
      init();
      break;
    case 'sync':
      if (wantsHelp) { printCommandHelp('sync', 'Generate main, types, and exports fields in each package\'s package.json\nfrom target configuration. Preserves all other fields.'); return; }
      handleSync();
      break;
    case 'validate':
      if (wantsHelp) { printValidateHelp(); return; }
      handleValidate();
      break;
    case 'gh-action':
      if (wantsHelp) { printCommandHelp('gh-action', 'Generate .github/workflows/tsf.yml with auto-detected package manager\nand Node.js version matrix.'); return; }
      generateGitHubAction();
      break;
    case 'version':
      if (wantsHelp) { printVersionHelp(); return; }
      handleVersion(subArgs);
      break;
    case 'publish':
      if (wantsHelp) { printPublishHelp(); return; }
      handlePublish(subArgs);
      break;
    case 'list':
      if (wantsHelp) { printListHelp(); return; }
      handleList(subArgs);
      break;
    case 'changed':
      if (wantsHelp) { printChangedHelp(); return; }
      handleChanged(subArgs);
      break;
    default:
      logger.error(`Unknown command: ${command}`);
      printHelp();
      process.exit(1);
  }
}

function handleBuild(args: string[]): void {
  const options = parseBuildOptions(args);
  const doSync = args.includes('--sync-package-json');
  setVerbose(!!options.verbose);

  if (options.watch) {
    buildWatch(options);
    return;
  }

  build(options).then((success) => {
    if (!success) process.exit(1);
    if (doSync) handleSync();
  });
}

function handleSync(): void {
  const ctx = loadBuildContextPublic();
  if (!ctx) return;

  for (const pkg of ctx.packages.values()) {
    const applicableTargets = ctx.targets.filter((t) => !shouldSkipTarget(pkg, t));
    syncPackageJson(pkg, applicableTargets);
  }
}

function handleValidate(): void {
  const ctx = loadBuildContextPublic();
  if (!ctx) return;

  const valid = runValidation(ctx.packages, ctx.targets);
  if (!valid) process.exit(1);
}

function handleCheck(): void {
  const success = check();
  if (!success) process.exit(1);
}

function parseBuildOptions(args: string[]): BuildOptions {
  const options: BuildOptions = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case '--target':
        options.target = args[++i]?.split(',');
        break;
      case '--condition':
        options.condition = args[++i]?.split(',');
        break;
      case '--all':
        options.all = true;
        break;
      case '--check':
        options.check = true;
        break;
      case '--no-check':
        options.noCheck = true;
        break;
      case '--clean':
        options.clean = true;
        break;
      case '--verbose':
        options.verbose = true;
        break;
      case '--watch':
        options.watch = true;
        break;
      case '--parallel': {
        const val = parseInt(args[++i], 10);
        if (!isNaN(val)) options.parallel = val;
        break;
      }
      case '--npm':
        options.npm = true;
        break;
      case '--local':
        // Explicit local mode (default behavior)
        break;
      case '--sync-package-json':
        // Handled separately in handleBuild
        break;
      default:
        logger.warn(`Unknown option: ${arg}`);
    }
  }

  return options;
}

function printCommandHelp(command: string, description: string): void {
  console.log(`\nts-forge ${command}\n\n${description}\n`);
}

function printBuildHelp(): void {
  console.log(`
ts-forge build — Build targets across all packages in dependency order.

Usage:
  ts-forge build [options]

Modes:
  --local               Build for local dev (default) — compiles to dist/
  --npm                 Build for npm publish — compiles to staging dir
                        (~/.tsf-publish/) with relative imports and clean
                        package.json. Run "tsf publish" after to publish.

Options:
  --target <name>       Build specific target(s), comma-separated
  --condition <name>    Build targets matching condition
  --all                 Build all targets (default: unconditional only)
  --check               Enable type checking before build
  --no-check            Skip type checking
  --clean               Remove output dirs before build
  --verbose             Show detailed output
  --watch               Watch mode — rebuild on file changes
  --parallel <n>        Max parallel builds (default: CPU count)
  --sync-package-json   Update package.json fields after build
`.trim());
}

function printVersionHelp(): void {
  console.log(`
ts-forge version — Set or bump version in package.json for workspace packages.

Usage:
  ts-forge version <version> [options]
  ts-forge version --bump <level> [options]

Options:
  <version>             Explicit version string (e.g., 0.9.64-beta)
  --bump <level>        Semver increment: major, minor, patch, prerelease
  --preid <tag>         Prerelease identifier (default: beta)
  --condition <name>    Only packages matching target condition (e.g., publish)
  --filter <name>       Restrict to specific package(s), repeatable
  --changed             Only bump packages that changed since last publish
  --dry-run             Show changes without writing

Examples:
  ts-forge version 0.9.64-beta --condition publish
  ts-forge version 0.9.64-beta --changed --condition publish
  ts-forge version --bump patch
  ts-forge version --bump prerelease --preid beta --dry-run
`.trim());
}

function printChangedHelp(): void {
  console.log(`
ts-forge changed — Show packages that changed since their last npm publish.

Usage:
  ts-forge changed [options]

Compares each package against the npm registry. A package is "changed" if:
  - It has never been published
  - Its local version differs from the published version
  - It has git changes since the version tag

Options:
  --condition <name>    Only packages matching target condition (e.g., publish)
  --filter <name>       Restrict to specific package(s), repeatable

Examples:
  ts-forge changed --condition publish
`.trim());
}

function printListHelp(): void {
  console.log(`
ts-forge list — List workspace packages, one per line.

Usage:
  ts-forge list [options]

Output is in dependency order. Useful for scripting and verifying which
packages match a condition.

Options:
  --condition <name>    Only packages matching target condition (e.g., publish)
  --filter <name>       Restrict to specific package(s), repeatable

Examples:
  ts-forge list
  ts-forge list --condition publish
`.trim());
}

function printPublishHelp(): void {
  console.log(`
ts-forge publish — Publish workspace packages to npm from staging directory.

Usage:
  ts-forge publish [options]

Packs tarballs from ~/.tsf-publish/ and publishes to npm.
Requires "tsf build --npm" to have been run first.
Publishes in dependency order.

Options:
  --tag <tag>           npm dist-tag (default: latest)
  --condition <name>    Only packages matching target condition (e.g., publish)
  --filter <name>       Restrict to specific package(s), repeatable
  --changed             Only publish packages with version > npm registry
  --dry-run             Pass --dry-run to npm publish

Examples:
  ts-forge build --npm && ts-forge publish
  ts-forge publish --tag latest
  ts-forge publish --changed --dry-run
`.trim());
}

function printValidateHelp(): void {
  console.log(`
ts-forge validate — Verify build outputs.

Checks:
  - Entry points declared in package.json exist on disk
  - Declaration files (.d.ts) exist alongside JavaScript files
  - No workspace specifiers leaked into non-preserve output

Exit code 1 if any errors found.
`.trim());
}

function printHelp(): void {
  console.log(`
ts-forge — Multi-target TypeScript build tool

Usage:
  ts-forge build [options]    Build targets
  ts-forge check              Run type checking only
  ts-forge init               Generate ts-forge.config.json
  ts-forge sync               Sync package.json fields from targets
  ts-forge validate           Validate build outputs
  ts-forge gh-action          Generate GitHub Actions workflow
  ts-forge version <ver>      Set version for all packages
  ts-forge version --bump <level>  Bump version (major|minor|patch|prerelease)
  ts-forge publish            Publish packages to npm
  ts-forge list               List packages (one per line)
  ts-forge changed            Show packages changed since last publish
  ts-forge info               Show resolved build plan

Build Options:
  --target <name>       Build specific target(s), comma-separated
  --condition <name>    Build targets matching condition
  --all                 Build all targets
  --check               Enable type checking before build
  --no-check            Skip type checking
  --clean               Remove output dirs before build
  --verbose             Show detailed output
  --watch               Watch mode — rebuild on file changes
  --parallel <n>        Max parallel builds (default: CPU count)
  --sync-package-json   Update package.json fields after build

General:
  --help, -h            Show this help
  --version, -v         Show version
`.trim());
}

main();
