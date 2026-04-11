/**
 * Migration 007 — Add `composed_of` column to cached_skills.
 *
 * Supports hierarchical skill composition: a composed skill references
 * sub-skill task_signatures as a JSON array.
 */
import type { Database } from 'bun:sqlite';
import type { Migration } from './migration-runner.ts';

export const migration007: Migration = {
  version: 7,
  description: 'Add composed_of column to cached_skills for hierarchical skill composition',
  up(db: Database): void {
    try {
      db.exec('ALTER TABLE cached_skills ADD COLUMN composed_of TEXT DEFAULT NULL');
    } catch {
      /* column already exists */
    }
  },
};
