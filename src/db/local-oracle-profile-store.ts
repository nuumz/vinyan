/**
 * LocalOracleProfileStore — SQLite persistence for in-process oracle lifecycle.
 *
 * Mirrors the shape of WorkerStore/OracleProfileStore but for local oracles
 * (AST, Type, Dep, Test, Lint, etc.). Status evidence comes from
 * OracleAccuracyStore — this table only tracks FSM state.
 *
 * Implements ProfileStore<LocalOracleProfile> for the shared lifecycle.
 */

import type { Database } from 'bun:sqlite';
import type {
  AgentProfileStatus,
  ProfileStore,
} from '../orchestrator/profile/agent-profile.ts';
import type { LocalOracleProfile } from '../orchestrator/profile/local-oracle-gates.ts';

interface LocalOracleProfileRow {
  id: string;
  oracle_name: string;
  status: string;
  created_at: number;
  promoted_at: number | null;
  demoted_at: number | null;
  demotion_reason: string | null;
  demotion_count: number;
}

export class LocalOracleProfileStore implements ProfileStore<LocalOracleProfile> {
  /** In-memory guard so ensureProfile skips DB write after the first seen call per process. */
  private readonly seen = new Set<string>();

  constructor(private readonly db: Database) {}

  /**
   * Register an oracle for lifecycle tracking. No-op if it already exists.
   * Default status is `probation` so the oracle must earn `active`.
   * Hot-path safe — after first call per process the check is memory-only.
   */
  ensureProfile(oracleName: string, status: AgentProfileStatus = 'probation'): LocalOracleProfile {
    if (this.seen.has(oracleName)) {
      // Memory cache hit — still need to return the profile, so one cheap read.
      const hit = this.findByName(oracleName);
      if (hit) return hit;
    }
    const existing = this.findByName(oracleName);
    if (existing) {
      this.seen.add(oracleName);
      return existing;
    }

    const id = `local-oracle-${oracleName}`;
    const now = Date.now();
    this.db
      .prepare(
        `INSERT OR IGNORE INTO local_oracle_profiles
         (id, oracle_name, status, created_at, demotion_count)
         VALUES (?, ?, ?, ?, 0)`,
      )
      .run(id, oracleName, status, now);
    this.seen.add(oracleName);
    return this.findByName(oracleName)!;
  }

  findById(id: string): LocalOracleProfile | null {
    const row = this.db
      .prepare(`SELECT * FROM local_oracle_profiles WHERE id = ?`)
      .get(id) as LocalOracleProfileRow | null;
    return row ? rowToProfile(row) : null;
  }

  findByName(oracleName: string): LocalOracleProfile | null {
    const row = this.db
      .prepare(`SELECT * FROM local_oracle_profiles WHERE oracle_name = ?`)
      .get(oracleName) as LocalOracleProfileRow | null;
    return row ? rowToProfile(row) : null;
  }

  findByStatus(status: AgentProfileStatus): LocalOracleProfile[] {
    const rows = this.db
      .prepare(`SELECT * FROM local_oracle_profiles WHERE status = ? ORDER BY created_at ASC`)
      .all(status) as LocalOracleProfileRow[];
    return rows.map(rowToProfile);
  }

  findActive(): LocalOracleProfile[] {
    return this.findByStatus('active');
  }

  listAll(): LocalOracleProfile[] {
    const rows = this.db
      .prepare(`SELECT * FROM local_oracle_profiles ORDER BY oracle_name ASC`)
      .all() as LocalOracleProfileRow[];
    return rows.map(rowToProfile);
  }

  updateStatus(id: string, status: AgentProfileStatus, reason?: string): void {
    const now = Date.now();
    if (status === 'active') {
      this.db
        .prepare(
          `UPDATE local_oracle_profiles
           SET status = 'active', promoted_at = ?, demoted_at = NULL, demotion_reason = NULL
           WHERE id = ?`,
        )
        .run(now, id);
    } else if (status === 'demoted') {
      this.db
        .prepare(
          `UPDATE local_oracle_profiles
           SET status = 'demoted', demoted_at = ?, demotion_reason = ?, demotion_count = demotion_count + 1
           WHERE id = ?`,
        )
        .run(now, reason ?? null, id);
    } else if (status === 'retired') {
      this.db
        .prepare(
          `UPDATE local_oracle_profiles
           SET status = 'retired', demoted_at = COALESCE(demoted_at, ?), demotion_reason = COALESCE(demotion_reason, ?)
           WHERE id = ?`,
        )
        .run(now, reason ?? null, id);
    } else {
      // probation
      this.db
        .prepare(`UPDATE local_oracle_profiles SET status = 'probation' WHERE id = ?`)
        .run(id);
    }
  }

  reEnroll(id: string): void {
    this.db
      .prepare(
        `UPDATE local_oracle_profiles
         SET status = 'probation', demoted_at = NULL, demotion_reason = NULL
         WHERE id = ?`,
      )
      .run(id);
  }
}

function rowToProfile(row: LocalOracleProfileRow): LocalOracleProfile {
  return {
    id: row.id,
    oracleName: row.oracle_name,
    status: row.status as AgentProfileStatus,
    createdAt: row.created_at,
    promotedAt: row.promoted_at ?? undefined,
    demotedAt: row.demoted_at ?? undefined,
    demotionReason: row.demotion_reason ?? undefined,
    demotionCount: row.demotion_count,
  };
}
