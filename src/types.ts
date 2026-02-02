export interface TsForgeConfig {
  $schema?: string;
  projects: string[];
  targets?: Record<string, TargetConfig>;
  defaults?: DefaultConfig;
}

export interface TargetConfig {
  module?: string;
  format?: string;
  outDir?: string;
  outFile?: string;
  imports?: ImportStrategy;
  relativeMode?: 'path' | 'peer';
  declarations?: boolean;
  declarationMap?: boolean;
  sourceMap?: boolean;
  condition?: string;
  extensionMap?: Record<string, string>;
  transpiler?: 'tsc' | 'esbuild' | 'swc';
  bundler?: 'esbuild' | 'rollup';
  external?: string[];
  banner?: string;
  target?: string;
  typeCheck?: boolean;
  clean?: boolean;
  importMap?: string;
}

export type ImportStrategy = 'preserve' | 'relative' | 'bundle' | 'specifier-map';

export interface DefaultConfig {
  transpiler?: 'tsc' | 'esbuild' | 'swc';
  typeCheck?: boolean;
  sourceMap?: boolean;
  clean?: boolean;
}

export interface PackageOverride {
  targets?: Record<string, Partial<TargetConfig> & { skip?: boolean }>;
}

export interface PackageInfo {
  name: string;
  path: string;
  tsconfig: string;
  dependencies: string[];
  entryPoint: string;
  version?: string;
}

export interface ResolvedTarget {
  name: string;
  config: TargetConfig & { imports: ImportStrategy };
}

export interface BuildContext {
  rootDir: string;
  config: TsForgeConfig;
  packages: Map<string, PackageInfo>;
  buildOrder: string[][];
  targets: ResolvedTarget[];
}

export interface BuildOptions {
  target?: string[];
  condition?: string[];
  all?: boolean;
  npm?: boolean;
  check?: boolean;
  noCheck?: boolean;
  clean?: boolean;
  verbose?: boolean;
  watch?: boolean;
  parallel?: number;
}

export interface CompileResult {
  success: boolean;
  diagnostics: string[];
  outputFiles: string[];
}

export type WorkspaceType = 'pnpm' | 'npm' | 'yarn';
