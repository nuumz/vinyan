/**
 * Orchestration Boundaries — extracted A10 goal-grounding boundary.
 *
 * `enforceGoalGroundingBoundary()` is invoked at perceive / spec / plan /
 * generate / verify phase boundaries to apply A10 (goal-grounding) policy:
 * continue, downgrade-confidence, re-ground-context, re-verify-evidence,
 * request-clarification, ask-freshness-question, or abort-unsafe-drift.
 *
 * This module is a verbatim extraction from `core-loop.ts` to reduce that
 * file's size and isolate the boundary contract for focused testing.
 * Behavior, event order, and trace shape are unchanged.
 */
import { emitAuditEntry } from '../core/audit-emit.ts';
import {
  buildGoalGroundingClarificationQuestions,
  buildGoalGroundingProvenance,
  evaluateGoalGrounding,
} from './goal-grounding.ts';
import type { PhaseContext } from './phases/types.ts';
import type {
  ExecutionTrace,
  GoalGroundingPhase,
  RoutingDecision,
  SemanticTaskUnderstanding,
  TaskResult,
} from './types.ts';

export interface GoalGroundingBoundaryResult {
  ctx: PhaseContext;
  result?: TaskResult;
}

export async function enforceGoalGroundingBoundary(
  ctx: PhaseContext,
  phase: GoalGroundingPhase,
  routing: RoutingDecision,
  understanding: SemanticTaskUnderstanding,
  workerSelectionAudit?: import('./types.ts').EngineSelectionResult,
): Promise<GoalGroundingBoundaryResult> {
  const check = evaluateGoalGrounding({
    input: ctx.input,
    understanding,
    routing,
    phase,
    startedAt: ctx.startTime,
    rootGoal: ctx.intentResolution?.originalGoal,
    worldGraph: ctx.deps.worldGraph,
    policy: ctx.deps.goalGroundingPolicy,
  });
  if (!check) return { ctx };

  ctx.deps.bus?.emit('grounding:checked', check);
  // A8: a goal-grounding check is a verdict from the goal-grounding subsystem.
  // pass=true when the check decided to continue without action — any other
  // action (downgrade / re-ground / abort) means the check found drift or
  // stale evidence. The accompanying decision row (below) records the action
  // itself when one fired.
  emitAuditEntry({
    bus: ctx.deps.bus,
    taskId: ctx.input.id,
    policyVersion: check.policyVersion,
    actor: { type: 'orchestrator' },
    variant: {
      kind: 'verdict',
      source: 'goal-grounding',
      pass: check.action === 'continue',
      ...(typeof check.minFactConfidence === 'number' ? { confidence: check.minFactConfidence } : {}),
    },
  });
  const nextCtx = {
    ...ctx,
    goalGroundingChecks: [...(ctx.goalGroundingChecks ?? []), check],
  };

  // Continue / downgrade — let downstream phase apply confidence downgrade.
  if (check.action === 'continue' || check.action === 'downgrade-confidence') {
    return { ctx: nextCtx };
  }

  // Inform observers when the boundary takes an action beyond passive downgrade.
  ctx.deps.bus?.emit('grounding:action_taken', {
    taskId: ctx.input.id,
    action: check.action,
    phase: check.phase,
    reason: check.reason,
  });
  // A8: the action itself is a deterministic governance decision — record it
  // as a decision audit entry alongside the verdict the check produced.
  emitAuditEntry({
    bus: ctx.deps.bus,
    taskId: ctx.input.id,
    policyVersion: check.policyVersion,
    actor: { type: 'orchestrator' },
    variant: {
      kind: 'decision',
      decisionType: 'gate_open',
      verdict: `grounding:${check.action}`,
      rationale: check.reason,
      ruleId: `goal-grounding:${check.phase}`,
      tier: 'deterministic',
    },
  });

  // re-ground-context / re-verify-evidence: lightweight, do not restart the
  // pipeline. Treated as advisory signals — the check is recorded on the
  // trace, but execution continues so the downstream phases can re-run their
  // sub-step (perceive refresh, fact lookup) on their next iteration. Per
  // locked decision: "re-run lightweight context only — do not silently
  // rewrite user intent."
  if (check.action === 're-ground-context' || check.action === 're-verify-evidence') {
    return { ctx: nextCtx };
  }

  // request-clarification, ask-freshness-question, abort-unsafe-drift all
  // record a governance trace; behavior diverges in the returned TaskResult.
  const questions =
    check.action === 'ask-freshness-question'
      ? [
          `A10 grounding detected possible stale evidence during ${check.phase}: ${check.reason}. Should I refresh the evidence before continuing?`,
        ]
      : buildGoalGroundingClarificationQuestions(check);
  const traceApproach = check.action === 'abort-unsafe-drift' ? 'goal-grounding-abort' : 'goal-grounding-clarification';
  const traceOutcome: ExecutionTrace['outcome'] = check.action === 'abort-unsafe-drift' ? 'failure' : 'success';
  const trace: ExecutionTrace = {
    id: `trace-${ctx.input.id}-${traceApproach}`,
    taskId: ctx.input.id,
    sessionId: ctx.input.sessionId,
    workerId: 'orchestrator',
    agentId: ctx.input.agentId,
    timestamp: Date.now(),
    routingLevel: routing.level,
    approach: traceApproach,
    approachDescription: check.reason,
    oracleVerdicts: { 'goal-grounding': false },
    modelUsed: 'orchestrator',
    tokensConsumed: 0,
    durationMs: Date.now() - ctx.startTime,
    outcome: traceOutcome,
    affectedFiles: ctx.input.targetFiles ?? [],
    workerSelectionAudit,
    goalGrounding: nextCtx.goalGroundingChecks,
    governanceProvenance: buildGoalGroundingProvenance(ctx.input, check),
  };
  await ctx.deps.traceCollector.record(trace);
  ctx.deps.bus?.emit('trace:record', { trace });

  // abort-unsafe-drift: terminal fail-closed. Refuse to commit; no clarification.
  if (check.action === 'abort-unsafe-drift') {
    return {
      ctx: nextCtx,
      result: {
        id: ctx.input.id,
        status: 'failed',
        mutations: [],
        trace,
        escalationReason: `goal-grounding aborted: ${check.reason}`,
      },
    };
  }

  const { liftStringsToStructured } = await import('../core/clarification.ts');
  ctx.deps.bus?.emit('agent:clarification_requested', {
    taskId: ctx.input.id,
    sessionId: ctx.input.sessionId,
    questions,
    structuredQuestions: liftStringsToStructured(questions),
    routingLevel: routing.level,
    source: 'orchestrator',
  });

  return {
    ctx: nextCtx,
    result: {
      id: ctx.input.id,
      status: 'input-required',
      mutations: [],
      trace,
      clarificationNeeded: questions,
    },
  };
}
