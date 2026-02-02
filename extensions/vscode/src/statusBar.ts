import * as vscode from 'vscode';

export class BuildStatusBar implements vscode.Disposable {
  private item: vscode.StatusBarItem;

  constructor() {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.item.command = 'ts-forge.info';
    this.setIdle();
  }

  show(): void {
    this.item.show();
  }

  hide(): void {
    this.item.hide();
  }

  setIdle(): void {
    this.item.text = '$(check) ts-forge';
    this.item.tooltip = 'ts-forge: Ready';
    this.item.backgroundColor = undefined;
  }

  setBuilding(target?: string): void {
    const suffix = target ? ` (${target})` : '';
    this.item.text = `$(sync~spin) ts-forge${suffix}`;
    this.item.tooltip = `ts-forge: Building${suffix}`;
    this.item.backgroundColor = undefined;
  }

  setError(count: number): void {
    this.item.text = `$(error) ts-forge (${count})`;
    this.item.tooltip = `ts-forge: ${count} error(s)`;
    this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
  }

  dispose(): void {
    this.item.dispose();
  }
}
