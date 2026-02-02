import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import type { TsForgeConfig, TargetConfig } from './types';

export class ConfigManager {
  private configPath: string | undefined;
  private config: TsForgeConfig | undefined;
  private _onDidChangeConfig = new vscode.EventEmitter<TsForgeConfig | undefined>();
  readonly onDidChangeConfig = this._onDidChangeConfig.event;
  private watcher: vscode.FileSystemWatcher | undefined;

  constructor(private workspaceFolder: vscode.WorkspaceFolder) {
    const candidate = path.join(workspaceFolder.uri.fsPath, 'ts-forge.config.json');
    if (fs.existsSync(candidate)) {
      this.configPath = candidate;
    }

    // Watch for config file changes
    const pattern = new vscode.RelativePattern(workspaceFolder, 'ts-forge.config.json');
    this.watcher = vscode.workspace.createFileSystemWatcher(pattern);
    this.watcher.onDidChange(() => this.reload());
    this.watcher.onDidCreate(() => {
      this.configPath = candidate;
      this.reload();
    });
    this.watcher.onDidDelete(() => {
      this.configPath = undefined;
      this.config = undefined;
      this._onDidChangeConfig.fire(undefined);
    });
  }

  get hasConfig(): boolean {
    return this.configPath !== undefined;
  }

  async load(): Promise<TsForgeConfig | undefined> {
    if (!this.configPath) return undefined;
    try {
      const raw = await fs.promises.readFile(this.configPath, 'utf-8');
      this.config = JSON.parse(raw);
      return this.config;
    } catch (err) {
      vscode.window.showErrorMessage(`Failed to load ts-forge config: ${err}`);
      return undefined;
    }
  }

  private async reload(): Promise<void> {
    await this.load();
    this._onDidChangeConfig.fire(this.config);
  }

  getConfig(): TsForgeConfig | undefined {
    return this.config;
  }

  getConfigPath(): string | undefined {
    return this.configPath;
  }

  getTargetNames(): string[] {
    return this.config?.targets ? Object.keys(this.config.targets) : [];
  }

  getTarget(name: string): TargetConfig | undefined {
    return this.config?.targets?.[name];
  }

  dispose(): void {
    this.watcher?.dispose();
    this._onDidChangeConfig.dispose();
  }
}
