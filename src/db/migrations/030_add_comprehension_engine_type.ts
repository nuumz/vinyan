/**
 * Migration 030 — Add `engine_type` column to `comprehension_records`.
 *
 * AXM#4 (A6 defense-in-depth): calibration integrity depends on
 * correctly attributing outcomes to the RIGHT engine. Prior to this
 * migration, records only carried `engine_id` — a free-form string
 * self-reported by the engine. A collision (bug or rogue) would
 * corrupt calibration for that ID.
 *
 * `engine_type` is the declared type ('rule'|'symbolic'|'hybrid'|
 * 'llm'|'external') captured at record time. The calibrator can
 * separate engines by type, and dashboards can audit whether a
 * type-mismatch ever occurred.
 *
 * Backfill: existing rows get `engine_type = 'rule'` because the only
 * engine that existed before this migration was the rule comprehender.
 * This is historically accurate — `rule-comprehender` was the sole
 * emitter in P2.A timeframe.
 */
import type { Database } from 'bun:sqlite';
import type { Migration } from './migration-runner.ts';

export const migration030: Migration = {
  version: 30,
  description: 'Add engine_type to comprehension_records for AXM#4 calibration integrity',
  up(db: Database): void {
    const cols = db
      .prepare("PRAGMA table_info('comprehension_records')")
      .all() as Array<{ name: string }>;
    const hasEngineType = cols.some((c) => c.name === 'engine_type');
    if (!hasEngineType) {
      db.exec(`ALTER TABLE comprehension_records ADD COLUMN engine_type TEXT`);
      // Backfill historical rows — the rule comprehender was the only
      // P2.A emitter, so all existing records are safely labeled 'rule'.
      db.exec(`UPDATE comprehension_records SET engine_type = 'rule' WHERE engine_type IS NULL`);
    }
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_cr_engine_type ON comprehension_records(engine_type, created_at DESC)`,
    );
  },
};
