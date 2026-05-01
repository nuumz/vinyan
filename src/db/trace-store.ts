/**
 * TraceStore — SQLite persistence for ExecutionTrace records.
 *
 * Denormalizes QualityScore into columns for efficient Sleep Cycle queries.
 * JSON-serializes complex fields (oracle_verdicts, affected_files, prediction_error).
 */
import type { Database } from 'bun:sqlite';
import { tryAsPersonaId } from '../core/agent-vocabulary.ts';
import type { ExecutionTrace, ShadowValidationResult } from '../orchestrator/types.ts';
import {
  GOVERNANCE_QUERY_DEFAULT_LIMIT,
  type GovernanceTraceQuery,
  type GovernanceTraceQueryResult,
  normalizeGovernanceQuery,
  summarizeGovernanceTrace,
} from './governance-query.ts';
import { ExecutionTraceRowSchema } from './schemas.ts';

export class TraceStore {
  private db: Database;
  private insertStmt;

  constructor(db: Database) {
    this.db = db;
    this.insertStmt = db.prepare(`
      INSERT OR IGNORE INTO execution_traces (
        id, task_id, session_id, worker_id, agent_id, timestamp, routing_level,
        task_type_signature, approach, approach_description, risk_score,
        quality_composite, quality_arch, quality_efficiency,
        quality_simplification, quality_testmutation,
        model_used, tokens_consumed, duration_ms,
        outcome, failure_reason, oracle_verdicts, affected_files,
        prediction_error, validation_depth, shadow_validation, exploration,
        framework_markers, worker_selection_audit,
        pipeline_confidence_composite, confidence_decision,
        transcript_gzip, transcript_turns,
        thinking_mode, thinking_tokens_used, thinking_meta,
        understanding_depth, understanding_intent, resolved_entities,
        understanding_verified, understanding_primary_action,
        agent_selection_reason, capability_requirements, capability_analysis,
        selected_capability_profile_id, selected_capability_profile_source,
        selected_capability_profile_trust_tier, capability_fit_score,
        unmet_capability_ids, synthetic_agent_id, knowledge_used,
        governance_provenance, routing_decision_id, policy_version,
        governance_actor, decision_timestamp, evidence_observed_at,
        goal_grounding, oracle_independence
      ) VALUES (
        $id, $task_id, $session_id, $worker_id, $agent_id, $timestamp, $routing_level,
        $task_type_signature, $approach, $approach_description, $risk_score,
        $quality_composite, $quality_arch, $quality_efficiency,
        $quality_simplification, $quality_testmutation,
        $model_used, $tokens_consumed, $duration_ms,
        $outcome, $failure_reason, $oracle_verdicts, $affected_files,
        $prediction_error, $validation_depth, $shadow_validation, $exploration,
        $framework_markers, $worker_selection_audit,
        $pipeline_confidence_composite, $confidence_decision,
        $transcript_gzip, $transcript_turns,
        $thinking_mode, $thinking_tokens_used, $thinking_meta,
        $understanding_depth, $understanding_intent, $resolved_entities,
        $understanding_verified, $understanding_primary_action,
        $agent_selection_reason, $capability_requirements, $capability_analysis,
        $selected_capability_profile_id, $selected_capability_profile_source,
        $selected_capability_profile_trust_tier, $capability_fit_score,
        $unmet_capability_ids, $synthetic_agent_id, $knowledge_used,
        $governance_provenance, $routing_decision_id, $policy_version,
        $governance_actor, $decision_timestamp, $evidence_observed_at,
        $goal_grounding, $oracle_independence
      )
    `);
  }

  insert(trace: ExecutionTrace): void {
    const qs = trace.qualityScore;
    const governance = trace.governanceProvenance;
    this.insertStmt.run({
      $id: trace.id,
      $task_id: trace.taskId,
      $session_id: trace.sessionId ?? null,
      $worker_id: trace.workerId ?? null,
      $agent_id: trace.agentId ?? null,
      $timestamp: trace.timestamp,
      $routing_level: trace.routingLevel,
      $task_type_signature: trace.taskTypeSignature ?? null,
      $approach: trace.approach,
      $approach_description: trace.approachDescription ?? null,
      $risk_score: trace.riskScore ?? null,
      $quality_composite: qs?.composite ?? null,
      $quality_arch: qs?.architecturalCompliance ?? null,
      $quality_efficiency: qs?.efficiency ?? null,
      $quality_simplification: qs?.simplificationGain ?? null,
      $quality_testmutation: qs?.testPresenceHeuristic ?? null,
      $model_used: trace.modelUsed,
      $tokens_consumed: trace.tokensConsumed,
      $duration_ms: trace.durationMs,
      $outcome: trace.outcome,
      $failure_reason: trace.failureReason ?? null,
      $oracle_verdicts: JSON.stringify(trace.oracleVerdicts),
      $affected_files: JSON.stringify(trace.affectedFiles),
      $prediction_error: trace.predictionError ? JSON.stringify(trace.predictionError) : null,
      $validation_depth: trace.validationDepth ?? null,
      $shadow_validation: trace.shadowValidation ? JSON.stringify(trace.shadowValidation) : null,
      $exploration: trace.exploration ? 1 : null,
      $framework_markers: trace.frameworkMarkers ? JSON.stringify(trace.frameworkMarkers) : null,
      $worker_selection_audit: trace.workerSelectionAudit ? JSON.stringify(trace.workerSelectionAudit) : null,
      $pipeline_confidence_composite: trace.pipelineConfidence?.composite ?? null,
      $confidence_decision: trace.confidenceDecision ? JSON.stringify(trace.confidenceDecision) : null,
      $transcript_gzip: trace.transcriptGzip ?? null,
      $transcript_turns: trace.transcriptTurns ?? null,
      $thinking_mode: trace.thinkingMode ?? null,
      $thinking_tokens_used: trace.thinkingTokensUsed ?? null,
      $thinking_meta: trace.thinkingMeta ? JSON.stringify(trace.thinkingMeta) : null,
      $understanding_depth: trace.understandingDepth ?? null,
      $understanding_intent: trace.understandingIntent ?? null,
      $resolved_entities: trace.resolvedEntities ?? null,
      $understanding_verified: trace.understandingVerified ?? null,
      $understanding_primary_action: trace.understandingPrimaryAction ?? null,
      $agent_selection_reason: trace.agentSelectionReason ?? null,
      $capability_requirements: trace.capabilityRequirements ? JSON.stringify(trace.capabilityRequirements) : null,
      $capability_analysis: trace.capabilityAnalysis ? JSON.stringify(trace.capabilityAnalysis) : null,
      $selected_capability_profile_id: trace.selectedCapabilityProfileId ?? null,
      $selected_capability_profile_source: trace.selectedCapabilityProfileSource ?? null,
      $selected_capability_profile_trust_tier: trace.selectedCapabilityProfileTrustTier ?? null,
      $capability_fit_score: trace.capabilityFitScore ?? null,
      $unmet_capability_ids: trace.unmetCapabilityIds ? JSON.stringify(trace.unmetCapabilityIds) : null,
      $synthetic_agent_id: trace.syntheticAgentId ?? null,
      $knowledge_used: trace.knowledgeUsed ? JSON.stringify(trace.knowledgeUsed) : null,
      $governance_provenance: governance ? JSON.stringify(governance) : null,
      $routing_decision_id: governance?.decisionId ?? null,
      $policy_version: governance?.policyVersion ?? null,
      $governance_actor: governance?.attributedTo ?? null,
      $decision_timestamp: governance?.decidedAt ?? null,
      $evidence_observed_at: governance?.evidenceObservedAt ?? null,
      $goal_grounding: trace.goalGrounding ? JSON.stringify(trace.goalGrounding) : null,
      $oracle_independence: trace.oracleIndependence ? JSON.stringify(trace.oracleIndependence) : null,
    });
  }

  findByTaskType(taskTypeSignature: string, limit = 100): ExecutionTrace[] {
    const rows = this.db
      .prepare(`SELECT * FROM execution_traces WHERE task_type_signature = ? ORDER BY timestamp DESC LIMIT ?`)
      .all(taskTypeSignature, limit);
    return rows.map(rowToTrace);
  }

  findByOutcome(outcome: string, limit = 100): ExecutionTrace[] {
    const rows = this.db
      .prepare(`SELECT * FROM execution_traces WHERE outcome = ? ORDER BY timestamp DESC LIMIT ?`)
      .all(outcome, limit);
    return rows.map(rowToTrace);
  }

  /**
   * Multi-agent: load traces produced by a specific specialist agent. Used
   * by AgentEvolution to drive per-agent soul reflection and pattern mining
   * without cross-contamination from other specialists. Rows with NULL
   * agent_id are pre-multi-agent and intentionally excluded.
   */
  findByAgent(agentId: string, limit = 100): ExecutionTrace[] {
    const rows = this.db
      .prepare(`SELECT * FROM execution_traces WHERE agent_id = ? ORDER BY timestamp DESC LIMIT ?`)
      .all(agentId, limit);
    return rows.map(rowToTrace);
  }

  findRecent(limit = 50): ExecutionTrace[] {
    const rows = this.db.prepare(`SELECT * FROM execution_traces ORDER BY timestamp DESC LIMIT ?`).all(limit);
    return rows.map(rowToTrace);
  }

  /**
   * Look up the (single) trace for a given task. The task→trace relation is
   * 1:1 in the current schema, so we return the most recent row defensively
   * in case a task ever gets re-traced. Used by the chat history API to
   * attach a trace summary onto each persisted assistant message.
   */
  findByTaskId(taskId: string): ExecutionTrace | undefined {
    const row = this.db
      .prepare(`SELECT * FROM execution_traces WHERE task_id = ? ORDER BY timestamp DESC LIMIT 1`)
      .get(taskId);
    return row ? rowToTrace(row) : undefined;
  }

  findByTimeRange(from: number, to: number): ExecutionTrace[] {
    const rows = this.db
      .prepare(`SELECT * FROM execution_traces WHERE timestamp >= ? AND timestamp <= ? ORDER BY timestamp ASC`)
      .all(from, to);
    return rows.map(rowToTrace);
  }

  count(): number {
    const row = this.db.prepare(`SELECT COUNT(*) as cnt FROM execution_traces`).get() as { cnt: number };
    return row.cnt;
  }

  countDistinctTaskTypes(): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(DISTINCT task_type_signature) as cnt FROM execution_traces WHERE task_type_signature IS NOT NULL`,
      )
      .get() as { cnt: number };
    return row.cnt;
  }

  /** Extensible Thinking Phase 1b: overall fail rate across all traces. */
  getFailRate(): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) as total, SUM(CASE WHEN outcome = 'failure' THEN 1 ELSE 0 END) as failures FROM execution_traces`,
      )
      .get() as { total: number; failures: number };
    return row.total === 0 ? 0 : row.failures / row.total;
  }

  /** Extensible Thinking Phase 1b: per-task-type trace counts for data gates. */
  countByTaskType(): Record<string, number> {
    const rows = this.db
      .prepare(
        `SELECT task_type_signature, COUNT(*) as cnt FROM execution_traces WHERE task_type_signature IS NOT NULL GROUP BY task_type_signature`,
      )
      .all() as Array<{ task_type_signature: string; cnt: number }>;
    const result: Record<string, number> = {};
    for (const row of rows) {
      result[row.task_type_signature] = row.cnt;
    }
    return result;
  }

  /** Extensible Thinking: count traces that have thinking_mode set. */
  countWithThinking(): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) as cnt FROM execution_traces WHERE thinking_mode IS NOT NULL`)
      .get() as { cnt: number };
    return row.cnt;
  }

  /** Extensible Thinking: count distinct task types that have thinking data. */
  countDistinctThinkingTaskTypes(): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(DISTINCT task_type_signature) as cnt FROM execution_traces WHERE thinking_mode IS NOT NULL AND task_type_signature IS NOT NULL`,
      )
      .get() as { cnt: number };
    return row.cnt;
  }

  /**
   * Extensible Thinking: success-rate / quality-composite breakdown
   * keyed by `thinking_mode`. The thinking readiness gate consumes this
   * to decide when adaptive thinking should be unblocked — see
   * `evaluateThinkingReadiness`.
   *
   * Rows with NULL `thinking_mode` are bucketed under the sentinel
   * `'(none)'` rather than silently dropped, so "thinking off" runs can be
   * compared directly against "thinking on" runs.
   */
  getSuccessRateByThinkingMode(): Array<{
    thinkingMode: string;
    total: number;
    successes: number;
    failures: number;
    successRate: number;
    avgQualityComposite: number | null;
  }> {
    const rows = this.db
      .prepare(
        `SELECT
           COALESCE(thinking_mode, '(none)') AS mode,
           COUNT(*) AS total,
           SUM(CASE WHEN outcome = 'success' THEN 1 ELSE 0 END) AS successes,
           SUM(CASE WHEN outcome = 'failure' THEN 1 ELSE 0 END) AS failures,
           AVG(quality_composite) AS avg_quality
         FROM execution_traces
         GROUP BY mode`,
      )
      .all() as Array<{
      mode: string;
      total: number;
      successes: number;
      failures: number;
      avg_quality: number | null;
    }>;
    return rows.map((r) => ({
      thinkingMode: r.mode,
      total: r.total,
      successes: r.successes,
      failures: r.failures,
      successRate: r.total === 0 ? 0 : r.successes / r.total,
      avgQualityComposite: r.avg_quality,
    }));
  }

  /** Update a trace's shadow validation result (called after async shadow processing). */
  updateShadowValidation(taskId: string, result: ShadowValidationResult): void {
    // Wrap in IMMEDIATE transaction so the writer claims the WAL lock up
    // front. Bare auto-commit `.run()` racing with concurrent shadow:complete
    // handlers caused SQLITE_IOERR_VNODE on macOS. busy_timeout (set on the
    // connection in vinyan-db.ts) handles transient contention; this wrapping
    // prevents partial-write interleaving.
    const stmt = this.db.prepare(
      `UPDATE execution_traces SET shadow_validation = ?, validation_depth = 'structural_and_tests'
       WHERE task_id = ?`,
    );
    const tx = this.db.transaction((payload: string, id: string) => {
      stmt.run(payload, id);
    });
    try {
      tx.immediate(JSON.stringify(result), taskId);
    } catch (err) {
      // Last-resort: shadow validation is best-effort metadata; a transient I/O
      // failure must not propagate up and abort the active task. Log and swallow.
      console.warn('[vinyan] updateShadowValidation failed (best-effort):', err);
    }
  }

  /**
   * A8 / T2 — query traces by governance facets. Uses the denormalized
   * `routing_decision_id`, `policy_version`, `governance_actor`, and
   * `decision_timestamp` columns for index-friendly scans.
   *
   * Legacy traces with NULL governance columns are excluded from facet
   * filters but counted accurately when no filters are supplied — caller
   * controls scope via filter presence.
   */
  queryGovernance(filters: GovernanceTraceQuery = {}): GovernanceTraceQueryResult {
    const normalized = normalizeGovernanceQuery(filters);
    const where: string[] = [];
    const params: Array<string | number> = [];

    if (normalized.decisionId) {
      where.push('routing_decision_id = ?');
      params.push(normalized.decisionId);
    }
    if (normalized.policyVersion) {
      where.push('policy_version = ?');
      params.push(normalized.policyVersion);
    }
    if (normalized.governanceActor) {
      where.push('governance_actor = ?');
      params.push(normalized.governanceActor);
    }
    if (normalized.decisionFrom != null) {
      where.push('decision_timestamp >= ?');
      params.push(Math.floor(normalized.decisionFrom));
    }
    if (normalized.decisionTo != null) {
      where.push('decision_timestamp <= ?');
      params.push(Math.floor(normalized.decisionTo));
    }

    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

    const totalRow = this.db
      .prepare(`SELECT COUNT(*) as cnt FROM execution_traces ${whereSql}`)
      .get(...params) as { cnt: number };

    // Order by persisted decision_timestamp when available, else by trace
    // timestamp, so legacy rows still sort deterministically.
    const rows = this.db
      .prepare(
        `SELECT * FROM execution_traces ${whereSql}
         ORDER BY COALESCE(decision_timestamp, timestamp) DESC, timestamp DESC
         LIMIT ? OFFSET ?`,
      )
      .all(...params, normalized.limit, normalized.offset);

    const traces = rows.map(rowToTrace);
    return {
      rows: traces.map(summarizeGovernanceTrace),
      total: totalRow.cnt,
      limit: normalized.limit,
      offset: normalized.offset,
    };
  }

  /**
   * A8 / T2 — load the full trace whose persisted governance decision id
   * matches `decisionId`. Returns the most recent matching row when the
   * decision id was reused (should not happen, but defensive). Returns
   * undefined when the decision id is unknown.
   */
  findTraceByDecisionId(decisionId: string): ExecutionTrace | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM execution_traces WHERE routing_decision_id = ?
         ORDER BY COALESCE(decision_timestamp, timestamp) DESC, timestamp DESC LIMIT 1`,
      )
      .get(decisionId);
    return row ? rowToTrace(row) : undefined;
  }
}

/** Re-export so callers don't have to import the helper module directly. */
export { GOVERNANCE_QUERY_DEFAULT_LIMIT };

// ── Row → ExecutionTrace deserialization ────────────────────────────────

function rowToTrace(row: any): ExecutionTrace {
  const validated = ExecutionTraceRowSchema.safeParse(row);
  if (!validated.success) {
    console.warn('[vinyan] TraceStore: row failed Zod validation, using fallback', validated.error.message);
  }
  // Brand the agent_id at the read boundary. A malformed legacy row
  // (e.g. uppercase letters from a pre-branded era) deserializes as
  // `undefined` rather than retaining a bare string — A9 bounded
  // degradation, not silent fallback to bare string.
  const agentId = tryAsPersonaId(row.agent_id ?? undefined);
  if (row.agent_id !== null && row.agent_id !== undefined && agentId === undefined) {
    console.warn(`[vinyan] TraceStore: row ${row.id} has invalid agent_id "${row.agent_id}" — dropping field`);
  }
  return {
    id: row.id,
    taskId: row.task_id,
    sessionId: row.session_id ?? undefined,
    workerId: row.worker_id ?? undefined,
    agentId,
    timestamp: row.timestamp,
    routingLevel: row.routing_level,
    taskTypeSignature: row.task_type_signature ?? undefined,
    approach: row.approach,
    approachDescription: row.approach_description ?? undefined,
    riskScore: row.risk_score ?? undefined,
    oracleVerdicts: JSON.parse(row.oracle_verdicts),
    qualityScore:
      row.quality_composite != null
        ? {
            architecturalCompliance: row.quality_arch,
            efficiency: row.quality_efficiency,
            simplificationGain: row.quality_simplification ?? undefined,
            testPresenceHeuristic: row.quality_testmutation ?? undefined,
            composite: row.quality_composite,
            dimensionsAvailable:
              2 + (row.quality_simplification != null ? 1 : 0) + (row.quality_testmutation != null ? 1 : 0),
            phase: (row.quality_simplification != null ? 'extended' : 'basic') as 'basic' | 'extended' | 'full',
          }
        : undefined,
    modelUsed: row.model_used,
    tokensConsumed: row.tokens_consumed,
    durationMs: row.duration_ms,
    outcome: row.outcome,
    failureReason: row.failure_reason ?? undefined,
    affectedFiles: JSON.parse(row.affected_files),
    predictionError: row.prediction_error ? JSON.parse(row.prediction_error) : undefined,
    validationDepth: row.validation_depth ?? undefined,
    shadowValidation: row.shadow_validation ? JSON.parse(row.shadow_validation) : undefined,
    exploration: row.exploration === 1 ? true : undefined,
    frameworkMarkers: row.framework_markers ? JSON.parse(row.framework_markers) : undefined,
    workerSelectionAudit: row.worker_selection_audit ? JSON.parse(row.worker_selection_audit) : undefined,
    pipelineConfidence:
      row.pipeline_confidence_composite != null
        ? { composite: row.pipeline_confidence_composite, formula: '' }
        : undefined,
    confidenceDecision: row.confidence_decision ? JSON.parse(row.confidence_decision) : undefined,
    transcriptGzip: row.transcript_gzip ?? undefined,
    transcriptTurns: row.transcript_turns ?? undefined,
    understandingDepth: row.understanding_depth ?? undefined,
    understandingIntent: row.understanding_intent ?? undefined,
    resolvedEntities: row.resolved_entities ?? undefined,
    understandingVerified: row.understanding_verified ?? undefined,
    understandingPrimaryAction: row.understanding_primary_action ?? undefined,
    agentSelectionReason: row.agent_selection_reason ?? undefined,
    capabilityRequirements: row.capability_requirements ? JSON.parse(row.capability_requirements) : undefined,
    capabilityAnalysis: row.capability_analysis ? JSON.parse(row.capability_analysis) : undefined,
    selectedCapabilityProfileId: row.selected_capability_profile_id ?? undefined,
    selectedCapabilityProfileSource: row.selected_capability_profile_source ?? undefined,
    selectedCapabilityProfileTrustTier: row.selected_capability_profile_trust_tier ?? undefined,
    capabilityFitScore: row.capability_fit_score ?? undefined,
    unmetCapabilityIds: row.unmet_capability_ids ? JSON.parse(row.unmet_capability_ids) : undefined,
    syntheticAgentId: row.synthetic_agent_id ?? undefined,
    knowledgeUsed: row.knowledge_used ? JSON.parse(row.knowledge_used) : undefined,
    governanceProvenance: row.governance_provenance ? JSON.parse(row.governance_provenance) : undefined,
    goalGrounding: row.goal_grounding ? JSON.parse(row.goal_grounding) : undefined,
    oracleIndependence: row.oracle_independence ? JSON.parse(row.oracle_independence) : undefined,
  };
}
