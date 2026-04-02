/**
 * Event Panel — output channel for bus events, formatted like the TUI.
 */
import * as vscode from 'vscode';
import type { SSEEvent, VinyanClient } from './api-client';

const EVENT_CATEGORIES: Record<string, string> = {
  'task:start': 'TASK',
  'task:complete': 'TASK',
  'task:escalate': 'TASK',
  'task:timeout': 'TASK',
  'worker:dispatch': 'WORKER',
  'worker:complete': 'WORKER',
  'worker:error': 'WORKER',
  'oracle:verdict': 'ORACLE',
  'critic:verdict': 'CRITIC',
  'shadow:complete': 'SHADOW',
  'skill:match': 'SKILL',
  'skill:miss': 'SKILL',
  'tools:executed': 'TOOLS',
  'graph:fact': 'GRAPH',
};

export class VinyanEventPanel implements vscode.Disposable {
  private readonly channel: vscode.OutputChannel;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(client: VinyanClient) {
    this.channel = vscode.window.createOutputChannel('Vinyan Events');

    this.disposables.push(
      client.onSSEEvent((evt) => this.logEvent(evt)),
    );
  }

  private logEvent(evt: SSEEvent): void {
    const ts = new Date(evt.ts).toISOString().slice(11, 23); // HH:mm:ss.SSS
    const category = EVENT_CATEGORIES[evt.event] ?? 'SYS';
    const brief = this.summarizePayload(evt);
    this.channel.appendLine(`${ts} [${category.padEnd(6)}] ${evt.event} ${brief}`);
  }

  private summarizePayload(evt: SSEEvent): string {
    const p = evt.payload;

    switch (evt.event) {
      case 'task:start': {
        const input = p.input as Record<string, unknown> | undefined;
        const goal = (input?.goal as string) ?? '';
        return goal.length > 60 ? goal.slice(0, 57) + '...' : goal;
      }
      case 'task:complete': {
        const result = p.result as Record<string, unknown> | undefined;
        return result?.success ? 'success' : `failed: ${result?.error ?? 'unknown'}`;
      }
      case 'oracle:verdict': {
        const verdict = p.verdict as Record<string, unknown> | undefined;
        const name = p.oracleName ?? 'oracle';
        const verified = verdict?.verified ? 'PASS' : 'FAIL';
        return `${name} → ${verified} (${((verdict?.confidence as number ?? 0) * 100).toFixed(0)}%)`;
      }
      case 'task:escalate':
        return `L${p.fromLevel} → L${p.toLevel}: ${p.reason ?? ''}`;
      case 'worker:dispatch':
        return `routing: L${(p.routing as Record<string, unknown>)?.level ?? '?'}`;
      case 'worker:error':
        return String(p.error ?? '');
      default: {
        // Brief JSON excerpt
        const str = JSON.stringify(p);
        return str.length > 80 ? str.slice(0, 77) + '...' : str;
      }
    }
  }

  show(): void {
    this.channel.show(true);
  }

  dispose(): void {
    this.channel.dispose();
    for (const d of this.disposables) d.dispose();
  }
}
