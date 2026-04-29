/**
 * Goal-Satisfaction Outer Loop — rule-based iteration around executeTask.
 *
 * Wraps a single-attempt executeTask thunk and re-runs it until the goal
 * evaluator reports satisfaction >= threshold, budget is exhausted, or
 * max iterations is reached.
 *
 * A3: governance is rule-based. No LLM in this file.
 * A7: each iteration's outcome flows into the next via WorkingMemory.
 */
import type { OracleVerdict } from '../../core/types.ts';
import type { OrchestratorDeps } from '../core-loop.ts';
import { buildShortCircuitProvenance } from '../governance-provenance.ts';
import type { ExecutionTrace, TaskInput, TaskResult } from '../types.ts';
import { WorkingMemory } from '../working-memory.ts';
import { type GoalSatisfaction, GoalTrajectoryTracker } from './goal-evaluator.ts';

export interface GoalLoopConfig {
  maxOuterIterations: number;
  goalSatisfactionThreshold: number;
}

export const DEFAULT_GOAL_LOOP_CONFIG: GoalLoopConfig = {
  maxOuterIterations: 3,
  goalSatisfactionThreshold: 0.75,
};

export type ExecuteAttempt = (input: TaskInput, wm: WorkingMemory) => Promise<TaskResult>;

export async function executeWithGoalLoop(
  input: TaskInput,
  deps: OrchestratorDeps,
  executeAttempt: ExecuteAttempt,
  cfg: GoalLoopConfig,
): Promise<TaskResult> {
  const evaluator = deps.goalEvaluator;
  if (!evaluator) {
    // No evaluator → degrade to single attempt. A3: rule-based fallback.
    const wm = new WorkingMemory({ bus: deps.bus, taskId: input.id });
    return executeAttempt(input, wm);
  }

  const workingMemory = new WorkingMemory({ bus: deps.bus, taskId: input.id });
  const trajectoryTracker = new GoalTrajectoryTracker();

  let lastResult: TaskResult | undefined;
  let lastSatisfaction: GoalSatisfaction | undefined;
  // Wave B: track last plan for deterministic DAG transforms in replan engine
  let lastPlan: import('../types.ts').TaskDAG | undefined;
  // Wave 2: replan budget counter. Shared across iterations, bounded by
  // ReplanEngineConfig.tokenSpendCapFraction to prevent unbounded spend.
  let tokensSpentOnReplanning = 0;

  // Wave B: retrieve seed decomposition shape for first iteration (A7 learning → action)
  if (deps.decompositionLearner) {
    try {
      const { computeTaskSignature } = await import('../prediction/self-model.ts');
      const taskSig = computeTaskSignature(input);
      const seed = deps.decompositionLearner.retrieveSeedShape(taskSig);
      if (seed && seed.nodes.length > 0) {
        const seedDesc = seed.nodes.map((n) => `${n.id}: ${n.description} [${n.assignedOracles.join(',')}]`).join(' → ');
        input = {
          ...input,
          goal: `${input.goal}\n\n[SEED DECOMPOSITION] A prior winning plan shape for similar tasks: ${seedDesc}. Consider reusing this structure.`,
        };
      }
    } catch {
      // Best-effort — seed retrieval is optional
    }
  }

  for (let iteration = 1; iteration <= cfg.maxOuterIterations; iteration++) {
    // ── Budget guard (before every iteration) ──────────────────────
    if (deps.budgetEnforcer) {
      const budgetCheck = deps.budgetEnforcer.canProceed();
      if (!budgetCheck.allowed) {
        deps.bus?.emit('goal-loop:budget-exhausted', { taskId: input.id, iteration });
        if (lastResult) {
          return annotate(lastResult, {
            status: 'escalated',
            reason: 'goal-loop budget exhausted',
            iteration,
            satisfaction: lastSatisfaction,
          });
        }
        return buildEscalationResult(input, 'goal-loop budget exhausted', iteration);
      }
    }

    deps.bus?.emit('goal-loop:iteration-start', { taskId: input.id, iteration });

    const result = await executeAttempt(input, workingMemory);
    lastResult = result;

    // Wave B fix: surface plan from executeTaskCore for deterministic replan + decomposition learning
    if (result.plan) {
      lastPlan = result.plan;
    }

    // Terminal-but-not-completed results short-circuit — no evaluation.
    if (result.status !== 'completed') {
      deps.bus?.emit('goal-loop:terminal', {
        taskId: input.id,
        iteration,
        status: result.status,
      });
      return result;
    }

    // ── Evaluate goal satisfaction ─────────────────────────────────
    const oracleVerdicts = collectVerdicts(result);
    const satisfaction = await evaluator.evaluate({
      input,
      result,
      oracleVerdicts,
      workingMemory,
    });
    lastSatisfaction = satisfaction;

    // Wave B: record trajectory and attach to satisfaction
    const trajectoryPoint = trajectoryTracker.record(iteration, satisfaction.score);
    satisfaction.trajectory = trajectoryPoint;

    deps.bus?.emit('goal-loop:evaluation', {
      taskId: input.id,
      iteration,
      score: satisfaction.score,
      basis: satisfaction.basis,
      passedChecks: satisfaction.passedChecks,
      failedChecks: satisfaction.failedChecks,
      accountabilityGrade: satisfaction.accountabilityGrade,
    });

    // Slice 4 Gap B (A7): surface prediction error as a separate signal so
    // dashboards and the calibration ledger can track it without coupling to
    // the main evaluation event payload. We only emit when the agent actually
    // self-graded (predictionError populated).
    if (satisfaction.predictionError) {
      deps.bus?.emit('goal-loop:prediction-error', {
        taskId: input.id,
        iteration,
        selfGrade: satisfaction.predictionError.selfGrade,
        deterministicGrade: satisfaction.predictionError.deterministicGrade,
        magnitude: satisfaction.predictionError.magnitude,
        direction: satisfaction.predictionError.direction,
      });
      // Slice 4 follow-up: persist so the next iteration's critic prompt
      // can warn against repeating an overconfident self-assessment.
      workingMemory.recordPredictionError(satisfaction.predictionError);
    }

    // Slice 4: persist the deterministic grade + blocker categories so the
    // NEXT iteration's critic prompt can render a [PRIOR ITERATION RESULT]
    // block. We only carry the most recent verdict — failed-approaches
    // already records prose history.
    if (satisfaction.accountabilityGrade) {
      const categories = satisfaction.blockers.map((b) => b.category);
      workingMemory.recordAccountabilityResult(satisfaction.accountabilityGrade, categories);
    }

    // Accountability gate: even if numeric score passes, a Grade C result has a
    // critical flaw (unresolvable blocker / oracle contradiction / score < 0.5)
    // and MUST NOT be reported as done. Force escalation so the replan engine
    // (or human) can intervene.
    const blockedByGrade =
      satisfaction.score >= cfg.goalSatisfactionThreshold &&
      satisfaction.accountabilityGrade === 'C';
    if (blockedByGrade) {
      deps.bus?.emit('goal-loop:accountability-block', {
        taskId: input.id,
        iteration,
        score: satisfaction.score,
        blockers: satisfaction.blockers,
      });
    }

    if (!blockedByGrade && satisfaction.score >= cfg.goalSatisfactionThreshold) {
      // Wave B: record winning decomposition for future seed retrieval (A7 loop closure)
      if (deps.decompositionLearner && lastPlan && lastPlan.nodes.length > 0) {
        const taskSig = result.trace?.taskTypeSignature ?? input.id;
        const traceId = result.trace?.id ?? input.id;
        try {
          deps.decompositionLearner.recordWinningDecomposition(taskSig, lastPlan, traceId);
        } catch {
          // Best-effort — migration may not have run
        }
      }
      return result;
    }

    // ── Goal not met ───────────────────────────────────────────────
    if (iteration >= cfg.maxOuterIterations) {
      deps.bus?.emit('goal-loop:exhausted', { taskId: input.id, iteration });
      return annotate(result, {
        status: 'escalated',
        reason: `goal not met after ${iteration} iteration(s), score ${satisfaction.score.toFixed(2)} < ${cfg.goalSatisfactionThreshold}`,
        iteration,
        satisfaction,
      });
    }

    // ── Wave B: Negative momentum → escalate (save budget) ───────
    if (trajectoryTracker.isNegativeMomentum(2)) {
      deps.bus?.emit('goal-loop:negative-momentum', {
        taskId: input.id,
        iteration,
        trajectory: trajectoryTracker.getTrajectory(),
      });
      return annotate(result, {
        status: 'escalated',
        reason: 'negative momentum: scores declining for 2+ iterations',
        iteration,
        satisfaction,
      });
    }

    // ── Wave 2: Replan Engine (optional) ──────────────────────────
    if (!deps.replanEngine || !deps.replanConfig?.enabled) {
      // No replan engine → honest escalation (A7). Load-bearing test string.
      deps.bus?.emit('goal-loop:no-replan', { taskId: input.id, iteration });
      return annotate(result, {
        status: 'escalated',
        reason: 'goal not met, replan not available',
        iteration,
        satisfaction,
      });
    }

    // Wave 2 fix: on the first iteration, synthesize a failed-approach
    // entry from the initial attempt's trace so the replan engine's
    // trigram similarity gate has something to compare against. Without
    // this, the first replan's "novelty" check would have no signal
    // (workingMemory.failedApproaches is empty until something is
    // explicitly recorded — goal-eval shortfall alone doesn't add entries).
    if (iteration === 1) {
      const initialApproach = synthesizeInitialApproachText(result);
      workingMemory.recordFailedApproach(
        initialApproach,
        satisfaction.failedChecks.length > 0
          ? `goal-eval failed: ${satisfaction.failedChecks.join(', ')}`
          : `goal-eval below threshold (${satisfaction.score.toFixed(2)})`,
      );
    }

    const priorPlanSignatures = workingMemory.getPriorPlanSignatures();
    const outcome = await deps.replanEngine.generateAlternative({
      previousInput: input,
      previousPlan: lastPlan,
      previousResult: result,
      failedApproaches: workingMemory.getSnapshot().failedApproaches,
      goalSatisfaction: satisfaction,
      iteration,
      priorPlanSignatures,
      tokensSpentOnReplanning,
      remainingTaskBudgetTokens: Math.max(1, input.budget.maxTokens - tokensSpentOnReplanning),
    });

    if (!outcome) {
      deps.bus?.emit('goal-loop:replan-exhausted', { taskId: input.id, iteration });
      return annotate(result, {
        status: 'escalated',
        reason: 'replan exhausted (no novel plan)',
        iteration,
        satisfaction,
      });
    }

    workingMemory.recordPlanSignature(outcome.planSignature);
    tokensSpentOnReplanning += outcome.tokensUsed;
    lastPlan = outcome.plan;
    input = outcome.input;
    // fall through to next iteration with updated input + preserved workingMemory
  }

  // Unreachable under normal logic — defensive fallback.
  if (lastResult) return lastResult;
  return buildEscalationResult(input, 'goal-loop completed with no result', cfg.maxOuterIterations);
}

function collectVerdicts(result: TaskResult): OracleVerdict[] {
  const out: OracleVerdict[] = [];
  for (const m of result.mutations) {
    for (const v of Object.values(m.oracleVerdicts)) out.push(v);
  }
  return out;
}

function annotate(
  result: TaskResult,
  info: { status: TaskResult['status']; reason: string; iteration: number; satisfaction?: GoalSatisfaction },
): TaskResult {
  const escalationReason = info.satisfaction
    ? `${info.reason} (score=${info.satisfaction.score.toFixed(2)}, failed=[${info.satisfaction.failedChecks.join(',')}])`
    : info.reason;
  const notes = [
    ...(result.notes ?? []),
    `goal-loop: ${info.reason} @ iteration ${info.iteration}`,
  ];
  return { ...result, status: info.status, escalationReason, notes };
}

/**
 * Wave 2 fix: synthesize a short approach description from a completed
 * (but goal-failing) TaskResult so the replan engine's trigram gate has
 * something to compare against on the first replan iteration.
 */
function synthesizeInitialApproachText(result: TaskResult): string {
  const parts: string[] = [];
  if (result.trace?.approach && result.trace.approach !== 'initial-attempt') {
    parts.push(result.trace.approach);
  }
  for (const m of result.mutations) {
    parts.push(`edit ${m.file}`);
  }
  if (result.answer) {
    const snippet = result.answer.length > 100 ? `${result.answer.slice(0, 100)}...` : result.answer;
    parts.push(`answer: ${snippet}`);
  }
  return parts.join(' | ') || 'initial-attempt';
}

function buildEscalationResult(input: TaskInput, reason: string, iteration: number): TaskResult {
  const trace: ExecutionTrace = {
    id: `trace-${input.id}-goal-loop-escalate`,
    taskId: input.id,
    timestamp: Date.now(),
    routingLevel: 0,
    approach: 'goal-loop-escalate',
    oracleVerdicts: {},
    modelUsed: 'none',
    tokensConsumed: 0,
    durationMs: 0,
    outcome: 'escalated',
    failureReason: reason,
    affectedFiles: input.targetFiles ?? [],
    governanceProvenance: buildShortCircuitProvenance({
      input,
      decisionId: 'goal-loop-escalate',
      attributedTo: 'goalLoop',
      wasGeneratedBy: 'executeWithGoalLoop',
      reason,
    }),
  };
  return {
    id: input.id,
    status: 'escalated',
    mutations: [],
    trace,
    escalationReason: `${reason} @ iteration ${iteration}`,
  };
}
