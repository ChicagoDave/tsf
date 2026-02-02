import type { TsForgeConfig, TargetConfig, ResolvedTarget, DefaultConfig, PackageOverride } from '../types';

const BASE_DEFAULTS: Required<DefaultConfig> = {
  transpiler: 'tsc',
  typeCheck: true,
  sourceMap: true,
  clean: false,
};

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

export function applyPackageOverride(
  target: TargetConfig,
  override: PackageOverride,
  targetName: string,
): TargetConfig & { skip?: boolean } {
  const overrideForTarget = override.targets?.[targetName];
  if (!overrideForTarget) return target;
  return { ...target, ...overrideForTarget };
}
