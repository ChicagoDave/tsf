/**
 * @fileoverview Default configuration and override merging
 * @module tsf/config/defaults
 *
 * Applies sensible defaults to configuration and handles the merge chain:
 * 1. Built-in defaults (tsc, type checking, source maps)
 * 2. User-defined defaults from config file
 * 3. Per-target settings
 * 4. Per-package overrides
 *
 * This layered approach lets users set workspace-wide defaults while
 * allowing individual targets and packages to customize behavior.
 */

import type { TsForgeConfig, TargetConfig, ResolvedTarget, DefaultConfig, PackageOverride } from '../types';

/**
 * Built-in default values for TSF configuration.
 * These are applied when no explicit value is provided.
 */
const BASE_DEFAULTS: Required<DefaultConfig> = {
  transpiler: 'tsc',
  typeCheck: true,
  sourceMap: true,
  clean: false,
};

/**
 * Resolves target configurations by merging defaults with explicit settings.
 * Produces fully-qualified target objects ready for the build orchestrator.
 *
 * Merge order (later wins):
 * 1. BASE_DEFAULTS
 * 2. config.defaults
 * 3. target-specific settings
 *
 * @param config - Loaded TSF configuration
 * @returns Array of resolved targets with all required fields populated
 *
 * @example
 * ```typescript
 * const targets = resolveTargets(config);
 * // targets[0].config.imports is guaranteed to be defined
 * ```
 */
export function resolveTargets(config: TsForgeConfig): ResolvedTarget[] {
  const defaults = { ...BASE_DEFAULTS, ...config.defaults };
  const targets = config.targets ?? {};

  return Object.entries(targets).map(([name, target]) => ({
    name,
    config: {
      imports: 'preserve' as const,
      sourceMap: defaults.sourceMap,
      transpiler: defaults.transpiler,
      typeCheck: defaults.typeCheck,
      clean: defaults.clean,
      ...target,
    },
  }));
}

/**
 * Applies per-package overrides to a target configuration.
 * Packages can customize or skip specific targets via `ts-forge.json`.
 *
 * @param target - Base target configuration
 * @param override - Package-specific overrides
 * @param targetName - Name of target being built
 * @returns Merged configuration, potentially with `skip: true`
 *
 * @example
 * ```typescript
 * const merged = applyPackageOverride(target, override, 'npm');
 * if (merged.skip) {
 *   console.log('Package opts out of this target');
 * }
 * ```
 */
export function applyPackageOverride(
  target: TargetConfig,
  override: PackageOverride,
  targetName: string,
): TargetConfig & { skip?: boolean } {
  const overrideForTarget = override.targets?.[targetName];
  if (!overrideForTarget) return target;
  return { ...target, ...overrideForTarget };
}
