/**
 * Migration 010 — Add action_verb column to rejected_approaches.
 *
 * Gap 6B: Enables cross-task loader to filter by action verb,
 * preventing fix-task failures from constraining refactor-tasks on the same file.
 */
import type { Database } from 'bun:sqlite';
import type { Migration } from './migration-runner.ts';

export const migration010: Migration = {
  version: 10,
  description: 'Add action_verb column to rejected_approaches for goal-aware cross-task loading (Gap 6B)',
  up(db: Database): void {
    db.exec('ALTER TABLE rejected_approaches ADD COLUMN action_verb TEXT');
    db.exec('CREATE INDEX IF NOT EXISTS idx_rejected_action_verb ON rejected_approaches(file_target, task_type, action_verb)');
  },
};
