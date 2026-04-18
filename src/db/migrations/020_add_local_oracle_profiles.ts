/**
 * Migration 020 — local_oracle_profiles table.
 *
 * Gives in-process oracles (AST, Type, Dep, Test, Lint, Go, Python, Rust,
 * Goal-Alignment) the same promotion/demotion FSM as Worker and OraclePeer
 * profiles. Part of the unified AgentProfile abstraction.
 *
 * Columns mirror EngineProfile's lifecycle fields — accuracy evidence itself
 * lives in oracle_accuracy (unchanged); this table only tracks status.
 */

import type { Database } from 'bun:sqlite';
import type { Migration } from './migration-runner.ts';

export const migration020: Migration = {
  version: 20,
  description: 'Add local_oracle_profiles table (profile FSM for in-process oracles)',
  up(db: Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS local_oracle_profiles (
        id TEXT PRIMARY KEY,
        oracle_name TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL DEFAULT 'probation',
        created_at INTEGER NOT NULL,
        promoted_at INTEGER,
        demoted_at INTEGER,
        demotion_reason TEXT,
        demotion_count INTEGER NOT NULL DEFAULT 0
      )
    `);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_local_oracle_profiles_status ON local_oracle_profiles(status)`);
  },
};
