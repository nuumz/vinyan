/**
 * OracleAccuracyStore — SQLite-backed retrospective accuracy tracker for oracles.
 *
 * Solves C4 (circular accuracy): instead of measuring oracle agreement with
 * the gate decision the oracle itself influenced, we record verdicts at gate time
 * and resolve outcomes post-hoc when we observe real-world signals (test pass/fail,
 * revert, error report, or timeout sweep).
 *
 * A7 compliance: Prediction Error as Learning — accuracy = delta(predicted, actual).
 */
import type { Database } from 'bun:sqlite';
import { ORACLE_ACCURACY_SCHEMA_SQL } from './oracle-accuracy-schema.ts';

// ── Types ──────────────────────────────────────────────────────────────

export type VerdictOutcome =
  | 'confirmed_correct'   // No negative signal after commit (test pass, no revert)
  | 'confirmed_wrong'     // Negative signal (test fail, revert, error report)
  | 'correctly_rejected'  // Oracle blocked and rejection was not overridden
  | 'false_alarm'         // Oracle blocked but override succeeded
  | 'pending'             // Awaiting outcome
  | 'indeterminate';      // Cannot determine (e.g., task abandoned)

export interface OracleAccuracyRecord {
  id: string;
  oracleName: string;
  gateRunId: string;
  verdict: 'pass' | 'fail';
  confidence: number;
  tier: string;
  timestamp: number;
  affectedFiles: string[];
  outcome: VerdictOutcome;
  outcomeTimestamp?: number;
}

export interface OracleAccuracyStats {
  total: number;
  correct: number;       // confirmed_correct + correctly_rejected
  wrong: number;         // confirmed_wrong + false_alarm
  pending: number;
  accuracy: number | null;  // correct / (correct + wrong), null if < 10 resolved
}

// ── Store ──────────────────────────────────────────────────────────────

export class OracleAccuracyStore {
  private db: Database;

  constructor(db: Database) {
    this.db = db;
    this.ensureTable();
  }

  ensureTable(): void {
    this.db.exec(ORACLE_ACCURACY_SCHEMA_SQL);
  }

  /**
   * Record an oracle verdict at gate time. Outcome starts as 'pending'
   * and is resolved later by post-hoc signals.
   */
  recordVerdict(record: Omit<OracleAccuracyRecord, 'outcome' | 'outcomeTimestamp'>): void {
    this.db.run(
      `INSERT OR IGNORE INTO oracle_accuracy
       (id, oracle_name, gate_run_id, verdict, confidence, tier, timestamp, affected_files, outcome)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
      [
        record.id,
        record.oracleName,
        record.gateRunId,
        record.verdict,
        record.confidence,
        record.tier,
        record.timestamp,
        JSON.stringify(record.affectedFiles),
      ],
    );
  }

  /**
   * Resolve all pending records for a gate run with the given outcome.
   */
  resolveOutcome(gateRunId: string, outcome: VerdictOutcome): void {
    this.db.run(
      `UPDATE oracle_accuracy SET outcome = ?, outcome_timestamp = ?
       WHERE gate_run_id = ? AND outcome = 'pending'`,
      [outcome, Date.now(), gateRunId],
    );
  }

  /**
   * Resolve pending records that share any of the given affected files.
   * Uses JSON array matching — checks if any file path appears in the stored array.
   */
  resolveByFiles(filePaths: string[], outcome: VerdictOutcome): void {
    if (filePaths.length === 0) return;

    const now = Date.now();
    // Fetch all pending records and check file overlap in application code
    // (SQLite JSON functions vary by build; this approach is portable)
    const pendingRows = this.db.prepare(
      `SELECT id, affected_files FROM oracle_accuracy WHERE outcome = 'pending'`,
    ).all() as Array<{ id: string; affected_files: string }>;

    const fileSet = new Set(filePaths);
    const idsToResolve: string[] = [];

    for (const row of pendingRows) {
      const storedFiles: string[] = JSON.parse(row.affected_files);
      if (storedFiles.some(f => fileSet.has(f))) {
        idsToResolve.push(row.id);
      }
    }

    if (idsToResolve.length === 0) return;

    const placeholders = idsToResolve.map(() => '?').join(',');
    this.db.run(
      `UPDATE oracle_accuracy SET outcome = ?, outcome_timestamp = ?
       WHERE id IN (${placeholders}) AND outcome = 'pending'`,
      [outcome, now, ...idsToResolve],
    );
  }

  /**
   * Mark records pending for longer than maxAgeMs as 'confirmed_correct'.
   * Rationale: no negative signal within the window = assumed correct.
   */
  sweepStaleRecords(maxAgeMs: number): number {
    const cutoff = Date.now() - maxAgeMs;
    const result = this.db.run(
      `UPDATE oracle_accuracy SET outcome = 'confirmed_correct', outcome_timestamp = ?
       WHERE outcome = 'pending' AND timestamp < ?`,
      [Date.now(), cutoff],
    );
    return result.changes;
  }

  /**
   * Compute accuracy stats for a specific oracle.
   * Returns accuracy: null when fewer than 10 resolved verdicts (bootstrap protection).
   */
  computeOracleAccuracy(oracleName: string, windowDays?: number): OracleAccuracyStats {
    let timeFilter = '';
    const params: (string | number)[] = [oracleName];

    if (windowDays !== undefined) {
      const cutoff = Date.now() - windowDays * 24 * 60 * 60 * 1000;
      timeFilter = ' AND timestamp >= ?';
      params.push(cutoff);
    }

    const row = this.db.prepare(`
      SELECT
        COUNT(*) as total,
        COALESCE(SUM(CASE WHEN outcome IN ('confirmed_correct', 'correctly_rejected') THEN 1 ELSE 0 END), 0) as correct,
        COALESCE(SUM(CASE WHEN outcome IN ('confirmed_wrong', 'false_alarm') THEN 1 ELSE 0 END), 0) as wrong,
        COALESCE(SUM(CASE WHEN outcome = 'pending' THEN 1 ELSE 0 END), 0) as pending
      FROM oracle_accuracy
      WHERE oracle_name = ?${timeFilter}
    `).get(...params) as { total: number; correct: number; wrong: number; pending: number };

    const resolved = row.correct + row.wrong;

    return {
      total: row.total,
      correct: row.correct,
      wrong: row.wrong,
      pending: row.pending,
      accuracy: resolved >= 10 ? row.correct / resolved : null,
    };
  }

  /**
   * List every distinct oracle name that has ever produced a verdict. Used by
   * the profile bootstrap to seed lifecycle tracking for each local oracle.
   */
  listDistinctOracleNames(): string[] {
    const rows = this.db
      .prepare(`SELECT DISTINCT oracle_name FROM oracle_accuracy ORDER BY oracle_name ASC`)
      .all() as Array<{ oracle_name: string }>;
    return rows.map((r) => r.oracle_name);
  }
}
