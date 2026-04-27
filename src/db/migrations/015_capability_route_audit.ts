/**
 * Migration 015 — Capability route audit metadata.
 *
 * Denormalizes the selected profile provenance and fit summary from
 * capability_analysis so dashboards and trace audits can explain why a route
 * happened without parsing the full JSON blob.
 */
import type { Database } from 'bun:sqlite';
import type { Migration } from './migration-runner.ts';

interface ColumnSpec {
  name: string;
  ddl: string;
}

const COLUMNS: ColumnSpec[] = [
  { name: 'agent_selection_reason', ddl: 'TEXT' },
  { name: 'selected_capability_profile_id', ddl: 'TEXT' },
  { name: 'selected_capability_profile_source', ddl: 'TEXT' },
  { name: 'selected_capability_profile_trust_tier', ddl: 'TEXT' },
  { name: 'capability_fit_score', ddl: 'REAL' },
  { name: 'unmet_capability_ids', ddl: 'TEXT' },
];

function existingColumnNames(db: Database): Set<string> {
  const rows = db.query('PRAGMA table_info(execution_traces)').all() as Array<{ name: string }>;
  return new Set(rows.map((row) => row.name));
}

export const migration015: Migration = {
  version: 15,
  description: 'Capability route audit metadata (selection reason, profile provenance, fit, unmet ids)',
  up(db: Database) {
    const existing = existingColumnNames(db);
    for (const column of COLUMNS) {
      if (existing.has(column.name)) continue;
      db.exec(`ALTER TABLE execution_traces ADD COLUMN ${column.name} ${column.ddl}`);
    }
  },
};
