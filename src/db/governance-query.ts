/**
 * Governance trace query + decision-replay helpers (A8 / T2).
 *
 * Read-only adapters over the denormalized governance columns persisted on
 * `execution_traces` (`routing_decision_id`, `policy_version`, `governance_actor`,
 * `decision_timestamp`, `evidence_observed_at`) plus the JSON `governance_provenance`
 * envelope. The contract:
 *
 *   1. Never recompute confidence — only surface persisted values.
 *   2. Legacy rows (no provenance) remain readable; surface them with
 *      `availability: 'unavailable'` instead of dropping them.
 *   3. Keep SQL in the TraceStore; keep formatting and contract types here so
 *      API handlers and CLI surfaces stay thin.
 */

import type {
  ExecutionTrace,
  GoalGroundingCheck,
  GovernanceEvidenceReference,
  GovernanceProvenance,
} from '../orchestrator/types.ts';

export type GovernanceAvailability = 'available' | 'unavailable';

export interface GovernanceTraceQuery {
  decisionId?: string;
  policyVersion?: string;
  governanceActor?: string;
  decisionFrom?: number;
  decisionTo?: number;
  /** Default 50, hard cap 500 (caller may impose its own ceiling first). */
  limit?: number;
  offset?: number;
}

export interface GovernanceTraceSummary {
  traceId: string;
  taskId: string;
  outcome: ExecutionTrace['outcome'];
  routingLevel: number;
  timestamp: number;
  availability: GovernanceAvailability;
  decisionId?: string;
  policyVersion?: string;
  governanceActor?: string;
  wasGeneratedBy?: string;
  decidedAt?: number;
  evidenceObservedAt?: number;
  reason?: string;
  escalationPath?: number[];
  evidenceCount: number;
}

export interface GovernanceTraceQueryResult {
  rows: GovernanceTraceSummary[];
  total: number;
  limit: number;
  offset: number;
}

export interface DecisionReplaySummary {
  decisionId: string;
  availability: GovernanceAvailability;
  traceId: string;
  taskId: string;
  outcome: ExecutionTrace['outcome'];
  routingLevel: number;
  timestamp: number;
  policyVersion?: string;
  attributedTo?: string;
  wasGeneratedBy?: string;
  decidedAt?: number;
  evidenceObservedAt?: number;
  reason?: string;
  escalationPath?: number[];
  evidence: GovernanceEvidenceReference[];
  goalGrounding?: GoalGroundingCheck[];
  /** Persisted only — never recomputed. */
  pipelineConfidence?: { composite: number };
  /** Persisted decision envelope (kept opaque). */
  confidenceDecision?: unknown;
}

export const GOVERNANCE_QUERY_DEFAULT_LIMIT = 50;
export const GOVERNANCE_QUERY_MAX_LIMIT = 500;

/** Normalize incoming filter values: clamp limit, default offset, drop empties. */
export function normalizeGovernanceQuery(input: GovernanceTraceQuery): Required<
  Pick<GovernanceTraceQuery, 'limit' | 'offset'>
> &
  Omit<GovernanceTraceQuery, 'limit' | 'offset'> {
  const limit = clampLimit(input.limit);
  const offset = Math.max(0, Math.floor(input.offset ?? 0));
  return {
    ...input,
    limit,
    offset,
  };
}

function clampLimit(raw: number | undefined): number {
  if (raw == null || !Number.isFinite(raw)) return GOVERNANCE_QUERY_DEFAULT_LIMIT;
  const n = Math.floor(raw);
  if (n <= 0) return GOVERNANCE_QUERY_DEFAULT_LIMIT;
  if (n > GOVERNANCE_QUERY_MAX_LIMIT) return GOVERNANCE_QUERY_MAX_LIMIT;
  return n;
}

/**
 * Build a `GovernanceTraceSummary` from a full `ExecutionTrace`. Used by
 * TraceStore to keep API/CLI handlers free of provenance-unpacking code.
 */
export function summarizeGovernanceTrace(trace: ExecutionTrace): GovernanceTraceSummary {
  const provenance = trace.governanceProvenance;
  const availability: GovernanceAvailability = provenance ? 'available' : 'unavailable';
  return {
    traceId: trace.id,
    taskId: trace.taskId,
    outcome: trace.outcome,
    routingLevel: trace.routingLevel,
    timestamp: trace.timestamp,
    availability,
    decisionId: provenance?.decisionId,
    policyVersion: provenance?.policyVersion,
    governanceActor: provenance?.attributedTo,
    wasGeneratedBy: provenance?.wasGeneratedBy,
    decidedAt: provenance?.decidedAt,
    evidenceObservedAt: provenance?.evidenceObservedAt,
    reason: provenance?.reason,
    escalationPath: provenance?.escalationPath,
    evidenceCount: provenance?.wasDerivedFrom?.length ?? 0,
  };
}

/**
 * Build the canonical decision-replay envelope from a persisted trace.
 *
 * `decisionId` is the caller's input — when the trace exists but lacks
 * provenance (legacy row), `availability: 'unavailable'` and provenance fields
 * are omitted. Confidence is surfaced verbatim from the trace; never recomputed.
 */
export function buildDecisionReplay(decisionId: string, trace: ExecutionTrace): DecisionReplaySummary {
  const provenance: GovernanceProvenance | undefined = trace.governanceProvenance;
  const availability: GovernanceAvailability = provenance ? 'available' : 'unavailable';
  return {
    decisionId,
    availability,
    traceId: trace.id,
    taskId: trace.taskId,
    outcome: trace.outcome,
    routingLevel: trace.routingLevel,
    timestamp: trace.timestamp,
    policyVersion: provenance?.policyVersion,
    attributedTo: provenance?.attributedTo,
    wasGeneratedBy: provenance?.wasGeneratedBy,
    decidedAt: provenance?.decidedAt,
    evidenceObservedAt: provenance?.evidenceObservedAt,
    reason: provenance?.reason,
    escalationPath: provenance?.escalationPath,
    evidence: provenance?.wasDerivedFrom ?? [],
    goalGrounding: trace.goalGrounding,
    pipelineConfidence:
      trace.pipelineConfidence?.composite != null ? { composite: trace.pipelineConfidence.composite } : undefined,
    confidenceDecision: trace.confidenceDecision,
  };
}

/**
 * Render a `DecisionReplaySummary` as human-readable text for the CLI.
 * Stable line ordering — tests assert on substrings, not whole-output equality.
 */
export function formatReplayForCLI(summary: DecisionReplaySummary): string {
  const lines: string[] = [];
  lines.push(`Decision:        ${summary.decisionId}`);
  lines.push(`Availability:    ${summary.availability}`);
  lines.push(`Trace:           ${summary.traceId}`);
  lines.push(`Task:            ${summary.taskId}`);
  lines.push(`Outcome:         ${summary.outcome}`);
  lines.push(`Routing Level:   L${summary.routingLevel}`);
  lines.push(`Timestamp:       ${formatTimestamp(summary.timestamp)}`);

  if (summary.availability === 'unavailable') {
    lines.push('');
    lines.push('  (legacy trace — no governance provenance recorded)');
    return lines.join('\n');
  }

  if (summary.policyVersion) lines.push(`Policy Version:  ${summary.policyVersion}`);
  if (summary.attributedTo) lines.push(`Attributed To:   ${summary.attributedTo}`);
  if (summary.wasGeneratedBy) lines.push(`Generated By:    ${summary.wasGeneratedBy}`);
  if (summary.decidedAt != null) lines.push(`Decided At:      ${formatTimestamp(summary.decidedAt)}`);
  if (summary.evidenceObservedAt != null)
    lines.push(`Evidence Seen:   ${formatTimestamp(summary.evidenceObservedAt)}`);
  if (summary.reason) lines.push(`Reason:          ${summary.reason}`);
  if (summary.escalationPath && summary.escalationPath.length > 0) {
    lines.push(`Escalation:      ${summary.escalationPath.map((l) => `L${l}`).join(' → ')}`);
  }

  if (summary.pipelineConfidence) {
    lines.push(`Confidence:      ${summary.pipelineConfidence.composite.toFixed(3)} (persisted; not recomputed)`);
  }

  if (summary.evidence.length > 0) {
    lines.push('');
    lines.push(`Evidence (${summary.evidence.length}):`);
    for (const ev of summary.evidence) {
      const observed = ev.observedAt != null ? ` @ ${formatTimestamp(ev.observedAt)}` : '';
      const hash = ev.contentHash ? ` [${ev.contentHash.slice(0, 12)}]` : '';
      const summaryText = ev.summary ? ` — ${ev.summary}` : '';
      lines.push(`  - [${ev.kind}] ${ev.source}${hash}${observed}${summaryText}`);
    }
  }

  if (summary.goalGrounding && summary.goalGrounding.length > 0) {
    lines.push('');
    lines.push(`Goal Grounding (${summary.goalGrounding.length}):`);
    for (const gg of summary.goalGrounding) {
      lines.push(`  - phase=${gg.phase} action=${gg.action} drift=${gg.goalDrift} freshnessDowngraded=${gg.freshnessDowngraded}`);
      lines.push(`    reason=${gg.reason}`);
    }
  }

  return lines.join('\n');
}

function formatTimestamp(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return String(ms);
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? String(ms) : d.toISOString();
}
