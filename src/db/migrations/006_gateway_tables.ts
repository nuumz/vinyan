/**
 * Migration 006 — Gateway tables.
 *
 * Reserved slot per `docs/spec/w1-contracts.md` §2 for the W2 messaging
 * Gateway track. Creates three tables:
 *
 *   - `gateway_identity`          — paired-user directory.
 *   - `gateway_pairing_tokens`    — short-lived tokens consumed by `/pair`.
 *   - `gateway_schedules`         — schema-only scaffolding for W3's NL cron;
 *                                   no reader/writer ships in this PR.
 *
 * Profile column (w1-contracts §3) lives on every table. Cross-profile
 * reads must be explicit at the store layer.
 *
 * IMPORTANT: this file does NOT register itself into
 * `src/db/migrations/index.ts` — the coordinator wires it in a separate
 * pass to avoid merge races with parallel W1 migrations.
 */
import type { Database } from 'bun:sqlite';
import type { Migration } from './migration-runner.ts';

export const migration006: Migration = {
  version: 6,
  description: 'Gateway tables (identity + pairing tokens + schedules scaffold)',
  up(db: Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS gateway_identity (
        gateway_user_id    TEXT PRIMARY KEY,
        profile            TEXT NOT NULL DEFAULT 'default',
        platform           TEXT NOT NULL,
        platform_user_id   TEXT NOT NULL,
        display_name       TEXT,
        trust_tier         TEXT NOT NULL
                             CHECK(trust_tier IN ('unknown','pairing','paired','admin')),
        paired_at          INTEGER,
        last_seen_at       INTEGER,
        UNIQUE(platform, platform_user_id)
      );
      CREATE INDEX IF NOT EXISTS idx_gateway_identity_profile_platform
        ON gateway_identity(profile, platform);

      CREATE TABLE IF NOT EXISTS gateway_pairing_tokens (
        token              TEXT PRIMARY KEY,
        profile            TEXT NOT NULL DEFAULT 'default',
        platform           TEXT NOT NULL,
        issued_at          INTEGER NOT NULL,
        expires_at         INTEGER NOT NULL,
        consumed_at        INTEGER,
        consumed_by        TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_gateway_pairing_expires
        ON gateway_pairing_tokens(expires_at);

      CREATE TABLE IF NOT EXISTS gateway_schedules (
        id                 TEXT PRIMARY KEY,
        profile            TEXT NOT NULL DEFAULT 'default',
        created_at         INTEGER NOT NULL,
        cron               TEXT NOT NULL,
        timezone           TEXT NOT NULL,
        goal               TEXT NOT NULL,
        origin_json        TEXT NOT NULL,
        status             TEXT NOT NULL DEFAULT 'active',
        next_fire_at       INTEGER,
        run_history_json   TEXT DEFAULT '[]'
      );
      CREATE INDEX IF NOT EXISTS idx_gateway_schedules_profile_next
        ON gateway_schedules(profile, next_fire_at);
    `);
  },
};
