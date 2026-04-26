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
  // Phase 0.5: per-tool-call lifecycle from the agent loop.
  'agent:tool_started': 'AGENT',
  'agent:tool_executed': 'AGENT',
  'agent:tool_denied': 'AGENT',
  // Phase 0.5: guardrail-detector signals surfaced via SSE.
  'guardrail:injection_detected': 'GUARDRAIL',
  'guardrail:bypass_detected': 'GUARDRAIL',
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
      case 'agent:tool_started':
        return `${p.toolName ?? '?'}`;
      case 'agent:tool_executed': {
        const mark = p.isError ? '✗' : '✓';
        return `${p.toolName} ${mark} ${p.durationMs}ms`;
      }
      case 'agent:tool_denied': {
        const violation = p.violation ? ` — ${p.violation}` : '';
        return `${p.toolName ?? '?'}${violation}`;
      }
      case 'guardrail:injection_detected':
      case 'guardrail:bypass_detected': {
        const patterns = Array.isArray(p.patterns) ? (p.patterns as string[]).join(',') : '';
        return `field=${p.field ?? '?'}${patterns ? ` [${patterns}]` : ''}`;
      }
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
