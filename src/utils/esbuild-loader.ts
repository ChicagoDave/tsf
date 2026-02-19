/**
 * @fileoverview Cross-platform esbuild loader
 * @module tsf/utils/esbuild-loader
 *
 * Loads esbuild on demand with automatic platform binary installation.
 *
 * When pnpm/npm install runs under WSL or a different OS, only that
 * platform's native esbuild binary is downloaded. If tsf is then
 * invoked from a different platform (e.g. PowerShell on Windows),
 * esbuild's JS module loads fine but throws at build time because
 * the native binary is for the wrong platform.
 *
 * This loader detects that situation and installs the correct
 * platform-specific package automatically.
 */

import { execSync } from 'child_process';
import * as logger from './logger';

/** Cached, verified esbuild module */
let esbuild: typeof import('esbuild') | undefined;

/**
 * Returns the platform-specific esbuild package name.
 * Matches esbuild's own naming convention: @esbuild/{os}-{arch}
 *
 * @see https://esbuild.github.io/getting-started/#other-ways-to-install
 */
function platformPackage(): string {
  const platform = process.platform === 'win32' ? 'win32'
    : process.platform === 'darwin' ? 'darwin'
    : 'linux';
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  return `@esbuild/${platform}-${arch}`;
}

/**
 * Installs the esbuild platform binary for the current OS.
 * Uses npm with --no-save so the project's package.json is not modified.
 */
function installPlatformBinary(): void {
  const pkg = platformPackage();
  logger.info(`Installing esbuild platform binary: ${pkg}`);

  try {
    const cmd = `npm install --no-save ${pkg}`;
    execSync(cmd, { stdio: 'pipe', timeout: 60_000 });
    logger.success(`Installed ${pkg}`);
  } catch (err: any) {
    throw new Error(
      `Failed to install ${pkg}. Install manually with: npm install --no-save ${pkg}\n` +
      (err.stderr ? err.stderr.toString() : err.message),
    );
  }
}

/**
 * Probe esbuild with a trivial build to verify the native binary works.
 * esbuild's JS module loads successfully even when the wrong platform
 * binary is installed - the error only surfaces when you call build.
 */
function probeEsbuild(esb: typeof import('esbuild')): void {
  esb.buildSync({ stdin: { contents: '' }, write: false });
}

/**
 * Clear all esbuild-related entries from the require cache
 * so a fresh require() picks up a newly installed platform binary.
 */
function clearEsbuildCache(): void {
  for (const key of Object.keys(require.cache)) {
    if (key.includes('esbuild')) {
      delete require.cache[key];
    }
  }
}

/**
 * Loads esbuild on demand.
 *
 * Requires the esbuild module, then runs a probe build to verify the
 * native binary works on this platform. If the probe fails (wrong
 * platform binary), installs the correct one and retries.
 *
 * @returns The esbuild module, verified working
 * @throws If esbuild is not installed and auto-install fails
 */
export function loadEsbuild(): typeof import('esbuild') {
  if (esbuild) return esbuild;

  // Load the JS module
  let esb: typeof import('esbuild');
  try {
    esb = require('esbuild');
  } catch {
    throw new Error(
      'esbuild is not installed. Install it with: pnpm add -D esbuild',
    );
  }

  // Verify the native binary works on this platform
  try {
    probeEsbuild(esb);
    esbuild = esb;
    return esbuild;
  } catch (probeError: any) {
    const msg = probeError.message || '';
    const isPlatformMismatch =
      msg.includes('another platform') ||
      msg.includes('platform-specific') ||
      msg.includes('Exec format error') ||
      msg.includes('cannot execute binary') ||
      msg.includes('ENOENT');

    if (!isPlatformMismatch) {
      // Some other esbuild error - don't try to auto-fix
      throw probeError;
    }

    logger.warn(
      `esbuild binary is for wrong platform, installing ${platformPackage()}...`,
    );

    installPlatformBinary();
    clearEsbuildCache();

    // Retry: reload and probe again
    try {
      esb = require('esbuild');
      probeEsbuild(esb);
      esbuild = esb;
      return esbuild;
    } catch (retryError: any) {
      throw new Error(
        `esbuild platform binary still not working after install.\n` +
        `Try manually: npm install --no-save ${platformPackage()}\n` +
        `Error: ${retryError.message}`,
      );
    }
  }
}
