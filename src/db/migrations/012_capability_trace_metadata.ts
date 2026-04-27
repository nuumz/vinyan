/**
 * Migration 012 — Capability-first trace metadata.
 *
 * Persists the optional Phase D fields that phase-learn attaches to
 * ExecutionTrace so the offline sleep cycle can consume them later:
 * capability requirements, capability analysis, synthetic agent id, and
 * knowledge contexts. JSON fields are read by application code only, so no
 * indexes are added here.
 */
import type { Database } from 'bun:sqlite';
import type { Migration } from './migration-runner.ts';

interface ColumnSpec {
  name: string;
  ddl: string;
}

const COLUMNS: ColumnSpec[] = [
  { name: 'capability_requirements', ddl: 'TEXT' },
  { name: 'capability_analysis', ddl: 'TEXT' },
  { name: 'synthetic_agent_id', ddl: 'TEXT' },
  { name: 'knowledge_used', ddl: 'TEXT' },
];

function existingColumnNames(db: Database): Set<string> {
  const rows = db.query('PRAGMA table_info(execution_traces)').all() as Array<{ name: string }>;
  return new Set(rows.map((r) => r.name));
}

export const migration012: Migration = {
  version: 12,
  description: 'Capability-first trace metadata (requirements, analysis, synthetic agent, knowledge)',
  up(db: Database) {
    const existing = existingColumnNames(db);
    for (const column of COLUMNS) {
      if (existing.has(column.name)) continue;
      db.exec(`ALTER TABLE execution_traces ADD COLUMN ${column.name} ${column.ddl}`);
    }
  },
};
