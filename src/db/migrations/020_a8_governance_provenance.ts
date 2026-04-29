/**
 * Migration 020 — A8 governance provenance metadata.
 *
 * Stores the full replay envelope as JSON and denormalizes only the fields
 * needed for audit queries without parsing the evidence chain.
 */
import type { Database } from 'bun:sqlite';
import type { Migration } from './migration-runner.ts';

interface ColumnSpec {
  name: string;
  ddl: string;
}

const COLUMNS: ColumnSpec[] = [
  { name: 'governance_provenance', ddl: 'TEXT' },
  { name: 'routing_decision_id', ddl: 'TEXT' },
  { name: 'policy_version', ddl: 'TEXT' },
  { name: 'governance_actor', ddl: 'TEXT' },
  { name: 'decision_timestamp', ddl: 'INTEGER' },
  { name: 'evidence_observed_at', ddl: 'INTEGER' },
];

function existingColumnNames(db: Database): Set<string> {
  const rows = db.query('PRAGMA table_info(execution_traces)').all() as Array<{ name: string }>;
  return new Set(rows.map((row) => row.name));
}

export const migration020: Migration = {
  version: 20,
  description: 'A8 governance provenance envelope and audit query columns',
  up(db: Database) {
    const existing = existingColumnNames(db);
    for (const column of COLUMNS) {
      if (existing.has(column.name)) continue;
      db.exec(`ALTER TABLE execution_traces ADD COLUMN ${column.name} ${column.ddl}`);
    }

    db.exec('CREATE INDEX IF NOT EXISTS idx_et_routing_decision_id ON execution_traces(routing_decision_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_et_policy_version ON execution_traces(policy_version)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_et_governance_actor ON execution_traces(governance_actor)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_et_decision_timestamp ON execution_traces(decision_timestamp)');
  },
};
