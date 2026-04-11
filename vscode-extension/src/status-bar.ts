/**
 * Status Bar — connection indicator + active task count.
 */
import * as vscode from 'vscode';
import type { ConnectionState, VinyanClient } from './api-client';
import type { TaskTreeProvider } from './task-view';

export class VinyanStatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(client: VinyanClient, taskProvider: TaskTreeProvider) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
    this.item.command = 'workbench.action.quickOpen';
    this.item.tooltip = 'Vinyan — Click to open commands';

    this.update(client.connectionState, taskProvider.activeTaskCount);

    this.disposables.push(
      client.onConnectionChange((state) => {
        this.update(state, taskProvider.activeTaskCount);
      }),
    );

    // Also update when task tree changes (active count might change)
    this.disposables.push(
      taskProvider.onDidChangeTreeData(() => {
        this.update(client.connectionState, taskProvider.activeTaskCount);
      }),
    );

    this.item.show();
  }

  private update(state: ConnectionState, activeCount: number): void {
    const dot = state === 'connected' ? '$(circle-filled)' : '$(circle-outline)';
    const color = state === 'connected' ? undefined : new vscode.ThemeColor('statusBarItem.errorForeground');

    let text = `${dot} Vinyan`;
    if (state === 'connecting') {
      text = '$(loading~spin) Vinyan';
    } else if (activeCount > 0) {
      text += ` (${activeCount})`;
    }

    this.item.text = text;
    this.item.color = color;

    this.item.tooltip = state === 'connected'
      ? `Vinyan — Connected${activeCount > 0 ? ` · ${activeCount} active task${activeCount > 1 ? 's' : ''}` : ''}`
      : 'Vinyan — Disconnected';
  }

  dispose(): void {
    this.item.dispose();
    for (const d of this.disposables) d.dispose();
  }
}
