/**
 * `RoleProtocolRunStore` — Phase A2 audit log persistence for protocol
 * runs. One row per step execution.
 *
 * The driver itself stays pure (returns a `RoleProtocolRunResult`); the
 * orchestrator integration layer reads that result and persists each
 * `StepRunRecord` here. Keeping the driver db-free keeps it
 * independently testable + reusable across single-shot, agentic-loop,
 * and ACR dispatch paths.
 *
 * Bounded write rate: ≤1 row per step per task per attempt-batch. A
 * 6-step protocol with one retry on the verify step writes 7 rows.
 * Sleep-cycle retention (Phase 8+) prunes rows older than the
 * `world_graph.retention_max_age_days` ceiling.
 *
 * Mirrors `PersonaOverclaimStore` shape (parameterised clock,
 * INSERT-on-conflict-ignore, dedicated rowToRecord helper).
 */
import type { Database } from 'bun:sqlite';

export type RoleProtocolStepOutcome = 'success' | 'failure' | 'skipped' | 'oracle-blocked';

export interface RoleProtocolRunRecord {
  taskId: string;
  personaId: string;
  protocolId: string;
  stepId: string;
  stepIndex: number;
  outcome: RoleProtocolStepOutcome;
  attempts: number;
  confidence: number | null;
  tokensConsumed: number;
  durationMs: number;
  reason: string | null;
  oracleVerdicts: Readonly<Record<string, boolean>> | null;
  evidence: Readonly<Record<string, unknown>> | null;
  startedAt: number;
}

interface RoleProtocolRunRow {
  task_id: string;
  persona_id: string;
  protocol_id: string;
  step_id: string;
  step_index: number;
  outcome: string;
  attempts: number;
  confidence: number | null;
  tokens_consumed: number;
  duration_ms: number;
  reason: string | null;
  oracle_verdicts_json: string | null;
  evidence_json: string | null;
  started_at: number;
}

export interface RecordStepInput {
  readonly taskId: string;
  readonly personaId: string;
  readonly protocolId: string;
  readonly stepId: string;
  readonly stepIndex: number;
  readonly outcome: RoleProtocolStepOutcome;
  readonly attempts: number;
  readonly confidence?: number | null;
  readonly tokensConsumed: number;
  readonly durationMs: number;
  readonly reason?: string | null;
  readonly oracleVerdicts?: Readonly<Record<string, boolean>> | null;
  readonly evidence?: Readonly<Record<string, unknown>> | null;
  readonly startedAt?: number;
}

/** Cap evidence JSON serialization to keep audit rows from accumulating bodies. */
const EVIDENCE_JSON_MAX_BYTES = 64 * 1024;

export class RoleProtocolRunStore {
  constructor(private readonly db: Database) {}

  /**
   * Append a step record. Idempotent on (task_id, step_id, started_at) —
   * a retried `recordStep` call within a single millisecond is silently
   * dropped. Long-form `evidence` payloads are truncated to
   * `EVIDENCE_JSON_MAX_BYTES` of UTF-8; truncation is signaled by an
   * `evidence_truncated: true` field appended to the stored JSON.
   */
  recordStep(input: RecordStepInput): void {
    const startedAt = input.startedAt ?? Date.now();
    const oracleJson = input.oracleVerdicts ? JSON.stringify(input.oracleVerdicts) : null;
    const evidenceJson = serializeEvidence(input.evidence);

    this.db
      .prepare(
        `INSERT OR IGNORE INTO role_protocol_run
           (task_id, persona_id, protocol_id, step_id, step_index, outcome,
            attempts, confidence, tokens_consumed, duration_ms, reason,
            oracle_verdicts_json, evidence_json, started_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.taskId,
        input.personaId,
        input.protocolId,
        input.stepId,
        input.stepIndex,
        input.outcome,
        input.attempts,
        input.confidence ?? null,
        input.tokensConsumed,
        input.durationMs,
        input.reason ?? null,
        oracleJson,
        evidenceJson,
        startedAt,
      );
  }

  /** Replay one task's protocol run in step order. */
  listForTask(taskId: string): RoleProtocolRunRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM role_protocol_run
          WHERE task_id = ?
          ORDER BY step_index ASC, started_at ASC`,
      )
      .all(taskId) as RoleProtocolRunRow[];
    return rows.map(rowToRecord);
  }

  /** Recent runs of a single protocol, newest first. Used by operator dashboards. */
  listForProtocol(protocolId: string, limit = 100): RoleProtocolRunRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM role_protocol_run
          WHERE protocol_id = ?
          ORDER BY started_at DESC
          LIMIT ?`,
      )
      .all(protocolId, limit) as RoleProtocolRunRow[];
    return rows.map(rowToRecord);
  }

  /** Count of step outcomes for a persona — quick summary for sleep-cycle. */
  outcomeCountsForPersona(personaId: string): Record<RoleProtocolStepOutcome, number> {
    const rows = this.db
      .prepare(
        `SELECT outcome, COUNT(*) AS n
           FROM role_protocol_run
          WHERE persona_id = ?
          GROUP BY outcome`,
      )
      .all(personaId) as { outcome: string; n: number }[];
    const out: Record<RoleProtocolStepOutcome, number> = {
      success: 0,
      failure: 0,
      skipped: 0,
      'oracle-blocked': 0,
    };
    for (const row of rows) {
      if (row.outcome in out) {
        out[row.outcome as RoleProtocolStepOutcome] = row.n;
      }
    }
    return out;
  }
}

function serializeEvidence(evidence: Readonly<Record<string, unknown>> | null | undefined): string | null {
  if (!evidence) return null;
  let json: string;
  try {
    json = JSON.stringify(evidence);
  } catch {
    return null; // unserializable (cycle, BigInt, function); drop silently
  }
  if (json.length <= EVIDENCE_JSON_MAX_BYTES) return json;
  // Truncate by re-serializing a marker payload — original keys preserved
  // for audit triage but values stripped to a single sentinel.
  const truncated: Record<string, unknown> = { evidence_truncated: true, original_keys: Object.keys(evidence) };
  return JSON.stringify(truncated);
}

function rowToRecord(row: RoleProtocolRunRow): RoleProtocolRunRecord {
  return {
    taskId: row.task_id,
    personaId: row.persona_id,
    protocolId: row.protocol_id,
    stepId: row.step_id,
    stepIndex: row.step_index,
    outcome: row.outcome as RoleProtocolStepOutcome,
    attempts: row.attempts,
    confidence: row.confidence,
    tokensConsumed: row.tokens_consumed,
    durationMs: row.duration_ms,
    reason: row.reason,
    oracleVerdicts: row.oracle_verdicts_json ? JSON.parse(row.oracle_verdicts_json) : null,
    evidence: row.evidence_json ? JSON.parse(row.evidence_json) : null,
    startedAt: row.started_at,
  };
}
