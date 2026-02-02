import * as vscode from 'vscode';
import type { ConfigManager } from './config';
import type { TsForgeTaskDefinition } from './types';

export class TsForgeTaskProvider implements vscode.TaskProvider {
  private cachedTasks: vscode.Task[] | undefined;

  constructor(
    private workspaceFolder: vscode.WorkspaceFolder,
    private configManager: ConfigManager,
  ) {
    configManager.onDidChangeConfig(() => {
      this.cachedTasks = undefined;
    });
  }

  async provideTasks(): Promise<vscode.Task[]> {
    if (this.cachedTasks) return this.cachedTasks;

    const settings = vscode.workspace.getConfiguration('ts-forge');
    if (!settings.get<boolean>('autoDetect', true) || !this.configManager.hasConfig) {
      return [];
    }

    await this.configManager.load();
    const targets = this.configManager.getTargetNames();

    const tasks: vscode.Task[] = [];

    // Default build (all unconditional targets)
    tasks.push(this.makeTask({ type: 'ts-forge' }, 'build'));

    // Per-target build + watch
    for (const target of targets) {
      tasks.push(this.makeTask({ type: 'ts-forge', target }, `build: ${target}`));
      tasks.push(this.makeTask({ type: 'ts-forge', target, watch: true }, `build: ${target} (watch)`, true));
    }

    // Type check
    tasks.push(this.makeCheckTask());

    // Clean
    tasks.push(this.makeCleanTask());

    this.cachedTasks = tasks;
    return tasks;
  }

  resolveTask(task: vscode.Task): vscode.Task | undefined {
    const def = task.definition as TsForgeTaskDefinition;
    if (def.type !== 'ts-forge') return undefined;

    const name = def.target ? `build: ${def.target}` : 'build';
    return this.makeTask(def, name, def.watch);
  }

  private getExecutable(): string {
    return vscode.workspace.getConfiguration('ts-forge').get<string>('executable', 'ts-forge');
  }

  private makeTask(definition: TsForgeTaskDefinition, name: string, isBackground = false): vscode.Task {
    const args = ['build'];
    if (definition.target) args.push('--target', definition.target);
    if (definition.condition) args.push('--condition', definition.condition);
    if (definition.watch) args.push('--watch');
    if (definition.check !== undefined) args.push(definition.check ? '--check' : '--no-check');
    if (definition.clean) args.push('--clean');
    if (definition.verbose) args.push('--verbose');

    const exec = new vscode.ShellExecution(this.getExecutable(), args, {
      cwd: this.workspaceFolder.uri.fsPath,
    });

    const task = new vscode.Task(
      definition,
      this.workspaceFolder,
      name,
      'ts-forge',
      exec,
      ['$ts-forge-tsc', '$ts-forge-esbuild'],
    );
    task.group = vscode.TaskGroup.Build;
    task.isBackground = isBackground;
    task.presentationOptions = {
      reveal: vscode.TaskRevealKind.Always,
      panel: vscode.TaskPanelKind.Dedicated,
    };
    return task;
  }

  private makeCheckTask(): vscode.Task {
    const exec = new vscode.ShellExecution(this.getExecutable(), ['check'], {
      cwd: this.workspaceFolder.uri.fsPath,
    });
    const task = new vscode.Task(
      { type: 'ts-forge' } as TsForgeTaskDefinition,
      this.workspaceFolder,
      'type check',
      'ts-forge',
      exec,
      ['$ts-forge-tsc'],
    );
    task.group = vscode.TaskGroup.Build;
    return task;
  }

  private makeCleanTask(): vscode.Task {
    const exec = new vscode.ShellExecution(this.getExecutable(), ['build', '--clean'], {
      cwd: this.workspaceFolder.uri.fsPath,
    });
    const task = new vscode.Task(
      { type: 'ts-forge' } as TsForgeTaskDefinition,
      this.workspaceFolder,
      'clean',
      'ts-forge',
      exec,
    );
    task.group = vscode.TaskGroup.Clean;
    task.presentationOptions = { reveal: vscode.TaskRevealKind.Silent };
    return task;
  }
}
