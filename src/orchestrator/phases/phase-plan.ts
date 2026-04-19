/**
 * Plan Phase — Step 3 of the Orchestrator lifecycle.
 *
 * Decomposes the task into a DAG (L2+ only), scores plan nodes by
 * causal risk, predicts cost, and checks the approval gate.
 */

import type { OutcomePrediction } from '../forward-predictor-types.ts';
import type {
  ExecutionTrace,
  PerceptualHierarchy,
  RoutingDecision,
  SemanticTaskUnderstanding,
  TaskInput,
  TaskResult,
} from '../types.ts';
import type { PhaseContext, PhaseContinue, PhaseReturn, PlanResult } from './types.ts';
import { Phase } from './types.ts';

export async function executePlanPhase(
  ctx: PhaseContext,
  routing: RoutingDecision,
  perception: PerceptualHierarchy,
  understanding: SemanticTaskUnderstanding,
  forwardPrediction: OutcomePrediction | undefined,
): Promise<PhaseContinue<PlanResult> | PhaseReturn> {
  const { input, deps, startTime, workingMemory } = ctx;

  // ── Step 3: PLAN (L2+ only) ──────────────────────────────────
  let plan: PlanResult['plan'];
  if (routing.level >= 2) {
    plan = await deps.decomposer.decompose(input, perception, workingMemory.getSnapshot(), routing);
    if (plan.isFallback) {
      deps.bus?.emit('decomposer:fallback', { taskId: input.id });
    }
    // UI surface: emit a plan snapshot so chat clients can render a
    // Claude Code-style "session setup" checklist. Skip fallback DAGs
    // because they contain a single node that just echoes the user's
    // request — rendering that as a checklist is noise, not signal.
    // Observational only — never used for routing decisions.
    if (plan && !plan.isFallback && plan.nodes.length > 1) {
      deps.bus?.emit('agent:plan_update', {
        taskId: input.id,
        steps: plan.nodes.map((n) => ({
          id: n.id,
          label: n.description,
          status: 'pending' as const,
        })),
      });
    }
  }

  // Wave 5.2 (Phase A §7 seam #2 closure): if the decomposer emitted a
  // preamble on the DAG, merge it into a CLONED TaskInput and return
  // that clone on `enhancedInput`. The core-loop swaps `ctx.input` for
  // the enhanced version on subsequent phases so downstream worker
  // dispatch and prompt assembly see the merged constraints. The
  // caller's original input is never mutated.
  //
  // Deep-audit #1 (2026-04-15): dedupe via Set to handle the retry
  // path correctly. On routing-loop iteration N, `ctx.input` already
  // carries the preamble from iteration N-1 (because core-loop swaps
  // ctx.input → enhancedInput after plan phase). Without dedupe, the
  // preamble would be appended again on every retry, accumulating
  // linearly. Set preserves insertion order (ES2015 spec), so the
  // original user constraints still come first.
  let enhancedInput: TaskInput | undefined;
  if (plan?.preamble && plan.preamble.length > 0) {
    const existing = input.constraints ?? [];
    const existingSet = new Set(existing);
    const toAdd = plan.preamble.filter((c) => !existingSet.has(c));
    if (toAdd.length > 0) {
      enhancedInput = {
        ...input,
        constraints: [...existing, ...toAdd],
      };
    }
    // When `toAdd.length === 0` the preamble is already fully present
    // — retry case — and we leave `enhancedInput` undefined so
    // core-loop doesn't do a pointless ctx swap.
  }

  // C2: Score plan nodes by causal risk → reorder for fail-fast
  if (plan && forwardPrediction) {
    scorePlanByPrediction(plan, forwardPrediction);
  }

  // Economy L2: Predict cost before dispatch (informational + feeds calibration)
  if (deps.costPredictor) {
    const taskSig = (understanding.taskTypeSignature as string | undefined) ?? 'unknown';
    const costPrediction = deps.costPredictor.predict(taskSig, routing.level);
    deps.bus?.emit('economy:cost_predicted', {
      taskId: input.id,
      predicted_usd: costPrediction.predicted_usd,
      confidence: costPrediction.confidence,
      basis: costPrediction.basis,
    });
  }

  // ── Step 3.5: APPROVAL GATE (A6 — human-in-the-loop for high-risk tasks) ──
  if (deps.approvalGate && routing.riskScore != null && routing.riskScore >= 0.8) {
    const decision = await deps.approvalGate.requestApproval(
      input.id,
      routing.riskScore,
      `High risk (${routing.riskScore.toFixed(2)}) at L${routing.level}`,
    );
    if (decision === 'rejected') {
      const rejectedTrace: ExecutionTrace = {
        id: `trace-${input.id}-rejected`,
        taskId: input.id,
        timestamp: Date.now(),
        routingLevel: routing.level,
        approach: 'rejected-by-human',
        oracleVerdicts: {},
        modelUsed: routing.model ?? 'none',
        tokensConsumed: 0,
        durationMs: Date.now() - startTime,
        outcome: 'failure',
        failureReason: 'Rejected by human approval gate',
        affectedFiles: input.targetFiles ?? [],
      };
      return Phase.return({
        id: input.id,
        status: 'failed',
        mutations: [],
        trace: rejectedTrace,
        escalationReason: 'Rejected by human approval gate',
      });
    }
  }

  return Phase.continue({
    plan,
    ...(enhancedInput ? { enhancedInput } : {}),
  });
}

/** Score plan nodes by ForwardPredictor causal risk → reorder for fail-fast. */
export function scorePlanByPrediction(plan: import('../types.ts').TaskDAG, forwardPrediction: OutcomePrediction): void {
  if (!forwardPrediction.causalRiskFiles.length) return;
  for (const node of plan.nodes) {
    const matchingRisks = forwardPrediction.causalRiskFiles.filter((r) => node.targetFiles.includes(r.filePath));
    node.riskScore = matchingRisks.reduce((sum, r) => sum + r.breakProbability, 0);
  }
  plan.nodes.sort((a, b) => (b.riskScore ?? 0) - (a.riskScore ?? 0));
}
