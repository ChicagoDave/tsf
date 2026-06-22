/**
 * @fileoverview Build orchestration and coordination
 * @module tsf/orchestrator
 *
 * The orchestrator is the heart of TSF. It coordinates the entire build process:
 *
 * 1. **Context Loading**: Finds config, resolves packages, computes build order
 * 2. **Target Selection**: Filters targets based on --npm, --target, --condition
 * 3. **Dependency Ordering**: Builds packages level-by-level (parallel within levels)
 * 4. **Caching**: Skips unchanged packages using content-hash cache
 * 5. **Compilation**: Delegates to compiler adapters (tsc, esbuild, rollup)
 * 6. **Transformation**: Rewrites imports and declarations post-compilation
 * 7. **Staging**: For --npm builds, outputs to staging directory with clean manifests
 *
 * ## Build Modes
 *
 * **Local build** (`tsf build`):
 * - Outputs to `dist/` within each package
 * - Preserves workspace imports
 * - For development and local testing
 *
 * **NPM build** (`tsf build --npm`):
 * - Outputs to `~/.tsf-publish/<pkg>/`
 * - Rewrites imports to relative paths
 * - Generates clean package.json (no workspace:* deps)
 * - For npm publish preparation
 *
 * @example
 * ```typescript
 * import { build } from '@davidcornelson/tsf';
 *
 * await build({ target: ['local'] });           // Local dev build
 * await build({ npm: true });                    // NPM publish build
 * await build({ watch: true });                  // Watch mode
 * await build({ check: true, noEmit: true });    // Type check only
 * ```
 */

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import type { TsForgeConfig, BuildOptions, BuildContext, ResolvedTarget, PackageInfo } from '../types';
import { findConfigFile, loadConfig, loadPackageOverride } from '../config/loader';
import { validateConfig } from '../config/validator';
import { resolveTargets, applyPackageOverride } from '../config/defaults';
import { detectWorkspace } from '../resolver/workspace';
import { resolvePackages } from '../resolver/packages';
import { getBuildOrder } from '../resolver/graph';
import { getCompiler, getBundler } from '../compilers';
import { fixBrokenRelativeImports } from '../compilers/tsc';
import { transformImports, transformEsmExtensions } from '../transform/imports';
import { transformDeclarations } from '../transform/declarations';
import { computeCacheKey, isCached, recordBuild, cleanCache } from '../cache';
import { createWatcher } from '../watcher';
import { globSync } from 'glob';
import * as os from 'os';
import * as logger from '../utils/logger';
import { resolvePackageFilters } from '../utils/package-filter';
import { generatePublishManifest } from '../sync/package-json';

/**
 * Returns the staging directory for npm publish builds.
 * Defaults to `~/.tsf-publish/`, configurable via `TSF_PUBLISH_DIR` env var.
 *
 * @returns Absolute path to staging directory
 */
export function getPublishStagingDir(): string {
  return process.env.TSF_PUBLISH_DIR || path.join(os.homedir(), '.tsf-publish');
}

export async function build(options: BuildOptions): Promise<boolean> {
  const ctx = loadBuildContext(options);
  if (!ctx) return false;

  // In --npm mode, select publish targets and override outDirs to staging
  const isNpmBuild = !!options.npm;
  const npmStagingDir = isNpmBuild ? getPublishStagingDir() : undefined;
  let activeTargets: ResolvedTarget[];

  if (isNpmBuild) {
    const publishTargets = ctx.targets.filter(
      (t) => t.config.condition === 'publish' || t.config.imports === 'relative',
    );
    if (publishTargets.length === 0) {
      logger.warn('No publish targets found. Add targets with condition: "publish" or imports: "relative".');
      return true;
    }
    activeTargets = publishTargets;
    logger.info(`npm build → staging to ${npmStagingDir}`);
  } else {
    activeTargets = filterTargets(ctx.targets, options);
    if (activeTargets.length === 0) {
      logger.warn('No targets to build. Use --all, --target, or --condition to select targets.');
      return true;
    }
  }

  // Resolve short package names (e.g., "stdlib" → "@sharpee/stdlib")
  if (options.filter && options.filter.length > 0) {
    options.filter = resolvePackageFilters(options.filter, ctx.packages);
  }

  // Compute applicable packages (respects shouldSkipTarget and --filter)
  const filterNames = options.filter && options.filter.length > 0 ? options.filter : null;
  const applicablePackages = Array.from(ctx.packages.values()).filter(
    (pkg) =>
      (!filterNames || filterNames.includes(pkg.name)) &&
      activeTargets.some((t) => !shouldSkipTarget(pkg, t)),
  );
  const applicableNames = new Set(applicablePackages.map((p) => p.name));
  logger.info(`Building ${activeTargets.map((t) => t.name).join(', ')} across ${applicablePackages.length} package(s)`);

  // Type check if requested
  if (options.check) {
    logger.info('Running type check...');
    if (!runTypeCheck(ctx.rootDir)) return false;
    logger.success('Type check passed');
  }

  // Clean if requested
  if (options.clean) {
    for (const target of activeTargets) {
      for (const pkg of ctx.packages.values()) {
        if (target.config.outDir) {
          const outDir = path.resolve(pkg.path, target.config.outDir);
          if (fs.existsSync(outDir)) {
            fs.rmSync(outDir, { recursive: true });
            logger.verbose(`Cleaned ${outDir}`, `${pkg.name}:${target.name}`);
          }
        }
      }
    }
  }

  // Cache setup
  const cacheDir = path.join(ctx.rootDir, '.tsf-cache');
  const useCache = !options.clean;
  // Track cache keys per package (across all targets, keyed as "pkg:target")
  const cacheKeys = new Map<string, string>();

  // Parallelism setup
  const maxParallel = options.parallel ?? os.cpus().length;

  // Build in dependency order
  let hasErrors = false;
  for (const level of ctx.buildOrder) {
    // Collect all work items for this level
    const workItems: Array<{ pkg: PackageInfo; target: ResolvedTarget }> = [];

    for (const pkgName of level) {
      if (!applicableNames.has(pkgName)) continue;
      const pkg = ctx.packages.get(pkgName)!;
      for (const target of activeTargets) {
        if (shouldSkipTarget(pkg, target)) {
          logger.verbose(`Skipping (not applicable)`, `${pkg.name}:${target.name}`);
          continue;
        }
        const override = loadPackageOverride(pkg.path);
        let targetConfig = target.config;
        if (override) {
          const merged = applyPackageOverride(targetConfig, override, target.name);
          if ('skip' in merged && merged.skip) {
            logger.verbose(`Skipping (per-package override)`, `${pkg.name}:${target.name}`);
            continue;
          }
          targetConfig = { ...target.config, ...merged };
        }

        let finalConfig = { ...targetConfig, imports: targetConfig.imports ?? 'preserve' };

        // In npm mode, compile with `preserve` so tsc keeps package specifiers
        // and skips rootDir widening; carry the configured publish-import style
        // (default 'relative' for back-compat) in `publishImports` for the
        // post-compile transform to honor.
        if (isNpmBuild && npmStagingDir) {
          const pkgStagingDir = path.join(npmStagingDir, pkg.name.replace(/^@/, ''));
          finalConfig = {
            ...finalConfig,
            outDir: pkgStagingDir,
            publishImports: targetConfig.imports ?? 'relative',
            imports: 'preserve',
          };
        }

        const resolvedTarget: ResolvedTarget = {
          name: target.name,
          config: finalConfig,
        };

        workItems.push({ pkg, target: resolvedTarget });
      }
    }

    // Execute work items with concurrency limit
    const results = await runWithConcurrency(maxParallel, workItems, (item) => {
      return buildPackageTarget(item.pkg, item.target, ctx, cacheDir, useCache, cacheKeys, npmStagingDir);
    });

    for (const result of results) {
      if (!result.success) hasErrors = true;
      if (result.cacheKey) {
        cacheKeys.set(result.id, result.cacheKey);
      }
    }
  }

  // In npm mode, generate clean package.json + copy assets to staging
  if (isNpmBuild && npmStagingDir && !hasErrors) {
    for (const pkg of applicablePackages) {
      const pkgStagingDir = path.join(npmStagingDir, pkg.name.replace(/^@/, ''));
      if (!fs.existsSync(pkgStagingDir)) continue; // wasn't built (cache hit or error)

      // Generate clean package.json (with workspace deps resolved to real versions)
      const manifest = generatePublishManifest(pkg, ctx.packages);
      fs.writeFileSync(
        path.join(pkgStagingDir, 'package.json'),
        JSON.stringify(manifest, null, 2) + '\n',
        'utf-8',
      );
      logger.verbose('Generated publish manifest', pkg.name);

      // Copy README, LICENSE if present
      for (const file of ['README.md', 'README', 'LICENSE', 'LICENSE.md']) {
        const src = path.join(pkg.path, file);
        if (fs.existsSync(src)) {
          fs.copyFileSync(src, path.join(pkgStagingDir, file));
        }
      }

      // Copy assets defined in package ts-forge.json
      const pkgOverride = loadPackageOverride(pkg.path);
      if (pkgOverride?.assets?.length) {
        for (const pattern of pkgOverride.assets) {
          const matches = globSync(pattern, { cwd: pkg.path, nodir: true });
          for (const match of matches) {
            const src = path.join(pkg.path, match);
            const dest = path.join(pkgStagingDir, match);
            fs.mkdirSync(path.dirname(dest), { recursive: true });
            fs.copyFileSync(src, dest);
          }
        }
        logger.verbose(`Copied assets (${pkgOverride.assets.join(', ')})`, pkg.name);
      }

      // Final pass: fix any relative imports that are broken in the staging layout
      // (e.g. ../../package.json that should be ../package.json after rootDir stripping)
      fixBrokenRelativeImports(pkgStagingDir, pkg.name);
    }
  }

  if (hasErrors) {
    logger.error('Build completed with errors');
  } else {
    logger.success(isNpmBuild ? `npm build complete → ${npmStagingDir}` : 'Build complete');
  }

  return !hasErrors;
}

export function check(): boolean {
  const configPath = findConfigFile(process.cwd());
  if (!configPath) {
    logger.error('No ts-forge.config.json found');
    return false;
  }

  const rootDir = path.dirname(configPath);
  logger.info('Running type check...');
  const success = runTypeCheck(rootDir);
  if (success) {
    logger.success('Type check passed');
  }
  return success;
}

export function info(): void {
  const ctx = loadBuildContext({});
  if (!ctx) return;

  console.log('ts-forge Build Plan');
  console.log('===================\n');
  console.log(`Root: ${ctx.rootDir}`);
  console.log(`Packages: ${ctx.packages.size}`);
  console.log(`Targets: ${ctx.targets.map((t) => t.name).join(', ')}\n`);

  console.log('Build Order:');
  for (let i = 0; i < ctx.buildOrder.length; i++) {
    console.log(`  Level ${i}: ${ctx.buildOrder[i].join(', ')}`);
  }

  console.log('\nTargets:');
  for (const target of ctx.targets) {
    const cond = target.config.condition ? ` [condition: ${target.config.condition}]` : '';
    const module = target.config.module || target.config.format || 'default';
    const out = target.config.outDir || target.config.outFile || 'default';
    const applicableCount = Array.from(ctx.packages.values())
      .filter((pkg) => !shouldSkipTarget(pkg, target)).length;
    const countNote = applicableCount < ctx.packages.size ? ` (${applicableCount} packages)` : '';
    console.log(`  ${target.name}: ${module} → ${out}, imports=${target.config.imports}${cond}${countNote}`);
  }
}

export function loadBuildContextPublic(): BuildContext | null {
  return loadBuildContext({});
}

/**
 * Check if a target should be skipped for a given package.
 * Conditioned targets (e.g. condition="publish") only apply to packages
 * that match the condition semantics.
 */
export function shouldSkipTarget(pkg: PackageInfo, target: ResolvedTarget): boolean {
  if (!target.config.condition) return false;

  if (target.config.condition === 'publish') {
    const pkgJsonPath = path.join(pkg.path, 'package.json');
    try {
      const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8'));
      // Publish target requires publishConfig to indicate the package is published
      if (!pkgJson.publishConfig) return true;
    } catch {
      return true;
    }
  }

  return false;
}

function loadBuildContext(options: BuildOptions): BuildContext | null {
  const configPath = findConfigFile(process.cwd());
  if (!configPath) {
    logger.error('No ts-forge.config.json found. Run "ts-forge init" to create one.');
    return null;
  }

  const rootDir = path.dirname(configPath);
  const config = loadConfig(configPath);

  // Validate
  const errors = validateConfig(config);
  if (errors.length > 0) {
    for (const err of errors) logger.error(err);
    return null;
  }

  // Resolve targets
  const targets = resolveTargets(config);

  // Detect workspace and resolve packages
  const workspace = detectWorkspace(rootDir);
  const workspaceNames = workspace ? undefined : undefined; // Let resolvePackages figure it out
  const packages = resolvePackages(config, rootDir, workspaceNames);

  if (packages.size === 0) {
    logger.error('No packages found matching project globs');
    return null;
  }

  // Build dependency graph
  const buildOrder = getBuildOrder(packages);

  return { rootDir, config, packages, buildOrder, targets };
}

function filterTargets(targets: ResolvedTarget[], options: BuildOptions): ResolvedTarget[] {
  if (options.all) return targets;

  if (options.target && options.target.length > 0) {
    return targets.filter((t) => options.target!.includes(t.name));
  }

  if (options.condition && options.condition.length > 0) {
    return targets.filter(
      (t) => t.config.condition && options.condition!.includes(t.config.condition),
    );
  }

  // Default: only unconditional targets
  return targets.filter((t) => !t.config.condition);
}

interface BuildItemResult {
  id: string;
  success: boolean;
  cacheKey?: string;
}

async function buildPackageTarget(
  pkg: PackageInfo,
  resolvedTarget: ResolvedTarget,
  ctx: BuildContext,
  cacheDir: string,
  useCache: boolean,
  cacheKeys: Map<string, string>,
  npmStagingDir?: string,
): Promise<BuildItemResult> {
  const context = `${pkg.name}:${resolvedTarget.name}`;
  const id = `${pkg.name}:${resolvedTarget.name}`;

  // Collect dependency cache keys
  const depCacheKeys = new Map<string, string>();
  for (const dep of pkg.dependencies) {
    const depKey = cacheKeys.get(`${dep}:${resolvedTarget.name}`);
    if (depKey) depCacheKeys.set(dep, depKey);
  }

  // Check cache
  if (useCache) {
    const cachedKey = isCached(cacheDir, pkg, resolvedTarget, ctx.rootDir, depCacheKeys);
    if (cachedKey) {
      logger.info(`Cached, skipping`, context);
      return { id, success: true, cacheKey: cachedKey };
    }
  }

  const isBundle = resolvedTarget.config.imports === 'bundle';

  let result;
  if (isBundle) {
    // Bundle mode: bundler resolves and inlines workspace imports
    const bundle = getBundler(resolvedTarget.config.bundler);
    logger.info(`Bundling...`, context);
    result = await Promise.resolve(bundle(pkg, resolvedTarget, ctx.rootDir, ctx.packages));
  } else {
    // Transpile mode: compile then transform imports
    const compile = getCompiler(resolvedTarget.config.transpiler);
    logger.info(`Compiling...`, context);
    result = compile(pkg, resolvedTarget, ctx.rootDir, ctx.packages, npmStagingDir);
  }

  if (!result.success) {
    for (const diag of result.diagnostics) {
      logger.error(diag);
    }
    return { id, success: false };
  }

  // Transform imports (skip for bundle targets — bundler handles resolution)
  if (!isBundle) {
    // In npm mode, imports was masked to 'preserve' for tsc; the post-compile
    // transform now applies the configured publish-import style. `relative`
    // rewriting assumes the consumer hoists every `@scope/*` dependency flat
    // (so `../dep/index.js` resolves between siblings) — fragile for packages
    // with nested output files and/or deps that npm/pnpm nests under their own
    // node_modules. `preserve` keeps bare specifiers that Node resolves via the
    // normal node_modules walk-up regardless of layout. Precedence: per-package
    // `ts-forge.json` override, then the target's configured `imports`
    // (threaded as `publishImports`), defaulting to `relative` for back-compat.
    if (npmStagingDir) {
      const pkgOverride = loadPackageOverride(pkg.path)?.targets?.[resolvedTarget.name]?.imports;
      const publishImports = pkgOverride ?? resolvedTarget.config.publishImports ?? 'relative';
      if (publishImports !== 'preserve') {
        resolvedTarget = { ...resolvedTarget, config: { ...resolvedTarget.config, imports: 'relative' } };
      }
    }
    transformImports(pkg, resolvedTarget, ctx.packages);
    transformEsmExtensions(pkg, resolvedTarget);
    transformDeclarations(pkg, resolvedTarget, ctx.packages);
  }

  // Record in cache
  const newKey = computeCacheKey(pkg, resolvedTarget, ctx.rootDir, depCacheKeys);
  recordBuild(cacheDir, pkg, resolvedTarget, newKey, result.outputFiles);

  logger.success(`Done`, context);
  return { id, success: true, cacheKey: newKey };
}

/**
 * Run tasks with a concurrency limit.
 * Executes up to `limit` tasks in parallel using microtask scheduling.
 */
async function runWithConcurrency<T, R>(
  limit: number,
  items: T[],
  fn: (item: T) => R | Promise<R>,
): Promise<Awaited<R>[]> {
  if (items.length === 0) return [];

  const results: Awaited<R>[] = [];
  for (let i = 0; i < items.length; i += limit) {
    const chunk = items.slice(i, i + limit);
    const chunkResults = await Promise.all(
      chunk.map((item) => Promise.resolve(fn(item))),
    );
    results.push(...chunkResults);
  }
  return results;
}

/**
 * Build with watch mode — initial build then watch for changes and rebuild.
 */
export async function buildWatch(options: BuildOptions): Promise<void> {
  const ctx = loadBuildContext(options);
  if (!ctx) return;

  // Initial build
  logger.info('Running initial build...');
  await build(options);

  // Start watcher
  logger.info('Watching for changes...');

  const watcher = createWatcher(ctx.packages, ctx.buildOrder);

  watcher.on('rebuild', async (affectedPackages: string[]) => {
    logger.info(`Changes detected in: ${affectedPackages.join(', ')}`);

    // Rebuild affected packages using the same options (minus clean)
    const rebuildOptions = { ...options, clean: false };
    await build(rebuildOptions);
  });

  watcher.start();

  // Keep process alive
  process.on('SIGINT', () => {
    watcher.stop();
    logger.info('Watch mode stopped');
    process.exit(0);
  });
}

function runTypeCheck(rootDir: string): boolean {
  try {
    // Use tsc -b for composite projects, tsc --noEmit otherwise
    const tsconfigPath = path.join(rootDir, 'tsconfig.json');
    const isComposite = fs.existsSync(tsconfigPath) &&
      JSON.parse(fs.readFileSync(tsconfigPath, 'utf-8')).compilerOptions?.composite;

    const cmd = isComposite ? 'npx tsc -b --noEmit' : 'npx tsc --noEmit';
    execSync(cmd, { cwd: rootDir, stdio: 'inherit' });
    return true;
  } catch {
    return false;
  }
}
