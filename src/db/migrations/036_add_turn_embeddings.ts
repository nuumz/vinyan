/**
 * Migration 036 — Turn embeddings for semantic retrieval (plan commit E).
 *
 * Adds a `turn_embeddings` virtual table via sqlite-vec for cosine-similarity
 * search. Replaces the naive "last-N-turns" context window with hybrid
 * retrieval. The extension MUST be loaded before this migration runs
 * (see `src/memory/sqlite-vec-loader.ts`). Without it this migration is a
 * no-op — the retriever falls back to recency-only and logs a warning.
 */
import type { Database } from 'bun:sqlite';
import type { Migration } from './migration-runner.ts';

export const EMBEDDING_DIMENSION = 1024;

export const migration036: Migration = {
  version: 36,
  description: 'Add turn_embeddings (sqlite-vec) for semantic context retrieval',
  up(db: Database) {
    let vecAvailable = false;
    try {
      const row = db.query('SELECT vec_version() as version').get() as
        | { version: string }
        | undefined;
      vecAvailable = !!row?.version;
    } catch {
      vecAvailable = false;
    }

    if (!vecAvailable) {
      console.warn(
        '[vinyan] migration036: sqlite-vec extension not loaded — skipping turn_embeddings virtual table. Semantic retrieval will fall back to recency-only.',
      );
      return;
    }

    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS turn_embeddings USING vec0(
        turn_id TEXT PRIMARY KEY,
        embedding float[${EMBEDDING_DIMENSION}]
      );

      CREATE TABLE IF NOT EXISTS turn_embedding_meta (
        turn_id TEXT PRIMARY KEY REFERENCES session_turns(id) ON DELETE CASCADE,
        model_id TEXT NOT NULL,
        dimension INTEGER NOT NULL,
        indexed_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_turn_embedding_meta_model
        ON turn_embedding_meta(model_id);
    `);
  },
};
