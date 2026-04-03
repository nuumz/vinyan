/**
 * Migration 008 — RE-agnostic columns for worker_profiles.
 *
 * Adds three columns to worker_profiles to decouple the table from LLM-specific assumptions:
 *
 *   engine_type           TEXT  — 'llm' | 'symbolic' | 'oracle' | 'hybrid' | 'external'
 *   capabilities_declared TEXT  — JSON array (e.g. '["code-generation","reasoning","tool-use"]')
 *   engine_config         TEXT  — JSON object for RE-specific config; replaces scattered
 *                                 LLM-specific columns (temperature, system_prompt_tpl,
 *                                 max_context_tokens) as primary config store for new RE types.
 *
 * Legacy columns are kept intact for backward compatibility. Existing rows get engine_type='llm'
 * via the DEFAULT clause so the CapabilityModel can still type-discriminate by engine class.
 */
import type { Database } from 'bun:sqlite';
import type { Migration } from './migration-runner.ts';

export const migration008: Migration = {
  version: 8,
  description: 'Add RE-agnostic columns (engine_type, capabilities_declared, engine_config) to worker_profiles',
  up(db: Database): void {
    try {
      db.exec("ALTER TABLE worker_profiles ADD COLUMN engine_type TEXT DEFAULT 'llm'");
    } catch {
      /* column already exists */
    }
    try {
      db.exec('ALTER TABLE worker_profiles ADD COLUMN capabilities_declared TEXT');
    } catch {
      /* column already exists */
    }
    try {
      db.exec('ALTER TABLE worker_profiles ADD COLUMN engine_config TEXT');
    } catch {
      /* column already exists */
    }
  },
};
