/**
 * Migration 005 — Add `oracle_profiles` table.
 *
 * Tracks remote oracle accuracy for Phase 5 multi-instance coordination.
 * State machine: probation → active → demoted → retired.
 * Mirrors WorkerProfile lifecycle pattern (Phase 4).
 */
import type { Database } from 'bun:sqlite';
import type { Migration } from './migration-runner.ts';

export const migration005: Migration = {
  version: 5,
  description: 'Add oracle_profiles table for remote oracle lifecycle tracking',
  up(db: Database): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS oracle_profiles (
        id TEXT PRIMARY KEY,
        instance_id TEXT NOT NULL,
        oracle_name TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('probation', 'active', 'demoted', 'retired')) DEFAULT 'probation',
        verdicts_requested INTEGER NOT NULL DEFAULT 0,
        verdicts_accurate INTEGER NOT NULL DEFAULT 0,
        false_positive_count INTEGER NOT NULL DEFAULT 0,
        timeout_count INTEGER NOT NULL DEFAULT 0,
        contradiction_count INTEGER NOT NULL DEFAULT 0,
        last_used_at INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        demoted_at INTEGER,
        demotion_reason TEXT,
        UNIQUE(instance_id, oracle_name)
      );
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_oracle_profiles_instance ON oracle_profiles(instance_id);
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_oracle_profiles_status ON oracle_profiles(status);
    `);
  },
};
