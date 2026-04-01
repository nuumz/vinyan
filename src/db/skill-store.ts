/**
 * SkillStore — SQLite persistence for cached skill patterns.
 *
 * CRUD for CachedSkill lifecycle: probation → active → demoted.
 * Skills are L0 reflex shortcuts — proven approaches cached for reuse.
 *
 * Source of truth: spec/tdd.md §12B (Skill Formation)
 */
import type { Database } from "bun:sqlite";
import type { CachedSkill } from "../orchestrator/types.ts";

export class SkillStore {
  private db: Database;
  private insertStmt;

  constructor(db: Database) {
    this.db = db;
    this.insertStmt = db.prepare(`
      INSERT OR REPLACE INTO cached_skills (
        task_signature, approach, success_rate, status,
        probation_remaining, usage_count, risk_at_creation,
        dep_cone_hashes, last_verified_at, verification_profile
      ) VALUES (
        $task_signature, $approach, $success_rate, $status,
        $probation_remaining, $usage_count, $risk_at_creation,
        $dep_cone_hashes, $last_verified_at, $verification_profile
      )
    `);
  }

  insert(skill: CachedSkill): void {
    this.insertStmt.run({
      $task_signature: skill.taskSignature,
      $approach: skill.approach,
      $success_rate: skill.successRate,
      $status: skill.status,
      $probation_remaining: skill.probationRemaining,
      $usage_count: skill.usageCount,
      $risk_at_creation: skill.riskAtCreation,
      $dep_cone_hashes: JSON.stringify(skill.depConeHashes),
      $last_verified_at: skill.lastVerifiedAt,
      $verification_profile: skill.verificationProfile,
    });
  }

  findBySignature(taskSignature: string): CachedSkill | null {
    const row = this.db.prepare(
      `SELECT * FROM cached_skills WHERE task_signature = ?`,
    ).get(taskSignature);
    return row ? rowToSkill(row) : null;
  }

  findActive(): CachedSkill[] {
    const rows = this.db.prepare(
      `SELECT * FROM cached_skills WHERE status = 'active' ORDER BY success_rate DESC`,
    ).all();
    return rows.map(rowToSkill);
  }

  findByStatus(status: CachedSkill["status"]): CachedSkill[] {
    const rows = this.db.prepare(
      `SELECT * FROM cached_skills WHERE status = ? ORDER BY success_rate DESC`,
    ).all(status);
    return rows.map(rowToSkill);
  }

  updateStatus(
    taskSignature: string,
    status: CachedSkill["status"],
    probationRemaining?: number,
  ): void {
    if (probationRemaining !== undefined) {
      this.db.prepare(
        `UPDATE cached_skills SET status = ?, probation_remaining = ? WHERE task_signature = ?`,
      ).run(status, probationRemaining, taskSignature);
    } else {
      this.db.prepare(
        `UPDATE cached_skills SET status = ? WHERE task_signature = ?`,
      ).run(status, taskSignature);
    }
  }

  incrementUsage(taskSignature: string): void {
    this.db.prepare(
      `UPDATE cached_skills SET usage_count = usage_count + 1 WHERE task_signature = ?`,
    ).run(taskSignature);
  }

  updateDepConeHashes(taskSignature: string, hashes: Record<string, string>): void {
    this.db.prepare(
      `UPDATE cached_skills SET dep_cone_hashes = ?, last_verified_at = ? WHERE task_signature = ?`,
    ).run(JSON.stringify(hashes), Date.now(), taskSignature);
  }

  /**
   * Bulk demote skills not verified within maxAge_ms.
   * Returns number of demoted skills.
   */
  demoteStale(maxAge_ms: number): number {
    const cutoff = Date.now() - maxAge_ms;
    const result = this.db.prepare(
      `UPDATE cached_skills SET status = 'demoted' WHERE status IN ('probation', 'active') AND last_verified_at < ?`,
    ).run(cutoff);
    return result.changes;
  }

  countActive(): number {
    const row = this.db.prepare(
      `SELECT COUNT(*) as cnt FROM cached_skills WHERE status = 'active'`,
    ).get() as { cnt: number };
    return row.cnt;
  }

  count(): number {
    const row = this.db.prepare(
      `SELECT COUNT(*) as cnt FROM cached_skills`,
    ).get() as { cnt: number };
    return row.cnt;
  }
}

// ── Row deserialization ───────────────────────────────────────────────────

function rowToSkill(row: any): CachedSkill {
  return {
    taskSignature: row.task_signature,
    approach: row.approach,
    successRate: row.success_rate,
    status: row.status,
    probationRemaining: row.probation_remaining,
    usageCount: row.usage_count,
    riskAtCreation: row.risk_at_creation,
    depConeHashes: JSON.parse(row.dep_cone_hashes),
    lastVerifiedAt: row.last_verified_at,
    verificationProfile: row.verification_profile,
  };
}
