import type { Database } from 'bun:sqlite';
import type { Migration } from './migration-runner.ts';

function existingColumnNames(db: Database): Set<string> {
  const rows = db.query('PRAGMA table_info(execution_traces)').all() as Array<{ name: string }>;
  return new Set(rows.map((row) => row.name));
}

export const migration022: Migration = {
  version: 22,
  description: 'A5 oracle independence trace audit metadata',
  up(db: Database) {
    const existing = existingColumnNames(db);
    if (!existing.has('oracle_independence')) {
      db.exec('ALTER TABLE execution_traces ADD COLUMN oracle_independence TEXT');
    }
  },
};
