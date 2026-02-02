import type * as vscode from 'vscode';

export interface TsForgeConfig {
  projects: string[];
  targets?: Record<string, TargetConfig>;
  defaults?: DefaultConfig;
}

export interface TargetConfig {
  module?: string;
  format?: string;
  outDir?: string;
  outFile?: string;
  imports?: 'preserve' | 'relative' | 'bundle' | 'specifier-map';
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

export interface DefaultConfig {
  transpiler?: 'tsc' | 'esbuild' | 'swc';
  typeCheck?: boolean;
  sourceMap?: boolean;
  clean?: boolean;
}

export interface TsForgeTaskDefinition extends vscode.TaskDefinition {
  type: 'ts-forge';
  target?: string;
  condition?: string;
  watch?: boolean;
  check?: boolean;
  clean?: boolean;
  verbose?: boolean;
}
