/**
 * Migration 003 — Memory provider unified records + FTS5 index.
 *
 * Backing store for `MemoryProvider` (`src/memory/provider/types.ts`).
 * Reserved version per `docs/spec/w1-contracts.md` §2. Version 002 is
 * reserved for the Profile Resolver track (PR #1) and version 004/005
 * are reserved for Skills / Trajectory export — this file MUST NOT
 * touch those.
 *
 * Profile column: required per w1-contracts §3. All reads at the store
 * layer must filter on `profile`.
 *
 * FTS5: default BM25 retrieval. `porter` stem + `unicode61` tokenize
 * matches existing conventions elsewhere in the codebase. Triggers
 * keep the virtual table in sync on insert/update/delete.
 *
 * IMPORTANT: this file does NOT register itself into
 * `src/db/migrations/index.ts` — the coordinator wires it in a separate
 * pass to avoid merge races with the parallel trajectory migration (005).
 */
import type { Database } from 'bun:sqlite';
import type { Migration } from './migration-runner.ts';

export const migration003: Migration = {
  version: 3,
  description: 'Memory provider unified records + FTS5 index',
  up(db: Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS memory_records (
        id              TEXT PRIMARY KEY,
        profile         TEXT NOT NULL DEFAULT 'default',
        kind            TEXT NOT NULL
                          CHECK(kind IN ('fact','preference','user-section','episodic')),
        content         TEXT NOT NULL,
        confidence      REAL NOT NULL,
        evidence_tier   TEXT NOT NULL
                          CHECK(evidence_tier IN ('deterministic','heuristic','probabilistic','speculative')),
        evidence_chain  TEXT NOT NULL,     -- JSON array of EvidenceRef
        content_hash    TEXT,
        created_at      INTEGER NOT NULL,
        valid_from      INTEGER,
        valid_until     INTEGER,
        session_id      TEXT,
        metadata_json   TEXT,
        embedding       BLOB               -- optional; provider-specific
      );
      CREATE INDEX IF NOT EXISTS idx_memrec_profile_kind
        ON memory_records(profile, kind);
      CREATE INDEX IF NOT EXISTS idx_memrec_profile_tier
        ON memory_records(profile, evidence_tier);
      CREATE INDEX IF NOT EXISTS idx_memrec_content_hash
        ON memory_records(content_hash)
        WHERE content_hash IS NOT NULL;

      CREATE VIRTUAL TABLE IF NOT EXISTS memory_records_fts USING fts5(
        id UNINDEXED,
        profile UNINDEXED,
        kind UNINDEXED,
        content,
        tokenize = 'porter unicode61'
      );

      -- Triggers keep the FTS5 virtual table in lockstep with the base table.
      CREATE TRIGGER IF NOT EXISTS memrec_ai AFTER INSERT ON memory_records BEGIN
        INSERT INTO memory_records_fts (id, profile, kind, content)
        VALUES (new.id, new.profile, new.kind, new.content);
      END;

      CREATE TRIGGER IF NOT EXISTS memrec_ad AFTER DELETE ON memory_records BEGIN
        DELETE FROM memory_records_fts WHERE id = old.id;
      END;

      CREATE TRIGGER IF NOT EXISTS memrec_au AFTER UPDATE ON memory_records BEGIN
        UPDATE memory_records_fts
           SET profile = new.profile,
               kind    = new.kind,
               content = new.content
         WHERE id = old.id;
      END;
    `);
  },
};
