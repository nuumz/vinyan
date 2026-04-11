/**
 * PredictionLedger — SQLite persistence for ForwardPredictor predictions and outcomes.
 *
 * Stores predictions before dispatch, actual outcomes after VERIFY,
 * and counterfactual plan rankings for calibration learning.
 *
 * Axiom: A7 (prediction error as learning signal)
 */
import type { Database } from 'bun:sqlite';
import { migratePredictionLedgerSchema } from './prediction-ledger-schema.ts';
import type {
  FileOutcomeStat,
  OutcomePrediction,
  PlanRankingRecord,
  PredictionDistribution,
  PredictionOutcome,
} from '../orchestrator/forward-predictor-types.ts';

export class PredictionLedger {
  private db: Database;
  private insertPredictionStmt;
  private insertOutcomeStmt;
  private insertPlanRankingStmt;

  constructor(db: Database) {
    this.db = db;
    migratePredictionLedgerSchema(db);

    this.insertPredictionStmt = db.prepare(`
      INSERT OR IGNORE INTO prediction_ledger (
        prediction_id, task_id, task_type_signature, basis,
        test_outcome_json, blast_radius_json, quality_score_json,
        confidence, timestamp, affected_files_json
      ) VALUES (
        $prediction_id, $task_id, $task_type_signature, $basis,
        $test_outcome_json, $blast_radius_json, $quality_score_json,
        $confidence, $timestamp, $affected_files_json
      )
    `);

    this.insertOutcomeStmt = db.prepare(`
      INSERT OR REPLACE INTO prediction_outcomes (
        prediction_id, actual_test_result, actual_blast_radius,
        actual_quality, actual_duration, brier_score,
        crps_blast, crps_quality, recorded_at
      ) VALUES (
        $prediction_id, $actual_test_result, $actual_blast_radius,
        $actual_quality, $actual_duration, $brier_score,
        $crps_blast, $crps_quality, $recorded_at
      )
    `);

    this.insertPlanRankingStmt = db.prepare(`
      INSERT INTO plan_rankings (
        task_id, selected_plan_id, selected_reason,
        rankings_json, actual_outcome_json, recorded_at
      ) VALUES (
        $task_id, $selected_plan_id, $selected_reason,
        $rankings_json, $actual_outcome_json, $recorded_at
      )
    `);
  }

  recordPrediction(pred: OutcomePrediction): void {
    this.insertPredictionStmt.run({
      $prediction_id: pred.predictionId,
      $task_id: pred.taskId,
      $task_type_signature: '', // OutcomePrediction lacks taskTypeSignature; schema defaults to ''
      $basis: pred.basis,
      $test_outcome_json: JSON.stringify(pred.testOutcome),
      $blast_radius_json: JSON.stringify(pred.blastRadius),
      $quality_score_json: JSON.stringify(pred.qualityScore),
      $confidence: pred.confidence,
      $timestamp: pred.timestamp,
      $affected_files_json: JSON.stringify(pred.causalRiskFiles.map((f) => f.filePath)),
    });
  }

  recordOutcome(
    outcome: PredictionOutcome,
    brierScore: number,
    crpsBlast?: number,
    crpsQuality?: number,
  ): void {
    this.insertOutcomeStmt.run({
      $prediction_id: outcome.predictionId,
      $actual_test_result: outcome.actualTestResult,
      $actual_blast_radius: outcome.actualBlastRadius,
      $actual_quality: outcome.actualQuality,
      $actual_duration: outcome.actualDuration,
      $brier_score: brierScore,
      $crps_blast: crpsBlast ?? null,
      $crps_quality: crpsQuality ?? null,
      $recorded_at: Date.now(),
    });
  }

  getPercentiles(taskType: string, _percentiles: number[]): PredictionDistribution {
    const rows = this.db
      .prepare(
        `SELECT po.actual_blast_radius
         FROM prediction_outcomes po
         JOIN prediction_ledger pl ON po.prediction_id = pl.prediction_id
         WHERE pl.task_type_signature = ?
         ORDER BY po.actual_blast_radius ASC`,
      )
      .all(taskType) as Array<{ actual_blast_radius: number }>;

    if (rows.length === 0) {
      return { lo: 0, mid: 0, hi: 0 };
    }

    const values = rows.map((r) => r.actual_blast_radius);
    const p = (pct: number): number => {
      const idx = Math.min(Math.floor(pct * values.length), values.length - 1);
      return values[idx] ?? 0;
    };

    return { lo: p(0.1), mid: p(0.5), hi: p(0.9) };
  }

  getFileOutcomeStats(files: string[]): FileOutcomeStat[] {
    if (files.length === 0) return [];

    const allRows = this.db
      .prepare(
        `SELECT pl.affected_files_json, po.actual_test_result, po.actual_quality
         FROM prediction_ledger pl
         JOIN prediction_outcomes po ON pl.prediction_id = po.prediction_id
         WHERE pl.affected_files_json IS NOT NULL`,
      )
      .all() as Array<{ affected_files_json: string; actual_test_result: string; actual_quality: number }>;

    const fileSet = new Set(files);
    const stats = new Map<
      string,
      { successCount: number; failCount: number; partialCount: number; totalQuality: number; samples: number }
    >();

    for (const row of allRows) {
      let affectedFiles: string[];
      try {
        affectedFiles = JSON.parse(row.affected_files_json);
      } catch {
        continue;
      }

      for (const file of affectedFiles) {
        if (!fileSet.has(file)) continue;

        let stat = stats.get(file);
        if (!stat) {
          stat = { successCount: 0, failCount: 0, partialCount: 0, totalQuality: 0, samples: 0 };
          stats.set(file, stat);
        }

        stat.samples++;
        stat.totalQuality += row.actual_quality;

        if (row.actual_test_result === 'pass') stat.successCount++;
        else if (row.actual_test_result === 'fail') stat.failCount++;
        else stat.partialCount++;
      }
    }

    const result: FileOutcomeStat[] = [];
    for (const [filePath, stat] of stats) {
      result.push({
        filePath,
        successCount: stat.successCount,
        failCount: stat.failCount,
        partialCount: stat.partialCount,
        samples: stat.samples,
        avgQuality: stat.samples > 0 ? stat.totalQuality / stat.samples : 0,
      });
    }
    return result;
  }

  getTraceCount(): number {
    return (this.db.prepare('SELECT COUNT(*) as cnt FROM prediction_ledger').get() as { cnt: number }).cnt;
  }

  getRecentBrierScores(window: number): number[] {
    const rows = this.db
      .prepare(
        `SELECT brier_score FROM prediction_outcomes
         WHERE brier_score IS NOT NULL
         ORDER BY recorded_at DESC LIMIT ?`,
      )
      .all(window) as Array<{ brier_score: number }>;

    return rows.map((r) => r.brier_score);
  }

  recordPlanRanking(record: PlanRankingRecord): void {
    this.insertPlanRankingStmt.run({
      $task_id: record.taskId,
      $selected_plan_id: record.selectedPlanId,
      $selected_reason: record.selectedReason,
      $rankings_json: JSON.stringify(record.planRankings),
      $actual_outcome_json: record.actualOutcome ? JSON.stringify(record.actualOutcome) : null,
      $recorded_at: Date.now(),
    });
  }

  getPredictionCount(): number {
    return (this.db.prepare('SELECT COUNT(*) as cnt FROM prediction_outcomes').get() as { cnt: number }).cnt;
  }
}