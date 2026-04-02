/**
 * SkillStore — SQLite persistence for cached skill patterns.
 *
 * CRUD for CachedSkill lifecycle: probation → active → demoted.
 * Skills are L0 reflex shortcuts — proven approaches cached for reuse.
 *
 * Source of truth: spec/tdd.md §12B (Skill Formation)
 */
import type { Database } from 'bun:sqlite';
import type { CachedSkill } from '../orchestrator/types.ts';

export class SkillStore {
  private db: Database;
  private insertStmt;

  constructor(db: Database) {
    this.db = db;
    this.insertStmt = db.prepare(`
      INSERT OR REPLACE INTO cached_skills (
        task_signature, approach, success_rate, status,
        probation_remaining, usage_count, risk_at_creation,
        dep_cone_hashes, last_verified_at, verification_profile, origin, composed_of
      ) VALUES (
        $task_signature, $approach, $success_rate, $status,
        $probation_remaining, $usage_count, $risk_at_creation,
        $dep_cone_hashes, $last_verified_at, $verification_profile, $origin, $composed_of
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
      $origin: skill.origin ?? 'local',
      $composed_of: skill.composedOf ? JSON.stringify(skill.composedOf) : null,
    });
  }

  findBySignature(taskSignature: string): CachedSkill | null {
    const row = this.db.prepare(`SELECT * FROM cached_skills WHERE task_signature = ?`).get(taskSignature);
    return row ? rowToSkill(row) : null;
  }

  findActive(): CachedSkill[] {
    const rows = this.db
      .prepare(`SELECT * FROM cached_skills WHERE status = 'active' ORDER BY success_rate DESC`)
      .all();
    return rows.map(rowToSkill);
  }

  findByStatus(status: CachedSkill['status']): CachedSkill[] {
    const rows = this.db.prepare(`SELECT * FROM cached_skills WHERE status = ? ORDER BY success_rate DESC`).all(status);
    return rows.map(rowToSkill);
  }

  updateStatus(taskSignature: string, status: CachedSkill['status'], probationRemaining?: number): void {
    if (probationRemaining !== undefined) {
      this.db
        .prepare(`UPDATE cached_skills SET status = ?, probation_remaining = ? WHERE task_signature = ?`)
        .run(status, probationRemaining, taskSignature);
    } else {
      this.db.prepare(`UPDATE cached_skills SET status = ? WHERE task_signature = ?`).run(status, taskSignature);
    }
  }

  incrementUsage(taskSignature: string): void {
    this.db
      .prepare(`UPDATE cached_skills SET usage_count = usage_count + 1 WHERE task_signature = ?`)
      .run(taskSignature);
  }

  updateDepConeHashes(taskSignature: string, hashes: Record<string, string>): void {
    this.db
      .prepare(`UPDATE cached_skills SET dep_cone_hashes = ?, last_verified_at = ? WHERE task_signature = ?`)
      .run(JSON.stringify(hashes), Date.now(), taskSignature);
  }

  /**
   * Bulk demote skills not verified within maxAge_ms.
   * Returns number of demoted skills.
   */
  demoteStale(maxAgeMs: number): number {
    const cutoff = Date.now() - maxAgeMs;
    const result = this.db
      .prepare(
        `UPDATE cached_skills SET status = 'demoted' WHERE status IN ('probation', 'active') AND last_verified_at < ?`,
      )
      .run(cutoff);
    return result.changes;
  }

  countActive(): number {
    const row = this.db.prepare(`SELECT COUNT(*) as cnt FROM cached_skills WHERE status = 'active'`).get() as {
      cnt: number;
    };
    return row.cnt;
  }

  count(): number {
    const row = this.db.prepare(`SELECT COUNT(*) as cnt FROM cached_skills`).get() as { cnt: number };
    return row.cnt;
  }

  // ── Skill Composition (Phase 5 — Stream D2) ─────────────────────────

  /** Find a composed skill matching a task fingerprint (exact match on task_signature). */
  findComposedSkill(fingerprint: string): CachedSkill | null {
    const row = this.db
      .prepare(`SELECT * FROM cached_skills WHERE task_signature = ? AND composed_of IS NOT NULL AND status = 'active'`)
      .get(fingerprint);
    return row ? rowToSkill(row) : null;
  }

  /** Find all composed skills (skills that reference sub-skills). */
  findAllComposed(): CachedSkill[] {
    const rows = this.db
      .prepare(`SELECT * FROM cached_skills WHERE composed_of IS NOT NULL ORDER BY success_rate DESC`)
      .all();
    return rows.map(rowToSkill);
  }

  /**
   * Detect skill compositions from co-occurrence patterns.
   * When a set of skills is repeatedly used together for the same task signature,
   * returns proposed compositions.
   */
  detectComposition(recentSkills: CachedSkill[], threshold = 3): Array<{ taskSignature: string; subSkills: string[] }> {
    // Group skills by task signature prefix (e.g., "build-auth" from "build-auth::jwt", "build-auth::middleware")
    const coOccurrences = new Map<string, Map<string, number>>();

    for (const skill of recentSkills) {
      const prefix = skill.taskSignature.split('::')[0] ?? skill.taskSignature;
      if (!coOccurrences.has(prefix)) {
        coOccurrences.set(prefix, new Map());
      }
      const sigMap = coOccurrences.get(prefix)!;
      sigMap.set(skill.taskSignature, (sigMap.get(skill.taskSignature) ?? 0) + skill.usageCount);
    }

    const compositions: Array<{ taskSignature: string; subSkills: string[] }> = [];

    for (const [prefix, sigMap] of coOccurrences) {
      // Only propose composition when ≥2 sub-skills co-occur ≥threshold times
      const qualifiedSigs = [...sigMap.entries()]
        .filter(([, count]) => count >= threshold)
        .map(([sig]) => sig);

      if (qualifiedSigs.length >= 2) {
        // Check this composition doesn't already exist
        const existing = this.findComposedSkill(`composed::${prefix}`);
        if (!existing) {
          compositions.push({
            taskSignature: `composed::${prefix}`,
            subSkills: qualifiedSigs,
          });
        }
      }
    }

    return compositions;
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
    origin: row.origin ?? 'local',
    composedOf: row.composed_of ? JSON.parse(row.composed_of) : undefined,
  };
}
