/**
 * Task Tree View — shows running/completed/failed tasks.
 */
import * as vscode from 'vscode';
import type { SSEEvent, TaskInfo, VinyanClient } from './api-client';

type TaskStatus = 'running' | 'completed' | 'failed' | 'pending';

interface TrackedTask {
  id: string;
  goal: string;
  status: TaskStatus;
  routingLevel?: number;
  startTime: number;
  durationMs?: number;
  /**
   * Phase 0 W4: notes from the perception compressor describing what was
   * dropped (e.g. "lintWarnings: dropped 47 entries"). Surfaced in the
   * tree-item tooltip so users see redactions without opening the task panel.
   */
  compressionNotes?: string[];
}

export class TaskTreeProvider implements vscode.TreeDataProvider<TaskItem> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<TaskItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private tasks = new Map<string, TrackedTask>();
  private disposables: vscode.Disposable[] = [];

  constructor(private readonly client: VinyanClient) {
    // Track tasks from SSE events
    this.disposables.push(
      client.onSSEEvent((evt) => this.handleEvent(evt)),
    );
  }

  private handleEvent(evt: SSEEvent): void {
    const payload = evt.payload;
    const taskId = (payload.taskId as string) ??
      (payload.input as Record<string, unknown>)?.id as string ??
      (payload.result as Record<string, unknown>)?.id as string;

    if (!taskId) return;

    switch (evt.event) {
      case 'task:start': {
        const input = payload.input as Record<string, unknown> | undefined;
        const routing = payload.routing as Record<string, unknown> | undefined;
        this.tasks.set(taskId, {
          id: taskId,
          goal: (input?.goal as string) ?? 'Unknown task',
          status: 'running',
          routingLevel: routing?.level as number | undefined,
          startTime: Date.now(),
        });
        break;
      }
      case 'task:complete': {
        const existing = this.tasks.get(taskId);
        if (existing) {
          const result = payload.result as Record<string, unknown> | undefined;
          const success = result?.success as boolean ?? true;
          existing.status = success ? 'completed' : 'failed';
          existing.durationMs = Date.now() - existing.startTime;
          // Phase 0 W4: copy compressionNotes through if the result/trace
          // surfaces them. Best-effort — silently skip when absent.
          const trace = result?.trace as Record<string, unknown> | undefined;
          const notes = (trace?.compressionNotes ?? result?.compressionNotes) as string[] | undefined;
          if (Array.isArray(notes) && notes.length > 0) {
            existing.compressionNotes = notes;
          }
        }
        break;
      }
      case 'worker:complete': {
        const existing = this.tasks.get(taskId);
        if (existing) {
          // Phase 0 W4: WorkerOutput may carry compressionNotes too.
          const output = payload.output as Record<string, unknown> | undefined;
          const notes = output?.compressionNotes as string[] | undefined;
          if (Array.isArray(notes) && notes.length > 0) {
            existing.compressionNotes = notes;
          }
        }
        break;
      }
      case 'task:escalate': {
        const existing = this.tasks.get(taskId);
        if (existing) {
          existing.routingLevel = payload.toLevel as number;
        }
        break;
      }
    }

    this._onDidChangeTreeData.fire(undefined);
  }

  async refresh(): Promise<void> {
    try {
      const result = await this.client.listTasks();
      for (const task of result.tasks) {
        this.tasks.set(task.id, {
          id: task.id,
          goal: task.goal,
          status: (task.status as TaskStatus) ?? 'pending',
          routingLevel: task.routingLevel,
          startTime: task.createdAt ?? Date.now(),
          durationMs: task.durationMs,
        });
      }
    } catch {
      // Server unreachable — keep local state
    }
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(element: TaskItem): vscode.TreeItem {
    return element;
  }

  getChildren(): TaskItem[] {
    if (this.tasks.size === 0) {
      return [new TaskItem({ id: '', goal: 'No tasks', status: 'pending', startTime: 0 })];
    }

    // Sort: running first, then by start time descending
    const sorted = [...this.tasks.values()].sort((a, b) => {
      if (a.status === 'running' && b.status !== 'running') return -1;
      if (b.status === 'running' && a.status !== 'running') return 1;
      return b.startTime - a.startTime;
    });

    return sorted.map((t) => new TaskItem(t));
  }

  get activeTaskCount(): number {
    return [...this.tasks.values()].filter((t) => t.status === 'running').length;
  }

  dispose(): void {
    this._onDidChangeTreeData.dispose();
    for (const d of this.disposables) d.dispose();
  }
}

class TaskItem extends vscode.TreeItem {
  constructor(task: TrackedTask) {
    const goalExcerpt = task.goal.length > 50 ? task.goal.slice(0, 47) + '...' : task.goal;
    super(goalExcerpt, vscode.TreeItemCollapsibleState.None);

    if (!task.id) {
      this.iconPath = new vscode.ThemeIcon('info');
      return;
    }

    const icon = TaskItem.statusIcon(task.status);
    this.iconPath = icon;

    const parts: string[] = [];
    if (task.routingLevel !== undefined) {
      parts.push(`L${task.routingLevel}`);
    }
    if (task.durationMs !== undefined) {
      parts.push(TaskItem.formatDuration(task.durationMs));
    } else if (task.status === 'running') {
      parts.push(TaskItem.formatDuration(Date.now() - task.startTime));
    }
    this.description = parts.join(' · ');
    // Phase 0 W4: single-line summary of perception-compressor redactions
    // when present (e.g. "compressed: 3 notes"). Keeps the tooltip terse.
    const compressedHint = task.compressionNotes && task.compressionNotes.length > 0
      ? `\nCompressed: ${task.compressionNotes.length} notes`
      : '';
    this.tooltip = `${task.goal}\nID: ${task.id}\nStatus: ${task.status}${compressedHint}`;
  }

  private static statusIcon(status: TaskStatus): vscode.ThemeIcon {
    switch (status) {
      case 'running': return new vscode.ThemeIcon('sync~spin', new vscode.ThemeColor('charts.blue'));
      case 'completed': return new vscode.ThemeIcon('check', new vscode.ThemeColor('testing.iconPassed'));
      case 'failed': return new vscode.ThemeIcon('error', new vscode.ThemeColor('testing.iconFailed'));
      default: return new vscode.ThemeIcon('circle-outline');
    }
  }

  private static formatDuration(ms: number): string {
    if (ms < 1_000) return `${ms}ms`;
    if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}s`;
    return `${(ms / 60_000).toFixed(1)}m`;
  }
}
