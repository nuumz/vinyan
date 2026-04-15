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
import type { ExecutionTrace, TaskInput, TaskResult } from '../types.ts';
import { WorkingMemory } from '../working-memory.ts';
import type { GoalEvaluator, GoalSatisfaction } from './goal-evaluator.ts';

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

  let lastResult: TaskResult | undefined;
  let lastSatisfaction: GoalSatisfaction | undefined;
  // Wave 2: replan budget counter. Shared across iterations, bounded by
  // ReplanEngineConfig.tokenSpendCapFraction to prevent unbounded spend.
  let tokensSpentOnReplanning = 0;

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

    deps.bus?.emit('goal-loop:evaluation', {
      taskId: input.id,
      iteration,
      score: satisfaction.score,
      basis: satisfaction.basis,
      passedChecks: satisfaction.passedChecks,
      failedChecks: satisfaction.failedChecks,
    });

    if (satisfaction.score >= cfg.goalSatisfactionThreshold) {
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

    const priorPlanSignatures = workingMemory.getPriorPlanSignatures();
    const outcome = await deps.replanEngine.generateAlternative({
      previousInput: input,
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
  };
  return {
    id: input.id,
    status: 'escalated',
    mutations: [],
    trace,
    escalationReason: `${reason} @ iteration ${iteration}`,
  };
}
