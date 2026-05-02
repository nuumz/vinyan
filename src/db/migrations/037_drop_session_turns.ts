/**
 * Migration 037 — Phase 4 destructive: DROP TABLE session_turns.
 *
 * **NOT registered in `ALL_MIGRATIONS`**. Applied via `vinyan session
 * migrate-phase4` only, after the operator has verified that
 *
 *   1. Phase 2 dual-write has been stable for ≥7 days,
 *   2. `session.readFromJsonl.*` flags are on and `session_read_ab_drift_total`
 *      reads zero,
 *   3. `vinyan session backfill` has produced an `events.jsonl` for every
 *      session that should keep its turn history,
 *
 * because once this lands, `session_turns` is gone forever.
 *
 * After this runs, SessionStore detects the missing table at construction
 * (and after `refreshSchemaState()`) and gracefully degrades the turn
 * methods — no SQL errors. JSONL is the authoritative turn store.
 *
 * Companion to migration 038 (drops `session_store` blob columns).
 *
 * Safety:
 *   - I16: the per-session events.jsonl audit chain is preserved on
 *     disk; only the SQLite index of turns disappears.
 *   - turn_embeddings (sqlite-vec virtual table) loses its FK target.
 *     Per session-store.ts:617, the FK was on session_turns(id) — not
 *     a `REFERENCES … ON DELETE CASCADE`, so the rows in turn_embeddings
 *     remain. This migration leaves them in place to avoid evicting
 *     learned embeddings for sessions that may still be queried via
 *     JSONL replay; a follow-up sweep can prune them once Phase 4.5
 *     reroutes retrieval.ts through JsonlReadAdapter.
 */
import type { Database } from 'bun:sqlite';
import type { Migration } from './migration-runner.ts';

export const migration037: Migration = {
  version: 37,
  description: 'Phase 4: drop session_turns table (JSONL is now authoritative)',
  up(db: Database) {
    // Indices are dropped automatically when the table is dropped;
    // explicit `DROP INDEX` is not needed.
    db.exec('DROP TABLE IF EXISTS session_turns');
  },
};
