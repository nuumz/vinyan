/**
 * Migration 002 — Session tables for Phase 5 API Server.
 *
 * Source of truth: spec/tdd.md §22.5
 */
import type { Database } from "bun:sqlite";
import type { Migration } from "./migration-runner.ts";

export const migration002: Migration = {
  version: 2,
  description: "Add session_store and session_tasks for API server",
  up(db: Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS session_store (
        id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'active'
               CHECK(status IN ('active', 'suspended', 'compacted', 'closed')),
        working_memory_json TEXT,
        compaction_json TEXT,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS session_tasks (
        session_id TEXT NOT NULL REFERENCES session_store(id),
        task_id TEXT NOT NULL,
        task_input_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending'
               CHECK(status IN ('pending', 'running', 'completed', 'failed', 'cancelled')),
        result_json TEXT,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (session_id, task_id)
      );

      CREATE INDEX IF NOT EXISTS idx_st_session ON session_tasks(session_id);
      CREATE INDEX IF NOT EXISTS idx_st_status ON session_tasks(status);
      CREATE INDEX IF NOT EXISTS idx_ss_status ON session_store(status);
    `);
  },
};
