/**
 * HTTP handler — GET /api/routing/:taskId/explain
 *
 * Library function: returns `{ status, body }`. Factory wiring into the real
 * Bun HTTP server is a follow-up (W4 scope: produce the handler, prove it
 * works against seeded stores; server integration joins this into the
 * router in a later PR).
 *
 * A3 compliance: the explanation is produced by `explainRouting` — pure,
 * rule-based, no LLM in the explanation path. Idempotent.
 */

import type { OracleVerdict, QualityScore } from '../core/types.ts';
import { explainRouting, type RoutingExplanation } from '../gate/routing-explainer.ts';
import type { RiskFactors, RoutingDecision } from '../orchestrator/types.ts';

// ── Provider shapes ───────────────────────────────────────────────

/**
 * Minimum info the endpoint needs about a task's routing decision.
 * The server wiring PR can thread this through a real store; for now
 * we keep the contract narrow so both tests and the future adapter
 * can satisfy it without pulling TraceStore.
 */
export interface RoutingRecord {
  readonly taskId: string;
  readonly decision: RoutingDecision;
  readonly factors: RiskFactors;
  readonly verdicts?: readonly OracleVerdict[];
}

export interface RoutingTraceProvider {
  /** Look up the routing record by task id. Return null when not found. */
  getRoutingRecord(taskId: string): RoutingRecord | null | Promise<RoutingRecord | null>;
}

/**
 * Optional provider that returns the actual oracle verdicts for a task.
 * If omitted or returns null, the explanation is produced from the routing
 * decision alone (A2: confidenceSource falls back to 'unknown').
 */
export interface OracleVerdictProvider {
  getVerdictsForTask(taskId: string): readonly OracleVerdict[] | null | Promise<readonly OracleVerdict[] | null>;
}

export interface RoutingExplainEndpointDeps {
  readonly traceStore: RoutingTraceProvider;
  readonly oracleAccuracyStore?: OracleVerdictProvider;
}

// ── Response shape ───────────────────────────────────────────────

export type RoutingExplainResponse =
  | { status: 200; body: RoutingExplanation }
  | { status: 404; body: { error: string } };

// ── Handler ─────────────────────────────────────────────────────

export async function handleRoutingExplain(
  req: { taskId: string },
  deps: RoutingExplainEndpointDeps,
): Promise<RoutingExplainResponse> {
  if (!req.taskId || req.taskId.length === 0) {
    return { status: 404, body: { error: 'taskId is required' } };
  }

  const record = await deps.traceStore.getRoutingRecord(req.taskId);
  if (!record) {
    return {
      status: 404,
      body: { error: `No routing record found for taskId=${req.taskId}` },
    };
  }

  // Prefer explicit verdicts on the record; fall back to the optional
  // accuracy-store provider. Either source is valid — verdicts are
  // evidence, and explainRouting rejects nothing.
  let verdicts = record.verdicts;
  if ((!verdicts || verdicts.length === 0) && deps.oracleAccuracyStore) {
    const fromStore = await deps.oracleAccuracyStore.getVerdictsForTask(req.taskId);
    if (fromStore && fromStore.length > 0) {
      verdicts = fromStore;
    }
  }

  const explanation = explainRouting({
    taskId: record.taskId,
    decision: record.decision,
    factors: record.factors,
    ...(verdicts ? { verdicts } : {}),
  });

  return { status: 200, body: explanation };
}

// Re-export helper for tests that want to hand-craft a QualityScore without
// pulling core types directly (kept as a convenience type alias only).
export type { QualityScore };
