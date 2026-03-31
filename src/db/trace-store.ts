/**
 * TraceStore — SQLite persistence for ExecutionTrace records.
 *
 * Denormalizes QualityScore into columns for efficient Sleep Cycle queries.
 * JSON-serializes complex fields (oracle_verdicts, affected_files, prediction_error).
 */
import type { Database } from "bun:sqlite";
import type { ExecutionTrace, ShadowValidationResult } from "../orchestrator/types.ts";

export class TraceStore {
  private db: Database;
  private insertStmt;

  constructor(db: Database) {
    this.db = db;
    this.insertStmt = db.prepare(`
      INSERT OR REPLACE INTO execution_traces (
        id, task_id, session_id, worker_id, timestamp, routing_level,
        task_type_signature, approach, approach_description, risk_score,
        quality_composite, quality_arch, quality_efficiency,
        quality_simplification, quality_testmutation,
        model_used, tokens_consumed, duration_ms,
        outcome, failure_reason, oracle_verdicts, affected_files,
        prediction_error, validation_depth, shadow_validation, exploration
      ) VALUES (
        $id, $task_id, $session_id, $worker_id, $timestamp, $routing_level,
        $task_type_signature, $approach, $approach_description, $risk_score,
        $quality_composite, $quality_arch, $quality_efficiency,
        $quality_simplification, $quality_testmutation,
        $model_used, $tokens_consumed, $duration_ms,
        $outcome, $failure_reason, $oracle_verdicts, $affected_files,
        $prediction_error, $validation_depth, $shadow_validation, $exploration
      )
    `);
  }

  insert(trace: ExecutionTrace): void {
    const qs = trace.qualityScore;
    this.insertStmt.run({
      $id: trace.id,
      $task_id: trace.taskId,
      $session_id: trace.session_id ?? null,
      $worker_id: trace.worker_id ?? null,
      $timestamp: trace.timestamp,
      $routing_level: trace.routingLevel,
      $task_type_signature: trace.task_type_signature ?? null,
      $approach: trace.approach,
      $approach_description: trace.approach_description ?? null,
      $risk_score: trace.risk_score ?? null,
      $quality_composite: qs?.composite ?? null,
      $quality_arch: qs?.architecturalCompliance ?? null,
      $quality_efficiency: qs?.efficiency ?? null,
      $quality_simplification: qs?.simplificationGain ?? null,
      $quality_testmutation: qs?.testMutationScore ?? null,
      $model_used: trace.model_used,
      $tokens_consumed: trace.tokens_consumed,
      $duration_ms: trace.duration_ms,
      $outcome: trace.outcome,
      $failure_reason: trace.failure_reason ?? null,
      $oracle_verdicts: JSON.stringify(trace.oracleVerdicts),
      $affected_files: JSON.stringify(trace.affected_files),
      $prediction_error: trace.predictionError ? JSON.stringify(trace.predictionError) : null,
      $validation_depth: trace.validation_depth ?? null,
      $shadow_validation: trace.shadow_validation ? JSON.stringify(trace.shadow_validation) : null,
      $exploration: trace.exploration ? 1 : null,
    });
  }

  queryByTaskType(taskTypeSignature: string, limit = 100): ExecutionTrace[] {
    const rows = this.db.prepare(
      `SELECT * FROM execution_traces WHERE task_type_signature = ? ORDER BY timestamp DESC LIMIT ?`,
    ).all(taskTypeSignature, limit);
    return rows.map(rowToTrace);
  }

  queryByOutcome(outcome: string, limit = 100): ExecutionTrace[] {
    const rows = this.db.prepare(
      `SELECT * FROM execution_traces WHERE outcome = ? ORDER BY timestamp DESC LIMIT ?`,
    ).all(outcome, limit);
    return rows.map(rowToTrace);
  }

  queryRecentTraces(limit = 50): ExecutionTrace[] {
    const rows = this.db.prepare(
      `SELECT * FROM execution_traces ORDER BY timestamp DESC LIMIT ?`,
    ).all(limit);
    return rows.map(rowToTrace);
  }

  queryByTimeRange(from: number, to: number): ExecutionTrace[] {
    const rows = this.db.prepare(
      `SELECT * FROM execution_traces WHERE timestamp >= ? AND timestamp <= ? ORDER BY timestamp ASC`,
    ).all(from, to);
    return rows.map(rowToTrace);
  }

  count(): number {
    const row = this.db.prepare(`SELECT COUNT(*) as cnt FROM execution_traces`).get() as { cnt: number };
    return row.cnt;
  }

  countDistinctTaskTypes(): number {
    const row = this.db.prepare(
      `SELECT COUNT(DISTINCT task_type_signature) as cnt FROM execution_traces WHERE task_type_signature IS NOT NULL`,
    ).get() as { cnt: number };
    return row.cnt;
  }

  /** Update a trace's shadow validation result (called after async shadow processing). */
  updateShadowValidation(taskId: string, result: ShadowValidationResult): void {
    this.db.prepare(
      `UPDATE execution_traces SET shadow_validation = ?, validation_depth = 'structural_and_tests'
       WHERE task_id = ?`,
    ).run(JSON.stringify(result), taskId);
  }
}

// ── Row → ExecutionTrace deserialization ────────────────────────────────

function rowToTrace(row: any): ExecutionTrace {
  return {
    id: row.id,
    taskId: row.task_id,
    session_id: row.session_id ?? undefined,
    worker_id: row.worker_id ?? undefined,
    timestamp: row.timestamp,
    routingLevel: row.routing_level,
    task_type_signature: row.task_type_signature ?? undefined,
    approach: row.approach,
    approach_description: row.approach_description ?? undefined,
    risk_score: row.risk_score ?? undefined,
    oracleVerdicts: JSON.parse(row.oracle_verdicts),
    qualityScore: row.quality_composite != null
      ? {
          architecturalCompliance: row.quality_arch,
          efficiency: row.quality_efficiency,
          simplificationGain: row.quality_simplification ?? undefined,
          testMutationScore: row.quality_testmutation ?? undefined,
          composite: row.quality_composite,
          dimensions_available: 2 + (row.quality_simplification != null ? 1 : 0) + (row.quality_testmutation != null ? 1 : 0),
          phase: (row.quality_simplification != null ? "phase1" : "phase0") as "phase0" | "phase1" | "phase2",
        }
      : undefined,
    model_used: row.model_used,
    tokens_consumed: row.tokens_consumed,
    duration_ms: row.duration_ms,
    outcome: row.outcome,
    failure_reason: row.failure_reason ?? undefined,
    affected_files: JSON.parse(row.affected_files),
    predictionError: row.prediction_error ? JSON.parse(row.prediction_error) : undefined,
    validation_depth: row.validation_depth ?? undefined,
    shadow_validation: row.shadow_validation ? JSON.parse(row.shadow_validation) : undefined,
    exploration: row.exploration === 1 ? true : undefined,
  };
}
