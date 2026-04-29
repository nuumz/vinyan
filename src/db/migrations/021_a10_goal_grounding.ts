import type { Database } from 'bun:sqlite';
import type { Migration } from './migration-runner.ts';

function existingColumnNames(db: Database): Set<string> {
  const rows = db.query('PRAGMA table_info(execution_traces)').all() as Array<{ name: string }>;
  return new Set(rows.map((row) => row.name));
}

export const migration021: Migration = {
  version: 21,
  description: 'A10 goal-and-time grounding trace audit column',
  up(db: Database) {
    const existing = existingColumnNames(db);
    if (!existing.has('goal_grounding')) {
      db.exec('ALTER TABLE execution_traces ADD COLUMN goal_grounding TEXT');
    }
  },
};