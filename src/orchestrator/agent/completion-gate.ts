/**
 * Completion Gate — Wave 4. Pure rule-based decision function for goal-driven
 * agent-loop termination: when a subprocess worker reports attempt_completion,
 * the orchestrator consults this gate BEFORE accepting the result.
 *
 * A3: decision is a pure function of numeric/enum inputs. No LLM in the
 *     control-flow path. LLM's 'I'm done' claim is an input, not an authority.
 * A7: 'reject' is an honest failure — bounded continuations prevent infinite
 *     agent loops; 'reject' produces a terminal 'uncertain' / 'escalated' state.
 *
 * NOTE — Integration into `agent-loop.ts` is intentionally deferred to a
 * follow-up PR. This module is shippable and unit-tested on its own; wiring
 * requires deep familiarity with the 1300-line agent-loop turn lifecycle.
 */
import type { GoalBlocker } from '../goal-satisfaction/goal-evaluator.ts';

export type CompletionDecision = 'accept' | 'continue' | 'reject';

export interface CompletionGateInputs {
  /** Deterministic goal-satisfaction score (0..1) from the goal evaluator. */
  goalScore: number;
  /** Acceptance threshold — matches goalLoop.goalSatisfactionThreshold (default 0.75). */
  threshold: number;
  /** Number of continuation turns already granted this session. */
  continuationsUsed: number;
  /** Hard ceiling on continuations per session (default 2). */
  maxContinuations: number;
  /** Tokens the negotiable pool can still spend. */
  budgetRemaining: number;
  /** Tokens required to run one more agent-loop turn. */
  continuationCost: number;
  /** Goal-satisfaction blockers. Non-resolvable blockers trigger 'reject'. */
  blockers: GoalBlocker[];
}

export interface CompletionDecisionResult {
  decision: CompletionDecision;
  reason: string;
}

/** Pure rule-based decision — no LLM, no side effects, no surprises. */
export function decideCompletion(inputs: CompletionGateInputs): CompletionDecisionResult {
  if (inputs.goalScore >= inputs.threshold) {
    return { decision: 'accept', reason: `goal score ${inputs.goalScore.toFixed(2)} >= ${inputs.threshold}` };
  }

  if (inputs.continuationsUsed >= inputs.maxContinuations) {
    return {
      decision: 'reject',
      reason: `max continuations reached (${inputs.continuationsUsed}/${inputs.maxContinuations})`,
    };
  }

  if (inputs.budgetRemaining < inputs.continuationCost) {
    return {
      decision: 'reject',
      reason: `insufficient budget (remaining=${inputs.budgetRemaining}, need=${inputs.continuationCost})`,
    };
  }

  // If every blocker is unresolvable, no amount of continuation helps — honest fail.
  if (inputs.blockers.length > 0 && inputs.blockers.every((b) => !b.resolvable)) {
    return {
      decision: 'reject',
      reason: `${inputs.blockers.length} unresolvable blocker(s)`,
    };
  }

  return {
    decision: 'continue',
    reason: `goal score ${inputs.goalScore.toFixed(2)} < ${inputs.threshold}, ${inputs.maxContinuations - inputs.continuationsUsed} continuation(s) remaining`,
  };
}
