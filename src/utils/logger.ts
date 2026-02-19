/**
 * @fileoverview Centralized logging utilities for TSF
 * @module tsf/utils/logger
 *
 * Provides consistent, formatted console output with optional context prefixes
 * and verbose mode for debugging. All TSF modules use these functions for
 * user-facing output.
 *
 * @example
 * ```typescript
 * import { info, success, error, setVerbose } from './utils/logger';
 *
 * setVerbose(true);
 * info('Building packages...', '@scope/pkg');
 * success('Build complete', '@scope/pkg');
 * ```
 */

/** Whether verbose logging is enabled (set via --verbose flag) */
let verboseEnabled = false;

/**
 * Enables or disables verbose logging mode.
 * When enabled, calls to `verbose()` will produce output.
 *
 * @param enabled - Whether to enable verbose mode
 */
export function setVerbose(enabled: boolean): void {
  verboseEnabled = enabled;
}

/**
 * Logs an informational message.
 *
 * @param msg - Message to display
 * @param context - Optional context prefix (e.g., package name)
 */
export function info(msg: string, context?: string): void {
  const prefix = context ? `[${context}] ` : '';
  console.log(`${prefix}${msg}`);
}

/**
 * Logs a success message with checkmark indicator.
 *
 * @param msg - Message to display
 * @param context - Optional context prefix (e.g., package name)
 */
export function success(msg: string, context?: string): void {
  const prefix = context ? `[${context}] ` : '';
  console.log(`${prefix}✓ ${msg}`);
}

/**
 * Logs a warning message with warning indicator.
 *
 * @param msg - Message to display
 * @param context - Optional context prefix (e.g., package name)
 */
export function warn(msg: string, context?: string): void {
  const prefix = context ? `[${context}] ` : '';
  console.warn(`${prefix}⚠ ${msg}`);
}

/**
 * Logs an error message with error indicator.
 *
 * @param msg - Message to display
 * @param context - Optional context prefix (e.g., package name)
 */
export function error(msg: string, context?: string): void {
  const prefix = context ? `[${context}] ` : '';
  console.error(`${prefix}✗ ${msg}`);
}

/**
 * Logs a verbose/debug message (only when verbose mode is enabled).
 * Use for detailed output that aids debugging but clutters normal runs.
 *
 * @param msg - Message to display
 * @param context - Optional context prefix (e.g., package name)
 */
export function verbose(msg: string, context?: string): void {
  if (!verboseEnabled) return;
  const prefix = context ? `[${context}] ` : '';
  console.log(`${prefix}  ${msg}`);
}
