/**
 * Migration 030 — Adaptive Parameter Ledger.
 *
 * DB-backed history of every adaptive-parameter mutation. Used by
 * `src/orchestrator/adaptive-params/parameter-ledger.ts` to record and
 * replay tuning decisions made by sleep-cycle adapters or operator
 * config changes.
 *
 * Design anchor: Phase 1 of the AGI-path-unblocking plan
 * (`/Users/phumin.k/.claude/plans/implement-3-cozy-acorn.md`).
 */
import type { Database } from 'bun:sqlite';
import type { Migration } from './migration-runner.ts';

export const migration030: Migration = {
  version: 30,
  description: 'Adaptive parameter ledger — tuning history for ceiling parameters',
  up(db: Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS parameter_adaptations (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        ts              INTEGER NOT NULL,
        param_name      TEXT    NOT NULL,
        old_value       TEXT    NOT NULL,
        new_value       TEXT    NOT NULL,
        reason          TEXT    NOT NULL,
        owner_module    TEXT    NOT NULL,
        ledger_version  INTEGER NOT NULL DEFAULT 1
      );
      CREATE INDEX IF NOT EXISTS idx_param_ledger_name_ts
        ON parameter_adaptations(param_name, ts DESC);
      CREATE INDEX IF NOT EXISTS idx_param_ledger_owner
        ON parameter_adaptations(owner_module);
    `);
  },
};
