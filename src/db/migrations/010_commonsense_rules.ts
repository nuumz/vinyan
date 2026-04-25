/**
 * Migration 010 — Common Sense Substrate registry.
 *
 * Stores defeasible-prior rules (Phase 2.5) consumed by the future
 * CommonSenseOracle. See `docs/design/commonsense-substrate-system-design.md`.
 *
 * Each row is content-addressed: `id` is SHA-256 of (microtheory_lang +
 * microtheory_domain + microtheory_action + pattern + default_outcome). Same
 * tuple → same id (idempotent insert).
 *
 * Rules are tier-stamped at the `pragmatic` confidence band [0.5, 0.7] (A5
 * extension). Application is deterministic (A3): pattern match + abnormality
 * predicate eval, no LLM in the path.
 */
import type { Database } from 'bun:sqlite';
import type { Migration } from './migration-runner.ts';

export const migration010: Migration = {
  version: 10,
  description: 'Common Sense Substrate registry (Phase 2.5)',
  up(db: Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS commonsense_rules (
        id                       TEXT PRIMARY KEY,
        microtheory_lang         TEXT NOT NULL,
        microtheory_domain       TEXT NOT NULL,
        microtheory_action       TEXT NOT NULL,
        pattern                  TEXT NOT NULL,
        default_outcome          TEXT NOT NULL
                                   CHECK(default_outcome IN (
                                     'allow','block','needs-confirmation','escalate'
                                   )),
        abnormality_predicate    TEXT,
        priority                 INTEGER NOT NULL DEFAULT 50
                                   CHECK(priority BETWEEN 0 AND 100),
        confidence               REAL NOT NULL
                                   CHECK(confidence BETWEEN 0.5 AND 0.7),
        source                   TEXT NOT NULL
                                   CHECK(source IN (
                                     'innate','configured','promoted-from-pattern'
                                   )),
        evidence_hash            TEXT,
        promoted_from_pattern_id TEXT,
        created_at               INTEGER NOT NULL,
        rationale                TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_commonsense_microtheory
        ON commonsense_rules(microtheory_lang, microtheory_domain, microtheory_action);
      CREATE INDEX IF NOT EXISTS idx_commonsense_priority
        ON commonsense_rules(priority DESC);
      CREATE INDEX IF NOT EXISTS idx_commonsense_source
        ON commonsense_rules(source);
    `);
  },
};
