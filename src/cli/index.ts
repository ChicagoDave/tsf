#!/usr/bin/env node

import type { BuildOptions } from '../types';
import { build, buildWatch, check, info, loadBuildContextPublic, shouldSkipTarget } from '../orchestrator';
import { init } from './init';
import { generateGitHubAction } from './gh-action';
import { syncPackageJson } from '../sync/package-json';
import { runValidation } from '../validate';
import { setVerbose } from '../utils/logger';
import * as logger from '../utils/logger';

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

  switch (command) {
    case 'build':
      handleBuild(args.slice(1));
      break;
    case 'check':
      handleCheck();
      break;
    case 'info':
      info();
      break;
    case 'init':
      init();
      break;
    case 'sync':
      handleSync();
      break;
    case 'validate':
      handleValidate();
      break;
    case 'gh-action':
      generateGitHubAction();
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
      case '--sync-package-json':
        // Handled separately in handleBuild
        break;
      default:
        logger.warn(`Unknown option: ${arg}`);
    }
  }

  return options;
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
