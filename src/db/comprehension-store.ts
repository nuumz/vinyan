/**
 * ComprehensionStore — SQLite-backed audit + calibration feed for the
 * A7 learning loop (docs/spec/tdd.md axiom A7).
 *
 * Two-phase lifecycle per comprehension:
 *   1. `record()` on `comprehension:committed` — writes the envelope +
 *      oracle verdict. outcome is NULL.
 *   2. `markOutcome()` called by CorrectionDetector on the next turn —
 *      marks whether the user confirmed or corrected the prior resolvedGoal.
 *
 * Read paths:
 *   - `mostRecentForSession(sessionId)` — used by CorrectionDetector at
 *     turn N+1 to find turn N's comprehension to judge.
 *   - `recentByEngine(engineId, limit)` — used by Calibrator to compute
 *     per-engine accuracy EMA over the last N outcomes.
 *
 * All writes are **best-effort**: callers wrap in try/catch so a DB error
 * never blocks a task. The persistence is A7 scaffolding — the pipeline
 * must run even when the learning substrate is unavailable.
 */
import type { Database, Statement } from 'bun:sqlite';
import type {
  ComprehendedTaskMessage,
  ComprehensionEngineType,
} from '../orchestrator/comprehension/types.ts';

/** Outcome taxonomy (A2 — explicit state, no silent defaults). */
export type ComprehensionOutcome =
  | 'confirmed'  // user's next turn continued the thread naturally
  | 'corrected'  // user explicitly overrode the resolvedGoal
  | 'abandoned'; // session ended / long gap before a follow-up

export interface ComprehensionRecordRow {
  readonly input_hash: string;
  readonly task_id: string;
  readonly session_id: string | null;
  readonly engine_id: string;
  /**
   * AXM#4: declared engine type at record time. `null` only on
   * historical rows predating migration 030; new rows always carry a
   * value. Calibration integrity decisions should prefer this over
   * `engine_id` for cross-engine grouping.
   */
  readonly engine_type: ComprehensionEngineType | null;
  readonly tier: string;
  readonly type: 'comprehension' | 'unknown';
  readonly confidence: number;
  readonly verdict_pass: 0 | 1;
  readonly verdict_reason: string | null;
  readonly envelope_json: string;
  readonly created_at: number;
  readonly outcome: ComprehensionOutcome | null;
  readonly outcome_evidence: string | null;
  readonly outcome_at: number | null;
}

export interface RecordInput {
  envelope: ComprehendedTaskMessage;
  taskId: string;
  sessionId?: string;
  /**
   * Engine id (e.g. 'rule-comprehender', 'llm-comprehender') — required,
   * because the envelope itself carries no engine identity. Calibration
   * keys on this column; callers MUST supply the value they dispatched.
   */
  engineId: string;
  /**
   * AXM#4: declared engine type — required so calibration can separate
   * engines by type and so an `engine_id` collision cannot silently
   * corrupt a different engine's calibration history.
   */
  engineType: ComprehensionEngineType;
  verdictPass: boolean;
  verdictReason?: string;
  createdAt?: number;
}

export interface OutcomeInput {
  outcome: ComprehensionOutcome;
  /** Short JSON-serializable evidence describing why this outcome was assigned. */
  evidence: Record<string, unknown>;
  markedAt?: number;
}

/**
 * Persistence façade for `comprehension_records`. Holds pre-compiled
 * prepared statements so per-turn insert is one allocation path.
 */
export class ComprehensionStore {
  private readonly insertStmt: Statement;
  private readonly updateOutcomeStmt: Statement;
  private readonly updateOutcomeByEngineStmt: Statement;
  private readonly recentBySessionStmt: Statement;
  private readonly recentByEngineStmt: Statement;
  private readonly recentByEngineTypedStmt: Statement;
  private readonly staleSweepStmt: Statement;
  private readonly countStmt: Statement;
  private readonly outcomedInWindowStmt: Statement;

  constructor(private readonly db: Database) {
    // INSERT OR IGNORE: a duplicate (inputHash, engineId) is a no-op
    // (PK = composite per migration 037). This makes `record()`
    // idempotent for retries, while still allowing stage-1 and stage-2
    // engines to BOTH persist for the same turn.
    this.insertStmt = db.prepare(`
      INSERT OR IGNORE INTO comprehension_records (
        input_hash, task_id, session_id, engine_id, engine_type, tier, type, confidence,
        verdict_pass, verdict_reason, envelope_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.updateOutcomeStmt = db.prepare(`
      UPDATE comprehension_records
         SET outcome = ?, outcome_evidence = ?, outcome_at = ?
       WHERE input_hash = ? AND outcome IS NULL
    `);
    // Engine-scoped update — used when the caller knows which engine's
    // resolvedGoal actually reached the user (merge-winner). Only that
    // row is marked; sibling rows from the hybrid pipeline stay NULL to
    // avoid cross-engine calibration contamination.
    this.updateOutcomeByEngineStmt = db.prepare(`
      UPDATE comprehension_records
         SET outcome = ?, outcome_evidence = ?, outcome_at = ?
       WHERE input_hash = ? AND engine_id = ? AND outcome IS NULL
    `);
    this.recentBySessionStmt = db.prepare(`
      SELECT * FROM comprehension_records
       WHERE session_id = ?
       ORDER BY created_at DESC
       LIMIT ?
    `);
    this.recentByEngineStmt = db.prepare(`
      SELECT * FROM comprehension_records
       WHERE engine_id = ? AND outcome IS NOT NULL
       ORDER BY created_at DESC
       LIMIT ?
    `);
    // GAP#5 — engine-type filter variant. Calibration integrity depends
    // on correctly attributing outcomes to the right (engine_id, type).
    // An ID collision (bug or rogue) would corrupt calibration for that
    // ID unless consumers pass the expected type too. AXM#4 added the
    // column; this query uses it.
    this.recentByEngineTypedStmt = db.prepare(`
      SELECT * FROM comprehension_records
       WHERE engine_id = ? AND engine_type = ? AND outcome IS NOT NULL
       ORDER BY created_at DESC
       LIMIT ?
    `);
    this.staleSweepStmt = db.prepare(`
      UPDATE comprehension_records
         SET outcome = 'abandoned', outcome_evidence = ?, outcome_at = ?
       WHERE outcome IS NULL AND created_at < ?
    `);
    this.countStmt = db.prepare(`
      SELECT COUNT(*) AS c FROM comprehension_records
    `);
    // Sleep Cycle comprehension miner — needs ALL outcomed records in a
    // time window (not just per-engine). Limited by `limit` for safety.
    this.outcomedInWindowStmt = db.prepare(`
      SELECT * FROM comprehension_records
       WHERE outcome IS NOT NULL AND created_at >= ?
       ORDER BY created_at DESC
       LIMIT ?
    `);
  }

  /**
   * Write a new comprehension record. Returns `true` when the row was
   * inserted (idempotent: same inputHash → false on the second call).
   */
  record(input: RecordInput): boolean {
    const params = input.envelope.params;
    const created = input.createdAt ?? Date.now();
    const info = this.insertStmt.run(
      params.inputHash,
      input.taskId,
      input.sessionId ?? null,
      input.engineId,
      input.engineType,
      params.tier,
      params.type,
      params.confidence,
      input.verdictPass ? 1 : 0,
      input.verdictReason ?? null,
      JSON.stringify(input.envelope),
      created,
    );
    return info.changes > 0;
  }

  /**
   * Fill in the outcome on a previously-recorded comprehension. Returns
   * `true` when a row was actually updated (false when the record is
   * missing or already has an outcome — idempotent).
   *
   * When `engineId` is provided, scopes the update to that engine only.
   * Use this in the hybrid pipeline (rule + llm): only the engine whose
   * resolvedGoal actually reached the user should receive the outcome
   * label. Omitting `engineId` updates ALL rows sharing the inputHash —
   * correct for single-engine flows; BIASED for hybrid flows.
   */
  markOutcome(inputHash: string, outcome: OutcomeInput, engineId?: string): boolean {
    const markedAt = outcome.markedAt ?? Date.now();
    const evidenceJson = JSON.stringify(outcome.evidence);
    const info = engineId
      ? this.updateOutcomeByEngineStmt.run(outcome.outcome, evidenceJson, markedAt, inputHash, engineId)
      : this.updateOutcomeStmt.run(outcome.outcome, evidenceJson, markedAt, inputHash);
    return info.changes > 0;
  }

  /**
   * Return the most recent records for a session, newest first. The
   * CorrectionDetector typically reads the top 1–2 to judge the prior
   * turn's resolvedGoal against the new user turn.
   */
  mostRecentForSession(sessionId: string, limit = 5): ComprehensionRecordRow[] {
    return this.recentBySessionStmt.all(sessionId, limit) as ComprehensionRecordRow[];
  }

  /**
   * Per-engine outcomes — calibration input.
   *
   * When `engineType` is provided (GAP#5), additionally filters by the
   * AXM#4 engine_type column so an engine_id collision cannot silently
   * contaminate calibration for the legitimate owner. Callers that know
   * their engine's type SHOULD always pass it.
   */
  recentByEngine(
    engineId: string,
    limit = 200,
    engineType?: ComprehensionEngineType,
  ): ComprehensionRecordRow[] {
    if (engineType) {
      return this.recentByEngineTypedStmt.all(
        engineId,
        engineType,
        limit,
      ) as ComprehensionRecordRow[];
    }
    return this.recentByEngineStmt.all(engineId, limit) as ComprehensionRecordRow[];
  }

  /**
   * Mark records as abandoned when no follow-up arrived within `staleMs`.
   * Safe to call periodically; no-op when there are no stale rows.
   * Returns the number of rows touched.
   */
  sweepStale(staleMs: number, evidence: Record<string, unknown> = { reason: 'stale' }, now = Date.now()): number {
    const info = this.staleSweepStmt.run(JSON.stringify(evidence), now, now - staleMs);
    return info.changes;
  }

  /** Total rows — used by tests and data-gate checks. */
  count(): number {
    const row = this.countStmt.get() as { c: number } | undefined;
    return row?.c ?? 0;
  }

  /**
   * All outcomed records since `sinceMs`, newest first. Used by the
   * Sleep Cycle comprehension miner (B1–B3) to compute cross-engine
   * analyses: engine-fit by session, stage-1 vs stage-2 agreement, and
   * divergence attribution. Caller provides `limit` as a safety cap.
   */
  outcomedInWindow(sinceMs: number, limit = 2000): ComprehensionRecordRow[] {
    return this.outcomedInWindowStmt.all(sinceMs, limit) as ComprehensionRecordRow[];
  }

}
