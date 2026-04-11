/**
 * Plan Phase — Step 3 of the Orchestrator lifecycle.
 *
 * Decomposes the task into a DAG (L2+ only), scores plan nodes by
 * causal risk, predicts cost, and checks the approval gate.
 */

import type {
  ExecutionTrace,
  PerceptualHierarchy,
  RoutingDecision,
  SemanticTaskUnderstanding,
  TaskResult,
} from '../types.ts';
import type { OutcomePrediction } from '../forward-predictor-types.ts';
import type { PhaseContext, PlanResult, PhaseContinue, PhaseReturn } from './types.ts';
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
    plan = await deps.decomposer.decompose(input, perception, workingMemory.getSnapshot());
    if (plan.isFallback) {
      deps.bus?.emit('decomposer:fallback', { taskId: input.id });
    }
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

  return Phase.continue({ plan });
}

/** Score plan nodes by ForwardPredictor causal risk → reorder for fail-fast. */
export function scorePlanByPrediction(
  plan: import('../types.ts').TaskDAG,
  forwardPrediction: OutcomePrediction,
): void {
  if (!forwardPrediction.causalRiskFiles.length) return;
  for (const node of plan.nodes) {
    const matchingRisks = forwardPrediction.causalRiskFiles.filter((r) => node.targetFiles.includes(r.filePath));
    node.riskScore = matchingRisks.reduce((sum, r) => sum + r.breakProbability, 0);
  }
  plan.nodes.sort((a, b) => (b.riskScore ?? 0) - (a.riskScore ?? 0));
}
