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
 * - Staged-manifest gate (entry points must exist in the tarball)
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
import { validateManifestTargets } from '../validate';

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

  // Validate staging manifests before anything is packed or published
  const problems = validateStagedManifests(ordered.map((p) => p.name), stagingDir);
  if (problems.length > 0) {
    logger.error('Staged manifests are not publishable:');
    for (const problem of problems) {
      logger.error(`  ${problem.pkg} → ${problem.message}`);
      logger.error(`    Fix: ${problem.fix}`);
    }
    logger.error('This is a bug in the build — nothing was published.');
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

      const tarballName = parsePackFilename(JSON.parse(packOutput));
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
    } catch (err) {
      logger.error(`Failed to publish ${pkg.name}`);
      // Surface the underlying cause — a swallowed error here once masked an
      // npm pack --json format change as a generic failure.
      if (err instanceof Error) {
        const execErr = err as Error & { stderr?: Buffer | string };
        const stderr = execErr.stderr?.toString().trim();
        logger.error(stderr || err.message);
      }
      process.exit(1);
    }
  }

  logger.success(`Published ${published.length} package(s)${label}`);
}

/**
 * A reason one staged manifest cannot be published as-is.
 */
export interface StagedManifestProblem {
  /** Package the problem was found in */
  pkg: string;
  /** What is wrong with the staged manifest */
  message: string;
  /** How to resolve it */
  fix: string;
}

/**
 * Validates the manifests in the staging directory — the ones that actually get
 * published — before any package is packed.
 *
 * Two classes of defect ship silently otherwise:
 * 1. `workspace:` protocol ranges left in dependencies, which npm rejects with
 *    EUNSUPPORTEDPROTOCOL at install time.
 * 2. `main`/`types`/`module`/`exports`/`bin` targets that name a path absent
 *    from the staging directory, and therefore from the tarball. `tsf validate`
 *    cannot catch these: it checks the SOURCE manifest against the SOURCE tree,
 *    where the referenced `dist/` files genuinely exist.
 *
 * Packages with no staged manifest are skipped — the caller has already warned
 * about missing staging output and filtered them out of the publish set.
 *
 * @param packageNames - Package names to check, in publish order
 * @param stagingDir - Root staging directory (`~/.tsf-publish` by default)
 * @returns One problem per defect found; empty means every manifest is publishable
 */
export function validateStagedManifests(
  packageNames: string[],
  stagingDir: string,
): StagedManifestProblem[] {
  const problems: StagedManifestProblem[] = [];

  for (const name of packageNames) {
    const pkgStagingDir = path.join(stagingDir, name.replace(/^@/, ''));
    const manifestPath = path.join(pkgStagingDir, 'package.json');
    if (!fs.existsSync(manifestPath)) continue;
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));

    for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
      const deps = manifest[field] as Record<string, string> | undefined;
      if (!deps) continue;
      for (const [dep, version] of Object.entries(deps)) {
        if (typeof version === 'string' && version.startsWith('workspace:')) {
          problems.push({
            pkg: name,
            message: `${field}.${dep}: ${version}`,
            fix: 'Workspace deps must be resolved to version ranges by the npm build',
          });
        }
      }
    }

    // Entry points are checked against the staging directory, not the package
    // tree, so a target the tarball does not contain fails here.
    for (const issue of validateManifestTargets(manifest, pkgStagingDir, manifestPath)) {
      if (issue.level !== 'error') continue;
      problems.push({
        pkg: name,
        message: `${issue.message} in the staging directory`,
        fix: `Re-run "tsf build --npm" — the staged manifest names a path that is not in ${pkgStagingDir}`,
      });
    }
  }

  return problems;
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
 * Extracts the tarball filename from parsed `npm pack --json` output across
 * npm major versions: npm <= 11 emits an array of result objects; npm 12
 * emits an object keyed by package name. A bare result object with a
 * `filename` field is also accepted.
 *
 * @param packResult - The JSON.parse'd output of `npm pack --json`
 * @returns The tarball filename (e.g. "scope-pkg-1.0.0.tgz")
 * @throws Error when no filename can be located in the structure
 */
export function parsePackFilename(packResult: unknown): string {
  if (Array.isArray(packResult)) {
    const filename = packResult[0]?.filename;
    if (typeof filename === 'string') return filename;
  } else if (packResult && typeof packResult === 'object') {
    const obj = packResult as Record<string, unknown>;
    if (typeof obj.filename === 'string') return obj.filename;
    const first = Object.values(obj)[0] as { filename?: unknown } | undefined;
    if (first && typeof first.filename === 'string') return first.filename;
  }
  throw new Error('could not find tarball filename in npm pack --json output');
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
