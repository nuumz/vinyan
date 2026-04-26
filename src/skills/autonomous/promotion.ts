/**
 * Autonomous-skill promotion rule — deterministic, backtest-aware (A3 + A7).
 *
 * Responsibility: given the governance state of one autonomous skill, decide
 * whether to stay, promote, demote, or retire. Every call is a pure function
 * of its `PromotionRuleInputs`; the `ruleId` embedded in every decision lets
 * the ledger replay exactly which policy version fired.
 *
 * This rule is distinct from `src/skills/hub/promotion-rules.ts`:
 *   - hub rule runs at IMPORT time (promote speculative → probabilistic on
 *     gate+critic approval),
 *   - this rule runs at the STEADY-STATE tier transitions (probation → active
 *     based on backtest evidence; active → demoted on calibration regression).
 */
import type { ConfidenceTier } from '../../core/confidence-tier.ts';

export interface BacktestResult {
  readonly skillId: string;
  readonly replayedTasks: number;
  /** Mean composite-error reduction observed during the backtest replay. */
  readonly actualCompositeErrorReduction: number;
  /** `actualCompositeErrorReduction >= 0.8 * expected_target` from SKILL.md. */
  readonly aboveExpectation: boolean;
}

export interface PromotionRuleInputs {
  readonly currentTier: ConfidenceTier;
  /** How many post-promotion trials have been collected for this skill. */
  readonly probationSamples: number;
  /**
   * Optional backtest comparing the skill's expected vs actual PredictionError
   * reduction. If absent we cannot promote — only stay or (on regression) demote.
   */
  readonly backtest?: BacktestResult;
  /**
   * Composite PredictionError observed on the LATEST window of production
   * runs (post-promotion). Higher than the baseline the skill was promoted at
   * is the regression signal.
   */
  readonly postPromotionError?: number;
  /** Baseline composite error at the time of promotion — used for the 30% regression band. */
  readonly baselineError?: number;
  /** Count of prior demotions for this skill; retire after 3 consecutive. */
  readonly consecutiveDemotions?: number;
}

export interface PromotionDecision {
  readonly kind: 'stay' | 'promote' | 'demote' | 'retire';
  readonly toTier?: ConfidenceTier;
  readonly ruleId: string;
  readonly reason: string;
}

export const AUTONOMOUS_PROMOTE_RULE_ID = 'autonomous-promote-v1';

/** Minimum probation sample count before a skill is eligible for promotion. */
export const AUTONOMOUS_MIN_PROBATION_SAMPLES = 20;
/** Regression factor — 30% worse than baseline triggers a demote. */
export const AUTONOMOUS_REGRESSION_FACTOR = 1.3;
/** Auto-retire after 3 consecutive demotions (A7 signal: skill is unsalvageable). */
export const AUTONOMOUS_RETIRE_AFTER_DEMOTIONS = 3;

/**
 * Decide the next governance step for an autonomous skill.
 *
 * Order of checks (earlier rules short-circuit, so failure reasons are
 * deterministic and easy to replay):
 *
 *   1. Retire chronic failures first: `consecutiveDemotions >= 3` → retire.
 *   2. Never auto-promote to `deterministic` (requires signed manifest or
 *      content-hash binding — A4 + A5).
 *   3. Active-tier regression: post-promotion error > 1.3 × baseline → demote.
 *   4. Probabilistic → heuristic: enough probation samples AND backtest above
 *      expectation AND (if post-promotion error available) no regression.
 *   5. Default: stay.
 */
export function decideAutonomousPromotion(inputs: PromotionRuleInputs): PromotionDecision {
  const { currentTier, probationSamples, backtest, postPromotionError, baselineError } = inputs;
  const consecutiveDemotions = inputs.consecutiveDemotions ?? 0;

  // 1. Retire after sustained failure signal.
  if (consecutiveDemotions >= AUTONOMOUS_RETIRE_AFTER_DEMOTIONS) {
    return {
      kind: 'retire',
      ruleId: AUTONOMOUS_PROMOTE_RULE_ID,
      reason: `consecutive-demotions >= ${AUTONOMOUS_RETIRE_AFTER_DEMOTIONS}`,
    };
  }

  // 2. Block any path to `deterministic` — hard invariant.
  // Falling through to `stay` is the correct safe default; explicit guard
  // documented here so the reader knows WHY we don't promote from heuristic.
  if (currentTier === 'heuristic') {
    // No auto-promote past heuristic. Still permit demotion on regression.
    if (isRegression(postPromotionError, baselineError)) {
      return {
        kind: 'demote',
        toTier: 'probabilistic',
        ruleId: AUTONOMOUS_PROMOTE_RULE_ID,
        reason: `post-promotion error ${postPromotionError} > ${AUTONOMOUS_REGRESSION_FACTOR}×baseline ${baselineError}`,
      };
    }
    return {
      kind: 'stay',
      ruleId: AUTONOMOUS_PROMOTE_RULE_ID,
      reason: 'heuristic-tier holds; no auto-promotion to deterministic',
    };
  }

  // 3. Active-tier regression detection (applies only to probabilistic here;
  //    heuristic handled above).
  if (currentTier === 'probabilistic' && isRegression(postPromotionError, baselineError)) {
    return {
      kind: 'demote',
      toTier: 'speculative',
      ruleId: AUTONOMOUS_PROMOTE_RULE_ID,
      reason: `post-promotion error ${postPromotionError} > ${AUTONOMOUS_REGRESSION_FACTOR}×baseline ${baselineError}`,
    };
  }

  // 4. Promotion path: probabilistic → heuristic.
  if (currentTier === 'probabilistic') {
    const hasEnoughSamples = probationSamples >= AUTONOMOUS_MIN_PROBATION_SAMPLES;
    const backtestOk = backtest != null && backtest.aboveExpectation;
    const noRegression =
      postPromotionError == null ||
      baselineError == null ||
      postPromotionError <= baselineError;

    if (hasEnoughSamples && backtestOk && noRegression) {
      return {
        kind: 'promote',
        toTier: 'heuristic',
        ruleId: AUTONOMOUS_PROMOTE_RULE_ID,
        reason: `probation passed: ${probationSamples} samples, backtest above expectation`,
      };
    }

    return {
      kind: 'stay',
      ruleId: AUTONOMOUS_PROMOTE_RULE_ID,
      reason: buildStayReason(hasEnoughSamples, backtestOk, noRegression),
    };
  }

  // 5. Speculative / deterministic / anything else: no auto-promotion path.
  return {
    kind: 'stay',
    ruleId: AUTONOMOUS_PROMOTE_RULE_ID,
    reason: `tier '${currentTier}' has no auto-promotion path`,
  };
}

function isRegression(postError: number | undefined, baseline: number | undefined): boolean {
  if (postError == null || baseline == null) return false;
  if (baseline <= 0) return postError > 0;
  return postError > AUTONOMOUS_REGRESSION_FACTOR * baseline;
}

function buildStayReason(hasSamples: boolean, backtestOk: boolean, noRegression: boolean): string {
  const missing: string[] = [];
  if (!hasSamples) missing.push('probation-samples');
  if (!backtestOk) missing.push('backtest');
  if (!noRegression) missing.push('regression');
  return missing.length === 0 ? 'stay' : `waiting: ${missing.join(',')}`;
}
