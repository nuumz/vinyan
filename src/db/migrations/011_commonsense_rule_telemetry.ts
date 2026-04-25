/**
 * Migration 011 — Common Sense Substrate rule telemetry + retirement.
 *
 * Adds firing/override counters and `retired_at` to `commonsense_rules` to
 * enable Phase 2.5 Appendix C #6 (Override-rate demotion). The columns
 * power the demotion criterion documented in
 * `docs/design/commonsense-substrate-system-design.md` §6 (M4 v2):
 *
 *   demote when firing_count ≥ 100 AND override_count / firing_count > 0.5
 *
 * `retired_at` is the demotion ledger. `findApplicable` filters
 * `WHERE retired_at IS NULL` so retired rules drop out of activation without
 * being deleted (preserves audit trail).
 *
 * Idempotency:
 *   - `PRAGMA table_info(commonsense_rules)` guards every ADD COLUMN.
 *   - Indexes use `IF NOT EXISTS`.
 *
 * No CHECK constraints — counters are non-negative by application contract,
 * timestamps are nullable INTEGER.
 */
import type { Database } from 'bun:sqlite';
import type { Migration } from './migration-runner.ts';

interface ColumnSpec {
  name: string;
  ddl: string;
}

const COLUMNS: ColumnSpec[] = [
  { name: 'firing_count', ddl: 'INTEGER NOT NULL DEFAULT 0' },
  { name: 'override_count', ddl: 'INTEGER NOT NULL DEFAULT 0' },
  { name: 'last_fired_at', ddl: 'INTEGER' },
  { name: 'retired_at', ddl: 'INTEGER' },
];

function existingColumnNames(db: Database): Set<string> {
  const rows = db.query('PRAGMA table_info(commonsense_rules)').all() as Array<{ name: string }>;
  return new Set(rows.map((r) => r.name));
}

export const migration011: Migration = {
  version: 11,
  description: 'CommonSense rule telemetry + retirement (firing_count, override_count, last_fired_at, retired_at)',
  up(db: Database) {
    const existing = existingColumnNames(db);
    for (const column of COLUMNS) {
      if (existing.has(column.name)) continue;
      db.exec(`ALTER TABLE commonsense_rules ADD COLUMN ${column.name} ${column.ddl}`);
    }

    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_commonsense_retired_at
        ON commonsense_rules(retired_at);
      CREATE INDEX IF NOT EXISTS idx_commonsense_firing_count
        ON commonsense_rules(firing_count DESC);
    `);
  },
};
