/**
 * Migration 013 — allow offline-only capability-promotion rule records.
 *
 * `promote-capability` is intentionally rejected by safety invariants for
 * online rule execution, but historical/imported rows still need to survive
 * DB deserialization so the sleep cycle can retire/quarantine them cleanly.
 * SQLite cannot alter CHECK constraints in place, so this rebuilds the table.
 */
import type { Database } from 'bun:sqlite';
import type { Migration } from './migration-runner.ts';

const ACTION_CHECK =
  "'escalate','require-oracle','prefer-model','adjust-threshold','assign-worker','promote-capability'";

function currentTableSql(db: Database): string | null {
  const row = db
    .query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'evolutionary_rules'")
    .get() as { sql: string } | null;
  return row?.sql ?? null;
}

export const migration013: Migration = {
  version: 13,
  description: 'Allow offline-only promote-capability evolutionary rule action',
  up(db: Database) {
    const sql = currentTableSql(db);
    if (!sql || sql.includes('promote-capability')) return;

    db.exec(`
      DROP INDEX IF EXISTS idx_rules_status;
      DROP INDEX IF EXISTS idx_rules_action;

      ALTER TABLE evolutionary_rules RENAME TO evolutionary_rules_old;

      CREATE TABLE evolutionary_rules (
        id            TEXT PRIMARY KEY,
        source        TEXT NOT NULL CHECK(source IN ('sleep-cycle','manual')),
        condition     TEXT NOT NULL,
        action        TEXT NOT NULL CHECK(action IN (${ACTION_CHECK})),
        parameters    TEXT NOT NULL,
        status        TEXT NOT NULL CHECK(status IN ('probation','active','retired')),
        created_at    INTEGER NOT NULL,
        effectiveness REAL NOT NULL DEFAULT 0.0,
        specificity   INTEGER NOT NULL DEFAULT 0,
        superseded_by TEXT,
        origin        TEXT CHECK(origin IN ('local','a2a','mcp')) DEFAULT 'local'
      );

      INSERT INTO evolutionary_rules (
        id, source, condition, action, parameters,
        status, created_at, effectiveness, specificity, superseded_by, origin
      )
      SELECT
        id, source, condition, action, parameters,
        status, created_at, effectiveness, specificity, superseded_by, origin
      FROM evolutionary_rules_old;

      DROP TABLE evolutionary_rules_old;

      CREATE INDEX IF NOT EXISTS idx_rules_status ON evolutionary_rules(status);
      CREATE INDEX IF NOT EXISTS idx_rules_action ON evolutionary_rules(action);
    `);
  },
};
