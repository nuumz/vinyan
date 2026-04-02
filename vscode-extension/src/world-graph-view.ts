/**
 * World Graph Tree View — shows facts for the active file.
 *
 * A4: Content-addressed truth — stale facts (hash mismatch) shown with warning icon.
 */
import * as vscode from 'vscode';
import type { FactInfo, VinyanClient } from './api-client';

export class WorldGraphProvider implements vscode.TreeDataProvider<FactItem> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<FactItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private facts: FactInfo[] = [];
  private currentFileHash: string | undefined;
  private disposables: vscode.Disposable[] = [];

  constructor(private readonly client: VinyanClient) {
    // Refresh when active editor changes
    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor(() => this.refresh()),
    );

    // Refresh on SSE fact events
    this.disposables.push(
      client.onSSEEvent((evt) => {
        if (evt.event === 'graph:fact') {
          this.refresh();
        }
      }),
    );
  }

  async refresh(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      this.facts = [];
      this._onDidChangeTreeData.fire(undefined);
      return;
    }

    try {
      const filePath = editor.document.uri.fsPath;
      const result = await this.client.getFacts(filePath);
      this.facts = result.facts;
    } catch {
      this.facts = [];
    }
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(element: FactItem): vscode.TreeItem {
    return element;
  }

  getChildren(): FactItem[] {
    if (this.facts.length === 0) {
      return [new FactItem('No facts for this file', '', 0, false, false)];
    }

    return this.facts.map((fact) => {
      const isStale = fact.contentHash !== undefined && this.currentFileHash !== undefined
        && fact.contentHash !== this.currentFileHash;
      const lastVerified = fact.lastVerified
        ? new Date(fact.lastVerified).toLocaleTimeString()
        : 'unknown';
      return new FactItem(fact.pattern, lastVerified, fact.confidence, true, isStale);
    });
  }

  dispose(): void {
    this._onDidChangeTreeData.dispose();
    for (const d of this.disposables) d.dispose();
  }
}

class FactItem extends vscode.TreeItem {
  constructor(
    pattern: string,
    lastVerified: string,
    confidence: number,
    hasFact: boolean,
    isStale: boolean,
  ) {
    super(pattern, vscode.TreeItemCollapsibleState.None);

    if (!hasFact) {
      this.iconPath = new vscode.ThemeIcon('info');
      return;
    }

    // Confidence gauge: █░░░░ style
    const filled = Math.round(confidence * 5);
    const gauge = '█'.repeat(filled) + '░'.repeat(5 - filled);
    this.description = `${gauge} ${(confidence * 100).toFixed(0)}% · ${lastVerified}`;

    if (isStale) {
      this.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('editorWarning.foreground'));
      this.tooltip = 'Stale — file content has changed since last verification';
    } else {
      this.iconPath = new vscode.ThemeIcon('check', new vscode.ThemeColor('testing.iconPassed'));
      this.tooltip = `Last verified: ${lastVerified}`;
    }
  }
}
