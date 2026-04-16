/**
 * Migration 016 — Agent Conversation Room tables.
 *
 * Tables created in R0 but left UNUSED until R2 (persistence hardening).
 * R1 runs rooms entirely in-memory; this migration makes the schema ready
 * for R2's dual-write (commit-then-emit) crash-safety invariant.
 *
 * Schema:
 *   - room_sessions     — one row per room lifecycle
 *   - room_participants — role slots filled from the local worker fleet
 *   - room_ledger       — append-only hash-chained message log
 *   - room_blackboard   — versioned scoped KV cells
 *
 * Forward-only, additive, idempotent (CREATE TABLE IF NOT EXISTS).
 */
import type { Database } from 'bun:sqlite';
import type { Migration } from './migration-runner.ts';

export const migration016: Migration = {
  version: 16,
  description: 'Add Agent Conversation Room tables (rooms/participants/ledger/blackboard)',
  up(db: Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS room_sessions (
        id                TEXT PRIMARY KEY,
        parent_task_id    TEXT NOT NULL,
        contract_json     TEXT NOT NULL,
        status            TEXT NOT NULL
                           CHECK(status IN ('opening','active','converging','converged','partial','failed','awaiting-user')),
        rounds_used       INTEGER NOT NULL DEFAULT 0,
        tokens_consumed   INTEGER NOT NULL DEFAULT 0,
        created_at        INTEGER NOT NULL,
        closed_at         INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_room_sessions_parent ON room_sessions(parent_task_id);
      CREATE INDEX IF NOT EXISTS idx_room_sessions_status ON room_sessions(status);

      CREATE TABLE IF NOT EXISTS room_participants (
        id                TEXT PRIMARY KEY,
        room_id           TEXT NOT NULL REFERENCES room_sessions(id),
        role_name         TEXT NOT NULL,
        worker_id         TEXT NOT NULL,
        worker_model_id   TEXT NOT NULL,
        turns_used        INTEGER NOT NULL DEFAULT 0,
        tokens_used       INTEGER NOT NULL DEFAULT 0,
        status            TEXT NOT NULL
                           CHECK(status IN ('admitted','active','yielded','failed')),
        admitted_at       INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_room_participants_room ON room_participants(room_id);

      CREATE TABLE IF NOT EXISTS room_ledger (
        room_id                 TEXT NOT NULL REFERENCES room_sessions(id),
        seq                     INTEGER NOT NULL,
        timestamp               INTEGER NOT NULL,
        author_participant_id   TEXT NOT NULL,
        author_role             TEXT NOT NULL,
        entry_type              TEXT NOT NULL
                                 CHECK(entry_type IN ('propose','affirm','reject','claim','query','answer','uncertain-turn','violation','converge-vote')),
        content_hash            TEXT NOT NULL,
        prev_hash               TEXT NOT NULL,
        payload_json            TEXT NOT NULL,
        PRIMARY KEY (room_id, seq)
      );
      CREATE INDEX IF NOT EXISTS idx_room_ledger_author ON room_ledger(author_participant_id);

      CREATE TABLE IF NOT EXISTS room_blackboard (
        room_id                 TEXT NOT NULL REFERENCES room_sessions(id),
        key                     TEXT NOT NULL,
        version                 INTEGER NOT NULL,
        value_json              TEXT NOT NULL,
        author_role             TEXT NOT NULL,
        updated_at              INTEGER NOT NULL,
        PRIMARY KEY (room_id, key, version)
      );
      CREATE INDEX IF NOT EXISTS idx_room_blackboard_room_key ON room_blackboard(room_id, key);
    `);
  },
};
