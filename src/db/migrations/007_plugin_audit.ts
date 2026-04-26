/**
 * Migration 007 — Plugin Registry audit log.
 *
 * Reserved slot per `docs/spec/w1-contracts.md` §2 for the W2 Plugin
 * Registry track. Every state transition of a plugin (discovery → verifying
 * → loaded → active → deactivated → rejected → unloaded) writes one row
 * here. The registry's governance decisions are rule-based (A3); this table
 * is the replay log that proves it.
 *
 * Profile column: required per w1-contracts §3. All reads at the store
 * layer must filter on `profile`.
 *
 * IMPORTANT: this file does NOT register itself into
 * `src/db/migrations/index.ts` — the coordinator wires it in a separate
 * pass to avoid merge races with parallel W1 migrations.
 */
import type { Database } from 'bun:sqlite';
import type { Migration } from './migration-runner.ts';

export const migration007: Migration = {
  version: 7,
  description: 'Plugin Registry audit log',
  up(db: Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS plugin_audit (
        audit_id       INTEGER PRIMARY KEY AUTOINCREMENT,
        profile        TEXT NOT NULL DEFAULT 'default',
        plugin_id      TEXT NOT NULL,
        plugin_version TEXT NOT NULL,
        category       TEXT NOT NULL,
        event          TEXT NOT NULL
                         CHECK(event IN (
                           'discovered','integrity_ok','integrity_fail',
                           'signature_ok','signature_fail',
                           'loaded','activated','deactivated','rejected','unloaded'
                         )),
        tier           TEXT,
        from_state     TEXT,
        to_state       TEXT,
        detail_json    TEXT,
        created_at     INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_plugin_audit_profile_plugin
        ON plugin_audit(profile, plugin_id);
      CREATE INDEX IF NOT EXISTS idx_plugin_audit_created
        ON plugin_audit(created_at);
    `);
  },
};
