/**
 * TaskCheckpointStore — SQLite persistence for crash recovery.
 *
 * Records task state before dispatch so interrupted tasks can be
 * detected and abandoned on restart. Follows dual-write pattern
 * consistent with ShadowStore, TraceStore.
 *
 * Crash-safety: checkpoint persisted BEFORE WorkerPool.dispatch().
 * On restart: findDispatched() returns interrupted tasks → mark abandoned.
 *
 * Schema is self-initialized (CREATE TABLE IF NOT EXISTS).
 */
import type { Database } from 'bun:sqlite';

export interface TaskCheckpoint {
  taskId: string;
  inputJson: string;
  routingLevel: number;
  planJson: string | null;
  perceptionJson: string | null;
  status: 'dispatched' | 'completed' | 'failed' | 'abandoned';
  attemptCount: number;
  errorReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export class TaskCheckpointStore {
  private saveStmt;
  private completeStmt;
  private failStmt;
  private abandonStmt;
  private findDispatchedStmt;
  private cleanupStmt;

  constructor(private db: Database) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS task_checkpoints (
        task_id TEXT PRIMARY KEY,
        input_json TEXT NOT NULL,
        routing_level INTEGER NOT NULL,
        plan_json TEXT,
        perception_json TEXT,
        status TEXT NOT NULL DEFAULT 'dispatched',
        attempt_count INTEGER NOT NULL DEFAULT 1,
        error_reason TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_checkpoint_status ON task_checkpoints(status)
    `);

    this.saveStmt = this.db.prepare(`
      INSERT OR REPLACE INTO task_checkpoints
        (task_id, input_json, routing_level, plan_json, perception_json, status, attempt_count, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'dispatched', ?, datetime('now'), datetime('now'))
    `);

    this.completeStmt = this.db.prepare(`
      UPDATE task_checkpoints SET status = 'completed', updated_at = datetime('now') WHERE task_id = ?
    `);

    this.failStmt = this.db.prepare(`
      UPDATE task_checkpoints SET status = 'failed', error_reason = ?, updated_at = datetime('now') WHERE task_id = ?
    `);

    this.abandonStmt = this.db.prepare(`
      UPDATE task_checkpoints SET status = 'abandoned', updated_at = datetime('now') WHERE task_id = ?
    `);

    this.findDispatchedStmt = this.db.prepare(`
      SELECT * FROM task_checkpoints WHERE status = 'dispatched' ORDER BY created_at ASC
    `);

    this.cleanupStmt = this.db.prepare(`
      DELETE FROM task_checkpoints
      WHERE status IN ('completed', 'failed', 'abandoned')
        AND updated_at < datetime('now', ? || ' seconds')
    `);
  }

  /** Persist checkpoint before dispatch. INSERT OR REPLACE for idempotent retries. */
  save(checkpoint: Pick<TaskCheckpoint, 'taskId' | 'inputJson' | 'routingLevel' | 'planJson' | 'perceptionJson' | 'attemptCount'>): void {
    this.saveStmt.run(
      checkpoint.taskId,
      checkpoint.inputJson,
      checkpoint.routingLevel,
      checkpoint.planJson ?? null,
      checkpoint.perceptionJson ?? null,
      checkpoint.attemptCount,
    );
  }

  /** Mark task as successfully completed. */
  complete(taskId: string): void {
    this.completeStmt.run(taskId);
  }

  /** Mark task as failed with reason. */
  fail(taskId: string, reason: string): void {
    this.failStmt.run(reason, taskId);
  }

  /** Mark task as abandoned (interrupted by crash/restart). */
  abandon(taskId: string): void {
    this.abandonStmt.run(taskId);
  }

  /** Find all tasks that were dispatched but never completed/failed (crash survivors). */
  findDispatched(): TaskCheckpoint[] {
    return (this.findDispatchedStmt.all() as any[]).map(rowToCheckpoint);
  }

  /** Remove completed/failed/abandoned checkpoints older than threshold. Returns count deleted. */
  cleanup(olderThanMs: number): number {
    const seconds = -Math.floor(olderThanMs / 1000);
    const result = this.cleanupStmt.run(String(seconds));
    return result.changes;
  }
}

function rowToCheckpoint(row: any): TaskCheckpoint {
  return {
    taskId: row.task_id,
    inputJson: row.input_json,
    routingLevel: row.routing_level,
    planJson: row.plan_json ?? null,
    perceptionJson: row.perception_json ?? null,
    status: row.status,
    attemptCount: row.attempt_count,
    errorReason: row.error_reason ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
