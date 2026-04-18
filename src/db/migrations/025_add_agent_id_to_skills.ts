/**
 * Migration 025 — Add `agent_id` column to `cached_skills`.
 *
 * Multi-agent scoping: each skill is now owned by a specialist agent
 * (e.g., 'ts-coder', 'writer'). Existing rows get `agent_id = NULL`
 * (legacy shared skills, readable by any agent until re-keyed by
 * the next sleep cycle).
 *
 * Index: `idx_skills_agent_sig ON cached_skills(agent_id, task_signature)` —
 * agent-scoped skill lookup is the hot path during SkillManager.findMatch().
 */
import type { Database } from 'bun:sqlite';
import type { Migration } from './migration-runner.ts';

export const migration025: Migration = {
  version: 25,
  description: 'Add agent_id to cached_skills for multi-agent skill partitioning',
  up(db: Database): void {
    const cols = db.prepare("PRAGMA table_info('cached_skills')").all() as Array<{ name: string }>;
    const hasAgentId = cols.some((c) => c.name === 'agent_id');
    if (!hasAgentId) {
      db.exec(`ALTER TABLE cached_skills ADD COLUMN agent_id TEXT`);
    }

    db.exec(`CREATE INDEX IF NOT EXISTS idx_skills_agent_sig ON cached_skills(agent_id, task_signature)`);
  },
};
