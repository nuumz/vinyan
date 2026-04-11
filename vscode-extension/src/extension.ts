/**
 * Vinyan VS Code Extension — entry point.
 *
 * A3: Extension is read-only projection — no governance bypass.
 * A6: Extension proposes; Orchestrator disposes.
 */
import * as vscode from 'vscode';
import { VinyanClient } from './api-client';
import { VinyanDiagnosticsProvider } from './diagnostics-provider';
import { VinyanEventPanel } from './event-panel';
import { VinyanStatusBar } from './status-bar';
import { TaskTreeProvider } from './task-view';
import { WorldGraphProvider } from './world-graph-view';

let client: VinyanClient;

export function activate(context: vscode.ExtensionContext): void {
  client = new VinyanClient();

  // ── Tree Providers ─────────────────────────────────────
  const worldGraphProvider = new WorldGraphProvider(client);
  const taskProvider = new TaskTreeProvider(client);

  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('vinyan.worldGraph', worldGraphProvider),
    vscode.window.registerTreeDataProvider('vinyan.tasks', taskProvider),
  );

  // ── Diagnostics ────────────────────────────────────────
  const diagnostics = new VinyanDiagnosticsProvider(client);
  context.subscriptions.push(diagnostics);

  // ── Status Bar ─────────────────────────────────────────
  const statusBar = new VinyanStatusBar(client, taskProvider);
  context.subscriptions.push(statusBar);

  // ── Event Panel ────────────────────────────────────────
  const eventPanel = new VinyanEventPanel(client);
  context.subscriptions.push(eventPanel);

  // ── Commands ───────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('vinyan.submitTask', async () => {
      const goal = await vscode.window.showInputBox({
        prompt: 'Task goal',
        placeHolder: 'e.g., Add input validation to AuthService',
      });
      if (!goal) return;

      try {
        const result = await client.submitTask(goal);
        vscode.window.showInformationMessage(`Task submitted: ${result.id}`);
      } catch (err) {
        vscode.window.showErrorMessage(`Failed to submit task: ${errorMessage(err)}`);
      }
    }),

    vscode.commands.registerCommand('vinyan.submitTaskFromFile', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showWarningMessage('No active editor');
        return;
      }

      const goal = await vscode.window.showInputBox({
        prompt: 'Task goal for this file',
        placeHolder: `e.g., Review ${editor.document.fileName}`,
      });
      if (!goal) return;

      try {
        const result = await client.submitTask(goal, [editor.document.uri.fsPath]);
        vscode.window.showInformationMessage(`Task submitted: ${result.id}`);
      } catch (err) {
        vscode.window.showErrorMessage(`Failed to submit task: ${errorMessage(err)}`);
      }
    }),

    vscode.commands.registerCommand('vinyan.showWorldGraph', () => {
      vscode.commands.executeCommand('vinyan.worldGraph.focus');
    }),

    vscode.commands.registerCommand('vinyan.refreshFacts', () => {
      worldGraphProvider.refresh();
    }),

    vscode.commands.registerCommand('vinyan.showEvents', () => {
      eventPanel.show();
    }),
  );

  // ── Auto-connect ───────────────────────────────────────
  const autoConnect = vscode.workspace.getConfiguration('vinyan').get('autoConnect', true);
  if (autoConnect) {
    client.subscribeEvents();

    // Initial health check
    client.getHealth().then(
      () => vscode.window.setStatusBarMessage('Vinyan: Connected', 3_000),
      () => vscode.window.setStatusBarMessage('Vinyan: Server unreachable', 5_000),
    );
  }

  context.subscriptions.push(client);
  context.subscriptions.push(worldGraphProvider);
  context.subscriptions.push(taskProvider);
}

export function deactivate(): void {
  client?.dispose();
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
