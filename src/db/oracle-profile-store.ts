/**
 * OracleProfileStore — SQLite persistence for remote oracle profiles.
 *
 * Tracks accuracy and lifecycle of remote oracle instances.
 * State machine: probation → active → demoted → retired.
 *
 * Source of truth: design/implementation-plan.md §PH5.8
 */
import type { Database } from 'bun:sqlite';
import type { OracleProfile } from '../orchestrator/instance-coordinator.ts';

export class OracleProfileStore {
  private db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  createProfile(partial: { instanceId: string; oracleName: string; status?: OracleProfile['status'] }): OracleProfile {
    const id = `oracle-${partial.instanceId}-${partial.oracleName}-${Date.now().toString(36)}`;
    const now = Date.now();
    const status = partial.status ?? 'probation';

    this.db
      .prepare(
        `INSERT OR IGNORE INTO oracle_profiles (id, instance_id, oracle_name, status, created_at, last_used_at)
         VALUES ($id, $instance_id, $oracle_name, $status, $created_at, $last_used_at)`,
      )
      .run({
        $id: id,
        $instance_id: partial.instanceId,
        $oracle_name: partial.oracleName,
        $status: status,
        $created_at: now,
        $last_used_at: now,
      });

    return {
      id,
      instanceId: partial.instanceId,
      oracleName: partial.oracleName,
      status,
      verdictsRequested: 0,
      verdictsAccurate: 0,
      falsePositiveCount: 0,
      timeoutCount: 0,
      contradictionCount: 0,
      lastUsedAt: now,
      createdAt: now,
    };
  }

  getProfile(instanceId: string, oracleName: string): OracleProfile | null {
    const row = this.db
      .prepare(`SELECT * FROM oracle_profiles WHERE instance_id = ? AND oracle_name = ?`)
      .get(instanceId, oracleName) as OracleProfileRow | null;
    return row ? rowToProfile(row) : null;
  }

  getProfileById(id: string): OracleProfile | null {
    const row = this.db.prepare(`SELECT * FROM oracle_profiles WHERE id = ?`).get(id) as OracleProfileRow | null;
    return row ? rowToProfile(row) : null;
  }

  getProfilesByInstance(instanceId: string): OracleProfile[] {
    const rows = this.db
      .prepare(`SELECT * FROM oracle_profiles WHERE instance_id = ? ORDER BY last_used_at DESC`)
      .all(instanceId) as OracleProfileRow[];
    return rows.map(rowToProfile);
  }

  findByStatus(status: OracleProfile['status']): OracleProfile[] {
    const rows = this.db
      .prepare(`SELECT * FROM oracle_profiles WHERE status = ? ORDER BY created_at ASC`)
      .all(status) as OracleProfileRow[];
    return rows.map(rowToProfile);
  }

  recordResult(id: string, success: boolean): void {
    const column = success ? 'verdicts_accurate' : 'false_positive_count';
    this.db
      .prepare(
        `UPDATE oracle_profiles
         SET verdicts_requested = verdicts_requested + 1,
             ${column} = ${column} + 1,
             last_used_at = $now
         WHERE id = $id`,
      )
      .run({ $id: id, $now: Date.now() });
  }

  recordTimeout(id: string): void {
    this.db
      .prepare(
        `UPDATE oracle_profiles
         SET timeout_count = timeout_count + 1,
             verdicts_requested = verdicts_requested + 1,
             last_used_at = $now
         WHERE id = $id`,
      )
      .run({ $id: id, $now: Date.now() });
  }

  demote(id: string, reason: string): void {
    this.db
      .prepare(
        `UPDATE oracle_profiles SET status = 'demoted', demoted_at = $now, demotion_reason = $reason WHERE id = $id`,
      )
      .run({ $id: id, $now: Date.now(), $reason: reason });
  }

  promote(id: string): void {
    this.db.prepare(`UPDATE oracle_profiles SET status = 'active' WHERE id = $id`).run({ $id: id });
  }

  retire(id: string): void {
    this.db.prepare(`UPDATE oracle_profiles SET status = 'retired' WHERE id = $id`).run({ $id: id });
  }
}

// ── Internal ──────────────────────────────────────────────────

interface OracleProfileRow {
  id: string;
  instance_id: string;
  oracle_name: string;
  status: string;
  verdicts_requested: number;
  verdicts_accurate: number;
  false_positive_count: number;
  timeout_count: number;
  contradiction_count: number;
  last_used_at: number;
  created_at: number;
  demoted_at: number | null;
  demotion_reason: string | null;
}

function rowToProfile(row: OracleProfileRow): OracleProfile {
  return {
    id: row.id,
    instanceId: row.instance_id,
    oracleName: row.oracle_name,
    status: row.status as OracleProfile['status'],
    verdictsRequested: row.verdicts_requested,
    verdictsAccurate: row.verdicts_accurate,
    falsePositiveCount: row.false_positive_count,
    timeoutCount: row.timeout_count,
    contradictionCount: row.contradiction_count,
    lastUsedAt: row.last_used_at,
    createdAt: row.created_at,
    demotedAt: row.demoted_at ?? undefined,
    demotionReason: row.demotion_reason ?? undefined,
  };
}
