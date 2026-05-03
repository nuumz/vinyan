/**
 * `SkillAdmissionStore` — append-only audit log for skill-admission verdicts.
 *
 * Mirrors the `PersonaOverclaimStore` shape: parameterised clock, idempotent
 * insert, prepared statements. Append-only because admission is a per-promotion
 * decision (not a counter) — the auditor needs to see "researcher rejected
 * marketing-copy at T1, accepted literature-review at T2" as distinct rows,
 * not aggregates.
 *
 * Bounded write rate: ≤1 row per (persona, skill) per `proposeAcquired
 * ToBoundPromotions` invocation. Sleep-cycle calls the proposer once per cycle
 * (default ≥1h); CLI invocations are operator-driven. Volume is rounding error
 * vs the `task_events` table.
 *
 * Composite PK guards against two concurrent sleep-cycle workers writing the
 * same verdict for the same persona+skill in the same millisecond — extremely
 * unlikely, but the cost of `INSERT OR IGNORE` is one B-tree probe.
 */
import type { Database } from 'bun:sqlite';

export type AdmissionVerdict = 'accept' | 'reject';

export interface SkillAdmissionRecord {
  personaId: string;
  skillId: string;
  verdict: AdmissionVerdict;
  overlapRatio: number;
  reason: string | null;
  decidedAt: number;
}

interface SkillAdmissionRow {
  persona_id: string;
  skill_id: string;
  verdict: string;
  overlap_ratio: number;
  reason: string | null;
  decided_at: number;
}

export class SkillAdmissionStore {
  constructor(private readonly db: Database) {}

  /** Append a verdict row. Idempotent on (persona_id, skill_id, decided_at). */
  recordVerdict(
    personaId: string,
    skillId: string,
    verdict: AdmissionVerdict,
    overlapRatio: number,
    reason: string | null = null,
    now = Date.now(),
  ): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO skill_admission_audit
           (persona_id, skill_id, verdict, overlap_ratio, reason, decided_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(personaId, skillId, verdict, overlapRatio, reason, now);
  }

  /** All verdicts for a persona, newest first. */
  listForPersona(personaId: string): SkillAdmissionRecord[] {
    const rows = this.db
      .prepare(
        `SELECT persona_id, skill_id, verdict, overlap_ratio, reason, decided_at
           FROM skill_admission_audit
          WHERE persona_id = ?
          ORDER BY decided_at DESC, skill_id ASC`,
      )
      .all(personaId) as SkillAdmissionRow[];
    return rows.map(rowToRecord);
  }

  /** All verdicts of one kind across personas, newest first. Used by CLI `--show-rejected`. */
  listByVerdict(verdict: AdmissionVerdict, limit = 50): SkillAdmissionRecord[] {
    const rows = this.db
      .prepare(
        `SELECT persona_id, skill_id, verdict, overlap_ratio, reason, decided_at
           FROM skill_admission_audit
          WHERE verdict = ?
          ORDER BY decided_at DESC
          LIMIT ?`,
      )
      .all(verdict, limit) as SkillAdmissionRow[];
    return rows.map(rowToRecord);
  }

  /** Count of rows by verdict for a persona — cheap summary for ledger health checks. */
  countForPersona(personaId: string): { accept: number; reject: number } {
    const rows = this.db
      .prepare(
        `SELECT verdict, COUNT(*) AS n
           FROM skill_admission_audit
          WHERE persona_id = ?
          GROUP BY verdict`,
      )
      .all(personaId) as { verdict: string; n: number }[];
    let accept = 0;
    let reject = 0;
    for (const row of rows) {
      if (row.verdict === 'accept') accept = row.n;
      else if (row.verdict === 'reject') reject = row.n;
    }
    return { accept, reject };
  }
}

function rowToRecord(row: SkillAdmissionRow): SkillAdmissionRecord {
  return {
    personaId: row.persona_id,
    skillId: row.skill_id,
    verdict: row.verdict as AdmissionVerdict,
    overlapRatio: row.overlap_ratio,
    reason: row.reason,
    decidedAt: row.decided_at,
  };
}
