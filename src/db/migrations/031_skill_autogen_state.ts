/**
 * Migration 031 — Skill autogenerator restart-safe tracker state.
 *
 * R3: persist the per-`(profile, agentId, taskSignature)` success
 * counter so a server restart does not lose progress AND does not
 * promote a half-counted signature.
 *
 * Schema design:
 *   - `signature_key` is the canonical `<agentId | 'shared'>:<taskSig>`
 *     used by the in-memory tracker. PRIMARY KEY guards the single-
 *     writer-per-key invariant.
 *   - `successes` and `last_seen` are the durable counters.
 *   - `boot_id` records the runtime that last touched this row. On
 *     boot, the autogenerator stamps a fresh boot id so we can
 *     distinguish "evidence collected this run" from "evidence carried
 *     over from a previous boot." Promotion on the very first emit
 *     post-restart is gated on `successes_since_boot` (computed from
 *     `successes - successes_at_boot`) reaching the post-restart
 *     evidence floor.
 *   - `successes_at_boot` is a snapshot of `successes` taken at
 *     reconciliation time. Read by the listener to compute "successes
 *     since the runtime came up" without a separate map.
 *   - `cooldown_until` is an epoch-ms gate that prevents the same
 *     signature from generating multiple proposals in a debounce
 *     window after the threshold first fires.
 *   - `state_version` future-proofs the schema; `1` is the only valid
 *     value today. Boot reconciliation drops rows with an unknown
 *     version.
 *
 * `task_ids_json` carries the bounded ring of last-25 task ids the
 * tracker would have surfaced as `sourceTaskIds` on the next emit;
 * persisted so a restart does not lose provenance.
 *
 * Index on `last_seen` powers the TTL prune at boot (drops stale rows
 * older than `MAX_TRACKER_AGE_MS`).
 */
import type { Database } from 'bun:sqlite';
import type { Migration } from './migration-runner.ts';

export const migration031: Migration = {
  version: 31,
  description: 'skill_autogen_state — restart-safe per-signature tracker',
  up(db: Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS skill_autogen_state (
        signature_key       TEXT NOT NULL,
        profile             TEXT NOT NULL DEFAULT 'default',
        successes           INTEGER NOT NULL DEFAULT 0,
        successes_at_boot   INTEGER NOT NULL DEFAULT 0,
        last_seen           INTEGER NOT NULL,
        boot_id             TEXT,
        cooldown_until      INTEGER NOT NULL DEFAULT 0,
        task_ids_json       TEXT NOT NULL DEFAULT '[]',
        state_version       INTEGER NOT NULL DEFAULT 1,
        last_emitted_at     INTEGER,
        PRIMARY KEY (profile, signature_key)
      );
      CREATE INDEX IF NOT EXISTS idx_skill_autogen_state_last_seen
        ON skill_autogen_state(last_seen);
      CREATE INDEX IF NOT EXISTS idx_skill_autogen_state_boot
        ON skill_autogen_state(boot_id);
    `);
  },
};
