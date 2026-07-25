/**
 * @fileoverview Package publishing to npm
 * @module tsf/cli/publish
 *
 * Publishes packages from the staging directory to npm.
 * The staging directory (~/.tsf-publish/) contains build outputs
 * with clean package.json files (no workspace:* dependencies).
 *
 * Workflow:
 * 1. Build packages with `tsf build --npm`
 * 2. Run `tsf publish` to pack and publish
 *
 * Features:
 * - Tarball packing via `npm pack`
 * - Tag support (latest, beta, etc.)
 * - Filter to specific packages
 * - Dry-run mode for preview
 * - Changed detection integration
 *
 * @example
 * ```bash
 * tsf build --npm              # Build to staging
 * tsf publish --dry-run        # Preview what would publish
 * tsf publish --tag beta       # Publish with beta tag
 * ```
 */

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { loadBuildContextPublic, shouldSkipTarget, getPublishStagingDir } from '../orchestrator';
import * as logger from '../utils/logger';
import { parsePackageFlag, resolvePackageFilters } from '../utils/package-filter';

/**
 * Options for the publish command.
 */
interface PublishOptions {
  /** npm dist-tag (default: "latest") */
  tag: string;
  /** Package names to publish (empty = all) */
  filter: string[];
  /** Only publish packages with this target condition */
  condition?: string;
  /** Only publish packages that have changed since last publish */
  changed: boolean;
  /** Preview without actually publishing */
  dryRun: boolean;
}

/**
 * Handles the `tsf publish` command.
 * Packs and publishes packages from the staging directory.
 */
export function handlePublish(args: string[]): void {
  const options = parsePublishOptions(args);
  const stagingDir = getPublishStagingDir();

  if (!fs.existsSync(stagingDir)) {
    logger.error(`Staging directory not found: ${stagingDir}`);
    logger.error('Run "tsf build --npm" first.');
    process.exit(1);
  }

  const ctx = loadBuildContextPublic();
  if (!ctx) return;

  // Resolve short package names (e.g., "stdlib" → "@sharpee/stdlib")
  if (options.filter.length > 0) {
    options.filter = resolvePackageFilters(options.filter, ctx.packages);
  }

  // Find publishable packages
  const allPackages = [...ctx.packages.values()];
  const publishable = allPackages.filter((pkg) => {
    const pkgJsonPath = path.join(pkg.path, 'package.json');
    try {
      const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8'));
      return !!pkgJson.publishConfig;
    } catch {
      return false;
    }
  });

  // Apply condition filter
  let packages = publishable;
  if (options.condition) {
    const conditionTargets = ctx.targets.filter((t) => t.config.condition === options.condition);
    packages = packages.filter((pkg) => conditionTargets.some((t) => !shouldSkipTarget(pkg, t)));
  }

  // Apply name filter
  if (options.filter.length > 0) {
    packages = packages.filter((pkg) => options.filter.includes(pkg.name));
  }

  // Filter to packages that have staging output
  packages = packages.filter((pkg) => {
    const pkgStagingDir = path.join(stagingDir, pkg.name.replace(/^@/, ''));
    if (!fs.existsSync(pkgStagingDir)) {
      logger.warn(`No staging output for ${pkg.name} — skipping (run "tsf build --npm")`);
      return false;
    }
    return true;
  });

  // Apply --changed filter
  if (options.changed) {
    packages = packages.filter((pkg) => {
      try {
        const published = execSync(`npm view ${pkg.name} version`, { stdio: 'pipe' }).toString().trim();
        const local = pkg.version || '0.0.0';
        if (published === local) {
          logger.verbose(`${pkg.name}@${local} already published — skipping`);
          return false;
        }
      } catch {
        // Not published yet — include it
      }
      return true;
    });
  }

  if (packages.length === 0) {
    logger.error('No publishable packages found');
    process.exit(1);
  }

  checkNpmLogin(options.dryRun);

  // Build ordered list from buildOrder levels
  const packageNames = new Set(packages.map((p) => p.name));
  const ordered: typeof packages = [];
  for (const level of ctx.buildOrder) {
    for (const name of level) {
      if (packageNames.has(name)) {
        const pkg = packages.find((p) => p.name === name);
        if (pkg) ordered.push(pkg);
      }
    }
  }

  // Validate staging manifests — catch workspace: protocol leaks before publishing
  const invalid: string[] = [];
  for (const pkg of ordered) {
    const manifestPath = path.join(stagingDir, pkg.name.replace(/^@/, ''), 'package.json');
    if (!fs.existsSync(manifestPath)) continue;
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
      const deps = manifest[field] as Record<string, string> | undefined;
      if (!deps) continue;
      for (const [name, version] of Object.entries(deps)) {
        if (typeof version === 'string' && version.startsWith('workspace:')) {
          invalid.push(`${pkg.name} → ${field}.${name}: ${version}`);
        }
      }
    }
  }
  if (invalid.length > 0) {
    logger.error('Staged manifests contain unresolved workspace: protocols:');
    for (const msg of invalid) logger.error(`  ${msg}`);
    logger.error('This is a bug in the build — workspace deps should be resolved to version ranges.');
    process.exit(1);
  }

  // Publish in dependency order
  const published: string[] = [];
  const label = options.dryRun ? ' (dry run)' : '';

  for (const pkg of ordered) {
    const pkgStagingDir = path.join(stagingDir, pkg.name.replace(/^@/, ''));

    logger.info(`Packing ${pkg.name}${label}`);

    try {
      // Pack tarball from staging dir
      const packOutput = execSync('npm pack --json', {
        cwd: pkgStagingDir,
        stdio: 'pipe',
      }).toString().trim();

      const packResult = JSON.parse(packOutput);
      const tarballName = Array.isArray(packResult) ? packResult[0].filename : packResult.filename;
      const tarballPath = path.join(pkgStagingDir, tarballName);

      // Publish the tarball
      logger.info(`Publishing ${pkg.name}${label}`);
      execSync(buildPublishCommand(tarballPath, options.tag, options.dryRun), {
        stdio: 'inherit',
      });
      published.push(pkg.name);

      // Clean up tarball
      if (fs.existsSync(tarballPath)) {
        fs.unlinkSync(tarballPath);
      }
    } catch {
      logger.error(`Failed to publish ${pkg.name}`);
      process.exit(1);
    }
  }

  logger.success(`Published ${published.length} package(s)${label}`);
}

/**
 * Builds the `npm publish` invocation for a packed tarball.
 *
 * Always publishes with `--access public` (scoped packages default to
 * private) and an explicit dist-tag. Uses only npm-recognized flags — pnpm
 * flags like `--no-git-checks` do not belong here.
 *
 * @param tarballPath - Absolute path to the packed tarball
 * @param tag - npm dist-tag (e.g. "latest", "beta")
 * @param dryRun - When true, appends `--dry-run`
 * @returns The full command string to execute
 */
export function buildPublishCommand(tarballPath: string, tag: string, dryRun: boolean): string {
  const dryRunFlag = dryRun ? '--dry-run' : '';
  return `npm publish ${tarballPath} --access public --tag ${tag} ${dryRunFlag}`.trim();
}

/**
 * Verifies npm authentication before publishing, exiting the process when
 * no login is available.
 *
 * Skipped for dry runs and under OIDC trusted publishing: `npm whoami` does
 * not accept OIDC credentials — only `npm publish` does — so the check would
 * reject a run that is fully able to publish. GitHub Actions sets
 * ACTIONS_ID_TOKEN_REQUEST_URL only when the job grants `id-token: write`.
 * If OIDC auth is actually broken, the first `npm publish` fails loudly and
 * the existing error path exits non-zero.
 *
 * @param dryRun - When true, the check is skipped entirely
 * @param env - Process environment (injectable for tests)
 */
export function checkNpmLogin(dryRun: boolean, env: NodeJS.ProcessEnv = process.env): void {
  if (dryRun) return;

  if (env.ACTIONS_ID_TOKEN_REQUEST_URL) {
    logger.info('OIDC credentials detected — skipping npm whoami check');
    return;
  }

  try {
    const user = execSync('npm whoami', { stdio: 'pipe' }).toString().trim();
    logger.info(`Logged in to npm as ${user}`);
  } catch {
    logger.error('Not logged in to npm. Run `npm login` first.');
    process.exit(1);
  }
}

function parsePublishOptions(args: string[]): PublishOptions {
  const options: PublishOptions = {
    tag: 'latest',
    filter: [],
    changed: false,
    dryRun: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case '--tag':
        options.tag = args[++i];
        break;
      case '--filter':
        options.filter.push(args[++i]);
        break;
      case '--package':
      case '--packageList': {
        const newI = parsePackageFlag(arg, args, i, options.filter);
        if (newI >= 0) i = newI;
        break;
      }
      case '--condition':
        options.condition = args[++i];
        break;
      case '--changed':
        options.changed = true;
        break;
      case '--dry-run':
        options.dryRun = true;
        break;
      default:
        if (!arg.startsWith('-')) {
          // ignore positional
        } else {
          logger.warn(`Unknown option: ${arg}`);
        }
    }
  }

  return options;
}
