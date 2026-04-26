/**
 * Migration 004 — SKILL.md artifact columns on `cached_skills`.
 *
 * Reserved slot per `docs/spec/w1-contracts.md` §2 for PR #3 (Skills SKILL.md).
 * Implements the storage shape required by Decision 20: each CachedSkill row
 * points at its on-disk SKILL.md artifact via `skill_md_path` and carries the
 * epistemic fields (`confidence_tier`, `content_hash`, `expected_error_reduction`,
 * `backtest_id`, `quarantined_at`) that the Oracle Gate + Critic promotion
 * pipeline reads and writes.
 *
 * Idempotency:
 *   - `PRAGMA table_info(cached_skills)` guards every `ADD COLUMN` so re-running
 *     the migration against an already-migrated DB is a no-op.
 *   - Indexes use `IF NOT EXISTS`.
 *
 * Compatibility:
 *   - Some libsqlite builds reject CHECK constraints inside `ALTER TABLE ADD
 *     COLUMN`. We attempt the CHECK form first and fall back to a plain ADD if
 *     the runtime disallows it. The Zod layer (`SkillMdFrontmatterSchema`) and
 *     the SkillStore enforce tier validity regardless.
 *
 * IMPORTANT: this file does NOT register itself into
 * `src/db/migrations/index.ts` — the coordinator wires it in a separate pass
 * to avoid merge races with parallel migrations (003 memory, 005 trajectory,
 * 007 plugin audit).
 */
import type { Database } from 'bun:sqlite';
import type { Migration } from './migration-runner.ts';

interface ColumnSpec {
  name: string;
  /** DDL fragment with CHECK clause (preferred). */
  ddlWithCheck: string;
  /** Fallback DDL with no CHECK — used if the runtime rejects the CHECK form. */
  ddlPlain: string;
}

const CONFIDENCE_TIER_CHECK = "CHECK(confidence_tier IN ('deterministic','heuristic','probabilistic','speculative'))";

const COLUMNS: ColumnSpec[] = [
  {
    name: 'confidence_tier',
    ddlWithCheck: `TEXT NOT NULL DEFAULT 'probabilistic' ${CONFIDENCE_TIER_CHECK}`,
    ddlPlain: "TEXT NOT NULL DEFAULT 'probabilistic'",
  },
  { name: 'skill_md_path', ddlWithCheck: 'TEXT', ddlPlain: 'TEXT' },
  { name: 'content_hash', ddlWithCheck: 'TEXT', ddlPlain: 'TEXT' },
  { name: 'expected_error_reduction', ddlWithCheck: 'REAL', ddlPlain: 'REAL' },
  { name: 'backtest_id', ddlWithCheck: 'TEXT', ddlPlain: 'TEXT' },
  { name: 'quarantined_at', ddlWithCheck: 'INTEGER', ddlPlain: 'INTEGER' },
];

/** Fetch existing column names from `cached_skills`. */
function existingColumnNames(db: Database): Set<string> {
  const rows = db.query('PRAGMA table_info(cached_skills)').all() as Array<{ name: string }>;
  return new Set(rows.map((r) => r.name));
}

/** Try DDL with CHECK; fall back to plain DDL if runtime rejects the CHECK. */
function addColumn(db: Database, column: ColumnSpec): void {
  try {
    db.exec(`ALTER TABLE cached_skills ADD COLUMN ${column.name} ${column.ddlWithCheck}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/check|constraint|syntax/i.test(msg) && column.ddlWithCheck !== column.ddlPlain) {
      // Older SQLite builds disallow CHECK in ALTER TABLE ADD COLUMN.
      // The application layer (Zod + SkillStore) enforces the invariant.
      db.exec(`ALTER TABLE cached_skills ADD COLUMN ${column.name} ${column.ddlPlain}`);
      return;
    }
    throw err;
  }
}

export const migration004: Migration = {
  version: 4,
  description: 'SKILL.md artifact columns on cached_skills (D20)',
  up(db: Database) {
    const existing = existingColumnNames(db);
    for (const column of COLUMNS) {
      if (!existing.has(column.name)) {
        addColumn(db, column);
      }
    }
    db.exec(
      'CREATE INDEX IF NOT EXISTS idx_cached_skills_content_hash ON cached_skills(content_hash) WHERE content_hash IS NOT NULL',
    );
    db.exec('CREATE INDEX IF NOT EXISTS idx_cached_skills_tier ON cached_skills(confidence_tier)');
  },
};
