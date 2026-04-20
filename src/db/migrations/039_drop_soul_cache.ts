/**
 * Migration 039 — Drop the `soul_md` and `soul_version` columns from
 * `agent_contexts`.
 *
 * These columns were a write-only cache of the content at
 * `.vinyan/souls/{agentId}.soul.md`. Nothing in the codebase ever read
 * them — `SoulStore` (filesystem) is the only reader, and that's the
 * source of truth. The cache was pure write-amplification and a drift
 * hazard.
 *
 * Companion to the Phase 1 code change in:
 *   - src/db/agent-context-store.ts (removed updateSoulMd method)
 *   - src/orchestrator/agent-context/soul-reflector.ts (removed 2 call sites)
 *
 * `pending_insights` column (also added by migration 019) is kept —
 * it holds genuine pre-reflection state, not a filesystem cache.
 *
 * Source: docs/plans/sqlite-joyful-lynx.md §Phase 1.
 */
import type { Database } from 'bun:sqlite';
import type { Migration } from './migration-runner.ts';

export const migration039: Migration = {
  version: 39,
  description: 'Drop soul_md + soul_version columns from agent_contexts (filesystem is source of truth)',
  up(db: Database) {
    // Idempotent: only drop columns that exist. SQLite >= 3.35 supports
    // ALTER TABLE ... DROP COLUMN (bun:sqlite ships a modern SQLite).
    const cols = db.prepare("PRAGMA table_info('agent_contexts')").all() as Array<{ name: string }>;
    const colNames = new Set(cols.map((c) => c.name));

    if (colNames.has('soul_md')) {
      db.exec(`ALTER TABLE agent_contexts DROP COLUMN soul_md`);
    }
    if (colNames.has('soul_version')) {
      db.exec(`ALTER TABLE agent_contexts DROP COLUMN soul_version`);
    }
  },
};
