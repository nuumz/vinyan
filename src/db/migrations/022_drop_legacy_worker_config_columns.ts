/**
 * Migration 022 — drop denormalized worker_profiles config columns.
 *
 * With `engine_config` JSON as the authoritative EngineConfig store (added in
 * migration 008 and made authoritative in the pre-release cleanup), the
 * individual legacy columns are pure noise. This migration removes them.
 *
 * Columns dropped:
 *   - model_version
 *   - temperature
 *   - tool_allowlist
 *   - system_prompt_tpl
 *   - max_context_tokens
 *   - engine_type
 *   - capabilities_declared
 *
 * Columns retained (required for WHERE / ORDER BY / indexing):
 *   - id, model_id, status, created_at
 *   - promoted_at, demoted_at, demotion_reason, demotion_count (lifecycle)
 *   - engine_config (authoritative config JSON)
 *
 * SQLite ≥ 3.35 supports ALTER TABLE DROP COLUMN. Idempotent: PRAGMA is
 * checked before every drop.
 */

import type { Database } from 'bun:sqlite';
import type { Migration } from './migration-runner.ts';

const LEGACY_COLUMNS = [
  'model_version',
  'temperature',
  'tool_allowlist',
  'system_prompt_tpl',
  'max_context_tokens',
  'engine_type',
  'capabilities_declared',
];

export const migration022: Migration = {
  version: 22,
  description: 'Drop legacy denormalized config columns from worker_profiles (engine_config is authoritative)',
  up(db: Database) {
    // Drop the composite identity index first — it references `temperature`
    // and `system_prompt_tpl`, both of which are about to be removed. SQLite
    // refuses the column drop otherwise.
    db.exec(`DROP INDEX IF EXISTS idx_wp_identity`);

    const cols = db.prepare("PRAGMA table_info('worker_profiles')").all() as Array<{ name: string }>;
    const existing = new Set(cols.map((c) => c.name));
    for (const col of LEGACY_COLUMNS) {
      if (existing.has(col)) {
        db.exec(`ALTER TABLE worker_profiles DROP COLUMN ${col}`);
      }
    }
  },
};
