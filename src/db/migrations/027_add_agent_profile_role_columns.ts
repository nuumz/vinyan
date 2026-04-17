/**
 * Migration 027 — Role / specialization / persona columns on `agent_profile`.
 *
 * Phase 2: specialist agents (ts-coder, writer, etc.) need their own profile
 * rows alongside the workspace host. These columns capture the light-weight
 * metadata that doesn't belong in soul.md (full persona lives on filesystem).
 *
 * Back-fill: the pre-existing `'local'` row becomes `role = 'host'` so the
 * distinction between host and specialist is queryable immediately.
 *
 * Columns:
 *   - role: free-form tag ('host' | 'specialist' | 'custom'). Default NULL for
 *           new rows; consumers default to 'specialist' when NULL.
 *   - specialization: comma-separated tags mirroring AgentSpec.routingHints
 *                     for fast filter queries. Optional.
 *   - persona: short one-line persona summary (full persona is soul.md).
 *              Distinct from `description` which is A2A-facing.
 *
 * All nullable / additive — idempotent via `PRAGMA table_info` check.
 */
import type { Database } from 'bun:sqlite';
import type { Migration } from './migration-runner.ts';

export const migration027: Migration = {
  version: 27,
  description: 'Add role, specialization, persona columns to agent_profile',
  up(db: Database): void {
    const cols = db.prepare("PRAGMA table_info('agent_profile')").all() as Array<{ name: string }>;
    const names = new Set(cols.map((c) => c.name));

    if (!names.has('role')) {
      db.exec(`ALTER TABLE agent_profile ADD COLUMN role TEXT DEFAULT NULL`);
      // Back-fill the workspace host row
      db.prepare(`UPDATE agent_profile SET role = 'host' WHERE id = 'local' AND role IS NULL`).run();
    }
    if (!names.has('specialization')) {
      db.exec(`ALTER TABLE agent_profile ADD COLUMN specialization TEXT DEFAULT NULL`);
    }
    if (!names.has('persona')) {
      db.exec(`ALTER TABLE agent_profile ADD COLUMN persona TEXT DEFAULT NULL`);
    }
  },
};
