/**
 * ShadowStore — SQLite persistence for shadow validation jobs.
 *
 * CRUD for ShadowJob lifecycle: pending → running → done/failed.
 * Crash-safety: jobs are inserted as 'pending' BEFORE online response returns.
 *
 * Source of truth: spec/tdd.md §12B (Shadow Execution)
 */
import type { Database } from 'bun:sqlite';
import type { ShadowJob, ShadowValidationResult } from '../orchestrator/types.ts';

export class ShadowStore {
  private db: Database;
  private insertStmt;

  constructor(db: Database) {
    this.db = db;
    this.insertStmt = db.prepare(`
      INSERT INTO shadow_jobs (
        id, task_id, status, enqueued_at, started_at, completed_at,
        result, mutations, retry_count, max_retries
      ) VALUES (
        $id, $task_id, $status, $enqueued_at, $started_at, $completed_at,
        $result, $mutations, $retry_count, $max_retries
      )
    `);
  }

  insert(job: ShadowJob & { mutations: Array<{ file: string; content: string }> }): void {
    this.insertStmt.run({
      $id: job.id,
      $task_id: job.taskId,
      $status: job.status,
      $enqueued_at: job.enqueuedAt,
      $started_at: job.startedAt ?? null,
      $completed_at: job.completedAt ?? null,
      $result: job.result ? JSON.stringify(job.result) : null,
      $mutations: JSON.stringify(job.mutations),
      $retry_count: job.retryCount,
      $max_retries: job.maxRetries,
    });
  }

  updateStatus(id: string, status: ShadowJob['status'], result?: ShadowValidationResult): void {
    const now = Date.now();
    if (status === 'running') {
      this.db.prepare(`UPDATE shadow_jobs SET status = ?, started_at = ? WHERE id = ?`).run(status, now, id);
    } else if (status === 'done' || status === 'failed') {
      this.db
        .prepare(`UPDATE shadow_jobs SET status = ?, completed_at = ?, result = ? WHERE id = ?`)
        .run(status, now, result ? JSON.stringify(result) : null, id);
    } else {
      this.db.prepare(`UPDATE shadow_jobs SET status = ? WHERE id = ?`).run(status, id);
    }
  }

  incrementRetry(id: string): void {
    this.db.prepare(`UPDATE shadow_jobs SET retry_count = retry_count + 1 WHERE id = ?`).run(id);
  }

  findPending(): ShadowJobWithMutations[] {
    const rows = this.db.prepare(`SELECT * FROM shadow_jobs WHERE status = 'pending' ORDER BY enqueued_at ASC`).all();
    return rows.map(rowToShadowJob);
  }

  /**
   * Atomically claim the next pending shadow job for processing.
   * Uses a transaction to SELECT + UPDATE in one step, preventing
   * race conditions when multiple runners compete for jobs.
   */
  claimNextPending(): ShadowJobWithMutations | null {
    const txn = this.db.transaction(() => {
      const row = this.db
        .prepare(`SELECT * FROM shadow_jobs WHERE status = 'pending' ORDER BY enqueued_at ASC LIMIT 1`)
        .get();
      if (!row) return null;
      const updated = this.db
        .prepare(`UPDATE shadow_jobs SET status = 'running', started_at = ? WHERE id = ? AND status = 'pending'`)
        .run(Date.now(), (row as any).id);
      if (updated.changes === 0) return null;
      return rowToShadowJob(row);
    });
    return txn();
  }

  findByTaskId(taskId: string): ShadowJobWithMutations | null {
    const row = this.db
      .prepare(`SELECT * FROM shadow_jobs WHERE task_id = ? ORDER BY enqueued_at DESC LIMIT 1`)
      .get(taskId);
    return row ? rowToShadowJob(row) : null;
  }

  findByStatus(status: ShadowJob['status']): ShadowJobWithMutations[] {
    const rows = this.db.prepare(`SELECT * FROM shadow_jobs WHERE status = ? ORDER BY enqueued_at ASC`).all(status);
    return rows.map(rowToShadowJob);
  }

  count(): number {
    const row = this.db.prepare(`SELECT COUNT(*) as cnt FROM shadow_jobs`).get() as { cnt: number };
    return row.cnt;
  }

  countByStatus(status: ShadowJob['status']): number {
    const row = this.db.prepare(`SELECT COUNT(*) as cnt FROM shadow_jobs WHERE status = ?`).get(status) as {
      cnt: number;
    };
    return row.cnt;
  }
}

// ── Types ─────────────────────────────────────────────────────────────────

export type ShadowJobWithMutations = ShadowJob & {
  mutations: Array<{ file: string; content: string }>;
};

// ── Row deserialization ───────────────────────────────────────────────────

function rowToShadowJob(row: any): ShadowJobWithMutations {
  return {
    id: row.id,
    taskId: row.task_id,
    status: row.status,
    enqueuedAt: row.enqueued_at,
    startedAt: row.started_at ?? undefined,
    completedAt: row.completed_at ?? undefined,
    result: row.result ? JSON.parse(row.result) : undefined,
    mutations: JSON.parse(row.mutations),
    retryCount: row.retry_count,
    maxRetries: row.max_retries,
  };
}
