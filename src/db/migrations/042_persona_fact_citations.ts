/**
 * Migration 042 — Phase C1: persona_fact_citations table.
 *
 * Records every (persona, file-target) pair that produced a `verified`
 * oracle verdict during a task. The DelusionDetector (Phase C2) compares
 * `cited_at_hash` against the file's CURRENT hash at audit time:
 *
 *   - cited_at_hash === current_hash → citation still consistent
 *   - cited_at_hash !== current_hash → persona "believed" file at hash H1
 *     but file is now H2; their cached belief is stale → DELUSION
 *
 * Append-only ledger; no FK to `facts` (which cascade-deletes on
 * `file_hashes` change via the trigger from migration 001). Citation
 * rows are intentionally orphaned by that cascade — that orphaning is
 * what the DelusionDetector exploits to detect drift.
 *
 * Schema decisions:
 *   - `fact_id` is the verdict's target string (file path or symbol),
 *     NOT a foreign key to `facts.id`. Keeps the table self-contained
 *     and resilient to fact-table cleanup. DelusionDetector's check
 *     becomes `current_hash_of(fact_id) !== cited_at_hash`.
 *   - `claim_excerpt` is a truncated (≤256 char) excerpt of the
 *     persona's worker output at the time of citation. Surfaces "what
 *     the persona was working on" to audit consumers; not load-bearing
 *     for delusion detection itself.
 *   - Composite PK on (persona_id, fact_id, task_id, cited_at_ts) —
 *     `cited_at_ts` is millisecond-resolution so two citations of the
 *     same fact in the same task collide only inside a single ms (the
 *     INSERT OR IGNORE swallows the dup).
 *
 * Three indexes cover the access patterns:
 *   - (persona_id, cited_at_ts DESC) — DelusionDetector scans recent
 *     citations for a persona to compare against current hashes.
 *   - (fact_id) — when a single file mutates, find every persona that
 *     cited it (cross-persona impact analysis).
 *   - (task_id) — replay one task's belief set.
 *
 * Idempotent: `CREATE TABLE IF NOT EXISTS` + `CREATE INDEX IF NOT EXISTS`.
 */
import type { Database } from 'bun:sqlite';
import type { Migration } from './migration-runner.ts';

export const migration042: Migration = {
  version: 42,
  description: 'persona_fact_citations table for Phase C1 (DelusionDetector substrate)',
  up(db: Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS persona_fact_citations (
        persona_id     TEXT NOT NULL,
        fact_id        TEXT NOT NULL,
        cited_at_hash  TEXT NOT NULL,
        cited_at_ts    INTEGER NOT NULL,
        task_id        TEXT NOT NULL,
        phase          TEXT NOT NULL,
        claim_excerpt  TEXT NOT NULL,
        PRIMARY KEY (persona_id, fact_id, task_id, cited_at_ts)
      )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_pfc_persona_ts ON persona_fact_citations (persona_id, cited_at_ts DESC)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_pfc_fact ON persona_fact_citations (fact_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_pfc_task ON persona_fact_citations (task_id)');
  },
};
