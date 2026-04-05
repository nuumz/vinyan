/**
 * Migration 009 — Evidence archive tables for cross-task learning.
 *
 * Two new tables:
 *
 *   rejected_approaches — Operational history of failed approaches (Vinyan DB).
 *     Sources: task-end serialization, working memory eviction, cross-task loading.
 *     Enables cross-task learning: Task B loads Task A's verified failures.
 *     Design ref: memory-prompt-architecture-system-design.md §2.2a, §4.1 (G2, G5)
 *
 *   failed_verdicts — Failed oracle verdicts (World Graph DB, separate migration).
 *     Preserves negative verification results that currently vanish at task boundary.
 *     Design ref: memory-prompt-architecture-system-design.md §4.1 (G5), §8.2
 */
import type { Database } from 'bun:sqlite';
import type { Migration } from './migration-runner.ts';

export const migration009: Migration = {
  version: 9,
  description: 'Add rejected_approaches table for cross-task learning (G2+G5)',
  up(db: Database): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS rejected_approaches (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        task_type TEXT,
        file_target TEXT,
        file_hash TEXT,
        approach TEXT NOT NULL,
        oracle_verdict TEXT NOT NULL,
        verdict_confidence REAL,
        failure_oracle TEXT,
        routing_level INTEGER,
        source TEXT DEFAULT 'task-end',
        created_at INTEGER NOT NULL,
        expires_at INTEGER
      )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_rejected_file_type ON rejected_approaches(file_target, task_type)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_rejected_expires ON rejected_approaches(expires_at)');
  },
};
