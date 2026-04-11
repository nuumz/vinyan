/**
 * Migration 011 — Add understanding snapshot columns to execution_traces.
 *
 * STU Phase D: Enables A7 calibration by recording understanding depth,
 * semantic intent, resolved entities, and verification status per trace.
 */
import type { Database } from 'bun:sqlite';
import type { Migration } from './migration-runner.ts';

export const migration011: Migration = {
  version: 11,
  description: 'Add understanding snapshot columns to execution_traces (STU Phase D)',
  up(db: Database): void {
    db.exec('ALTER TABLE execution_traces ADD COLUMN understanding_depth INTEGER');
    db.exec('ALTER TABLE execution_traces ADD COLUMN understanding_intent TEXT');
    db.exec('ALTER TABLE execution_traces ADD COLUMN resolved_entities TEXT');
    db.exec('ALTER TABLE execution_traces ADD COLUMN understanding_verified INTEGER DEFAULT 0');
    db.exec('ALTER TABLE execution_traces ADD COLUMN understanding_primary_action TEXT');
    db.exec('CREATE INDEX IF NOT EXISTS idx_primary_action ON execution_traces(understanding_primary_action)');
  },
};
