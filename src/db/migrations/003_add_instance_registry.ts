/**
 * Migration 003 — Instance registry for Phase 5 multi-instance coordination.
 *
 * Source of truth: spec/tdd.md §23
 */
import type { Database } from "bun:sqlite";
import type { Migration } from "./migration-runner.ts";

export const migration003: Migration = {
  version: 3,
  description: "Add instance_registry for multi-instance coordination",
  up(db: Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS instance_registry (
        instance_id TEXT PRIMARY KEY,
        public_key  TEXT NOT NULL,
        endpoint    TEXT,
        trust_level TEXT NOT NULL DEFAULT 'untrusted'
                    CHECK(trust_level IN ('untrusted', 'semi-trusted', 'trusted')),
        capabilities_json TEXT,
        health_json TEXT,
        verdicts_requested INTEGER NOT NULL DEFAULT 0,
        verdicts_accurate  INTEGER NOT NULL DEFAULT 0,
        last_seen_at INTEGER,
        created_at   INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_ir_trust ON instance_registry(trust_level);
    `);
  },
};
