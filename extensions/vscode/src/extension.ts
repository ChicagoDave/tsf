import * as vscode from 'vscode';
import { ConfigManager } from './config';
import { TsForgeTaskProvider } from './taskProvider';
import { BuildStatusBar } from './statusBar';

let statusBar: BuildStatusBar | undefined;
const activeBuilds = new Set<string>();

export function activate(context: vscode.ExtensionContext): void {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders) return;

  for (const folder of folders) {
    initFolder(folder, context);
  }

  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders((e) => {
      for (const folder of e.added) {
        initFolder(folder, context);
      }
    }),
  );

  // Track task start/end for status bar
  context.subscriptions.push(
    vscode.tasks.onDidStartTask((e) => {
      if (e.execution.task.definition.type !== 'ts-forge') return;
      const target = (e.execution.task.definition as { target?: string }).target;
      activeBuilds.add(e.execution.task.name);
      statusBar?.setBuilding(target);
    }),
    vscode.tasks.onDidEndTask((e) => {
      if (e.execution.task.definition.type !== 'ts-forge') return;
      activeBuilds.delete(e.execution.task.name);
      if (activeBuilds.size === 0) {
        statusBar?.setIdle();
      }
    }),
    vscode.tasks.onDidEndTaskProcess((e) => {
      if (e.execution.task.definition.type !== 'ts-forge') return;
      if (e.exitCode && e.exitCode !== 0 && activeBuilds.size === 0) {
        statusBar?.setError(e.exitCode);
      }
    }),
  );

  // Commands
  context.subscriptions.push(
    vscode.commands.registerCommand('ts-forge.build', runBuild),
    vscode.commands.registerCommand('ts-forge.buildTarget', runBuildTarget),
    vscode.commands.registerCommand('ts-forge.check', () => runNamedTask('type check')),
    vscode.commands.registerCommand('ts-forge.clean', () => runNamedTask('clean')),
    vscode.commands.registerCommand('ts-forge.info', () => showInfo(folders[0])),
  );
}

function initFolder(folder: vscode.WorkspaceFolder, context: vscode.ExtensionContext): void {
  const config = new ConfigManager(folder);
  if (!config.hasConfig) return;

  context.subscriptions.push(config);
  context.subscriptions.push(
    vscode.tasks.registerTaskProvider('ts-forge', new TsForgeTaskProvider(folder, config)),
  );

  const settings = vscode.workspace.getConfiguration('ts-forge');
  if (settings.get<boolean>('showStatusBar', true) && !statusBar) {
    statusBar = new BuildStatusBar();
    statusBar.show();
    context.subscriptions.push(statusBar);
  }
}

async function runBuild(): Promise<void> {
  const task = await findTask((t) => t.name === 'build' && !t.definition.target);
  if (task) {
    await vscode.tasks.executeTask(task);
  } else {
    vscode.window.showErrorMessage('No ts-forge build task found. Is ts-forge.config.json present?');
  }
}

async function runBuildTarget(): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) return;

  const config = new ConfigManager(folder);
  await config.load();
  const targets = config.getTargetNames();
  config.dispose();

  if (targets.length === 0) {
    vscode.window.showWarningMessage('No targets defined in ts-forge.config.json.');
    return;
  }

  const picked = await vscode.window.showQuickPick(targets, { placeHolder: 'Select a build target' });
  if (!picked) return;

  const task = await findTask((t) => t.definition.target === picked && !t.definition.watch);
  if (task) {
    await vscode.tasks.executeTask(task);
  }
}

async function runNamedTask(name: string): Promise<void> {
  const task = await findTask((t) => t.name === name);
  if (task) {
    await vscode.tasks.executeTask(task);
  }
}

async function findTask(predicate: (t: vscode.Task) => boolean): Promise<vscode.Task | undefined> {
  const all = await vscode.tasks.fetchTasks({ type: 'ts-forge' });
  return all.find(predicate);
}

async function showInfo(folder: vscode.WorkspaceFolder): Promise<void> {
  const config = new ConfigManager(folder);
  await config.load();
  const cfg = config.getConfig();
  config.dispose();

  if (!cfg) {
    vscode.window.showInformationMessage('No ts-forge configuration found.');
    return;
  }

  const targets = cfg.targets ? Object.keys(cfg.targets) : [];
  const lines = [
    'ts-forge Configuration',
    '======================',
    '',
    `Config: ${config.getConfigPath()}`,
    `Projects: ${cfg.projects.join(', ')}`,
    `Targets: ${targets.join(', ') || '(none)'}`,
  ];

  for (const name of targets) {
    const t = cfg.targets![name];
    const module = t.module || t.format || 'default';
    const out = t.outDir || t.outFile || 'default';
    const cond = t.condition ? ` [condition: ${t.condition}]` : '';
    lines.push(`  ${name}: ${module} → ${out}${cond}`);
  }

  const doc = await vscode.workspace.openTextDocument({ content: lines.join('\n'), language: 'plaintext' });
  await vscode.window.showTextDocument(doc);
}

export function deactivate(): void {
  // Disposables handled by context.subscriptions
}
