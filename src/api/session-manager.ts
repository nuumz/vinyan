/**
 * Session Manager — groups tasks under sessions with compaction.
 *
 * A3 compliance: compaction is rule-based extraction, not LLM-generated.
 * I16: Original JSONL audit trail is never deleted by compaction.
 *
 * Source of truth: spec/tdd.md §22.3, §22.4
 */
import type { SessionRow, SessionStore } from '../db/session-store.ts';
import type { TraceStore } from '../db/trace-store.ts';
import type { TaskInput, TaskResult } from '../orchestrator/types.ts';

export interface Session {
  id: string;
  source: string;
  status: SessionRow['status'];
  createdAt: number;
  taskCount: number;
}

export interface CompactionResult {
  sessionId: string;
  episodeSummary: string;
  keyFailures: string[];
  successfulPatterns: string[];
  statistics: {
    totalTasks: number;
    successRate: number;
    avgDurationMs: number;
    totalTokens: number;
  };
  compactedAt: number;
}

export class SessionManager {
  constructor(
    private sessionStore: SessionStore,
    _traceStore?: TraceStore,
  ) {}

  create(source: string): Session {
    const id = crypto.randomUUID();
    const now = Date.now();

    this.sessionStore.insertSession({
      id,
      source,
      created_at: now,
      status: 'active',
      working_memory_json: null,
      compaction_json: null,
      updated_at: now,
    });

    return { id, source, status: 'active', createdAt: now, taskCount: 0 };
  }

  listSessions(): Session[] {
    const active = this.sessionStore.listActiveSessions();
    const suspended = this.sessionStore.listSuspendedSessions();
    return [...active, ...suspended].map((row) => ({
      id: row.id,
      source: row.source,
      status: row.status as Session['status'],
      createdAt: row.created_at,
      taskCount: 0,
    }));
  }

  get(sessionId: string): Session | undefined {
    const row = this.sessionStore.getSession(sessionId);
    if (!row) return undefined;

    return {
      id: row.id,
      source: row.source,
      status: row.status,
      createdAt: row.created_at,
      taskCount: this.sessionStore.countSessionTasks(sessionId),
    };
  }

  addTask(sessionId: string, taskInput: TaskInput): void {
    this.sessionStore.insertTask({
      session_id: sessionId,
      task_id: taskInput.id,
      task_input_json: JSON.stringify(taskInput),
      status: 'pending',
      result_json: null,
      created_at: Date.now(),
    });
  }

  completeTask(sessionId: string, taskId: string, result: TaskResult): void {
    this.sessionStore.updateTaskStatus(
      sessionId,
      taskId,
      result.status === 'completed' ? 'completed' : 'failed',
      JSON.stringify(result),
    );
  }

  /**
   * Rule-based session compaction (A3-compliant — no LLM in this path).
   *
   * Extracts patterns from completed tasks without deleting audit data (I16).
   */
  compact(sessionId: string): CompactionResult {
    const tasks = this.sessionStore.listSessionTasks(sessionId);
    const completedTasks = tasks.filter((t) => t.status === 'completed' || t.status === 'failed');

    // Compute statistics
    let totalDurationMs = 0;
    let totalTokens = 0;
    let successes = 0;
    const failures: string[] = [];
    const patterns: string[] = [];

    for (const task of completedTasks) {
      if (task.result_json) {
        try {
          const result = JSON.parse(task.result_json) as TaskResult;
          totalDurationMs += result.trace?.durationMs ?? 0;
          totalTokens += result.trace?.tokensConsumed ?? 0;

          if (result.status === 'completed') {
            successes++;
            // Extract successful approach as pattern
            if (result.trace?.approach) {
              patterns.push(`${result.trace.taskTypeSignature}: ${result.trace.approach}`);
            }
          } else {
            if (result.escalationReason) failures.push(result.escalationReason);
            else if (result.trace?.failureReason) failures.push(result.trace.failureReason);
          }
        } catch {
          // Malformed result — skip
        }
      }
    }

    const totalTasks = completedTasks.length;
    const compactionResult: CompactionResult = {
      sessionId,
      episodeSummary: `Session with ${totalTasks} tasks: ${successes} succeeded, ${totalTasks - successes} failed`,
      keyFailures: [...new Set(failures)].slice(0, 10),
      successfulPatterns: [...new Set(patterns)].slice(0, 10),
      statistics: {
        totalTasks,
        successRate: totalTasks > 0 ? successes / totalTasks : 0,
        avgDurationMs: totalTasks > 0 ? totalDurationMs / totalTasks : 0,
        totalTokens,
      },
      compactedAt: Date.now(),
    };

    // Persist compaction result — additive only, never deletes audit trail (I16)
    this.sessionStore.updateSessionCompaction(sessionId, JSON.stringify(compactionResult));

    return compactionResult;
  }

  /**
   * Recover suspended sessions on startup.
   */
  recover(): Session[] {
    const suspended = this.sessionStore.listSuspendedSessions();
    return suspended.map((row) => ({
      id: row.id,
      source: row.source,
      status: row.status,
      createdAt: row.created_at,
      taskCount: this.sessionStore.countSessionTasks(row.id),
    }));
  }

  /**
   * Suspend all active sessions (for graceful shutdown).
   */
  suspendAll(): number {
    const active = this.sessionStore.listActiveSessions();
    for (const session of active) {
      this.sessionStore.updateSessionStatus(session.id, 'suspended');
    }
    return active.length;
  }
}
