/**
 * Autonomous promotion-rule tests (W4 SK4).
 *
 * Every transition is a pure function of the inputs; every decision embeds
 * `ruleId='autonomous-promote-v1'` so ledger replay is deterministic.
 */
import { describe, expect, test } from 'bun:test';
import {
  AUTONOMOUS_MIN_PROBATION_SAMPLES,
  AUTONOMOUS_PROMOTE_RULE_ID,
  AUTONOMOUS_REGRESSION_FACTOR,
  AUTONOMOUS_RETIRE_AFTER_DEMOTIONS,
  decideAutonomousPromotion,
  type BacktestResult,
} from '../../../src/skills/autonomous/index.ts';

const okBacktest: BacktestResult = {
  skillId: 'auto/extract-method',
  replayedTasks: 20,
  actualCompositeErrorReduction: 0.3,
  aboveExpectation: true,
};

describe('decideAutonomousPromotion', () => {
  test('stay for fresh probabilistic with no backtest', () => {
    const decision = decideAutonomousPromotion({
      currentTier: 'probabilistic',
      probationSamples: 3,
    });
    expect(decision.kind).toBe('stay');
    expect(decision.ruleId).toBe(AUTONOMOUS_PROMOTE_RULE_ID);
    expect(decision.reason).toContain('probation-samples');
  });

  test('promote probabilistic → heuristic with enough samples + passing backtest', () => {
    const decision = decideAutonomousPromotion({
      currentTier: 'probabilistic',
      probationSamples: AUTONOMOUS_MIN_PROBATION_SAMPLES,
      backtest: okBacktest,
    });
    expect(decision.kind).toBe('promote');
    expect(decision.toTier).toBe('heuristic');
    expect(decision.ruleId).toBe(AUTONOMOUS_PROMOTE_RULE_ID);
  });

  test('stay when probation samples are enough but backtest did not pass', () => {
    const decision = decideAutonomousPromotion({
      currentTier: 'probabilistic',
      probationSamples: 25,
      backtest: { ...okBacktest, aboveExpectation: false },
    });
    expect(decision.kind).toBe('stay');
    expect(decision.reason).toContain('backtest');
  });

  test('stay when backtest passes but probation sample count is too small', () => {
    const decision = decideAutonomousPromotion({
      currentTier: 'probabilistic',
      probationSamples: 5,
      backtest: okBacktest,
    });
    expect(decision.kind).toBe('stay');
    expect(decision.reason).toContain('probation-samples');
  });

  test('demote probabilistic → speculative on post-promotion regression', () => {
    const decision = decideAutonomousPromotion({
      currentTier: 'probabilistic',
      probationSamples: 25,
      backtest: okBacktest,
      baselineError: 0.2,
      // 0.2 * 1.3 = 0.26 — so 0.4 triggers regression.
      postPromotionError: 0.4,
    });
    expect(decision.kind).toBe('demote');
    expect(decision.toTier).toBe('speculative');
  });

  test('demote heuristic → probabilistic on post-promotion regression', () => {
    const decision = decideAutonomousPromotion({
      currentTier: 'heuristic',
      probationSamples: 100,
      baselineError: 0.1,
      postPromotionError: 0.2, // > 1.3 × 0.1
    });
    expect(decision.kind).toBe('demote');
    expect(decision.toTier).toBe('probabilistic');
  });

  test('never auto-promote to deterministic — heuristic stays heuristic by default', () => {
    const decision = decideAutonomousPromotion({
      currentTier: 'heuristic',
      probationSamples: 1000,
      backtest: okBacktest,
      baselineError: 0.1,
      postPromotionError: 0.05,
    });
    expect(decision.kind).toBe('stay');
    expect(decision.toTier).toBeUndefined();
  });

  test('retire after 3 consecutive demotions', () => {
    const decision = decideAutonomousPromotion({
      currentTier: 'probabilistic',
      probationSamples: 25,
      backtest: okBacktest,
      consecutiveDemotions: AUTONOMOUS_RETIRE_AFTER_DEMOTIONS,
    });
    expect(decision.kind).toBe('retire');
    expect(decision.ruleId).toBe(AUTONOMOUS_PROMOTE_RULE_ID);
  });

  test('rule id present on every decision kind', () => {
    const kinds = [
      decideAutonomousPromotion({ currentTier: 'probabilistic', probationSamples: 0 }),
      decideAutonomousPromotion({
        currentTier: 'probabilistic',
        probationSamples: 25,
        backtest: okBacktest,
      }),
      decideAutonomousPromotion({
        currentTier: 'probabilistic',
        probationSamples: 25,
        baselineError: 0.1,
        postPromotionError: 0.5,
      }),
      decideAutonomousPromotion({
        currentTier: 'probabilistic',
        probationSamples: 25,
        consecutiveDemotions: 3,
      }),
    ];
    for (const d of kinds) {
      expect(d.ruleId).toBe(AUTONOMOUS_PROMOTE_RULE_ID);
    }
  });

  test('speculative tier has no auto-promotion path (stays speculative)', () => {
    const decision = decideAutonomousPromotion({
      currentTier: 'speculative',
      probationSamples: 100,
      backtest: okBacktest,
    });
    expect(decision.kind).toBe('stay');
    expect(decision.toTier).toBeUndefined();
  });

  test('demote trigger is exactly 1.3× baseline (boundary test)', () => {
    // 0.1 * 1.3 = 0.13. At-or-below the band does NOT demote (strict >);
    // slightly over → demote. Promotion path separately requires
    // postPromotionError <= baselineError, so the "at band" case is stay,
    // not promote.
    const onBoundary = decideAutonomousPromotion({
      currentTier: 'probabilistic',
      probationSamples: 25,
      backtest: okBacktest,
      baselineError: 0.1,
      postPromotionError: 0.1 * AUTONOMOUS_REGRESSION_FACTOR,
    });
    expect(onBoundary.kind).toBe('stay');

    const justOver = decideAutonomousPromotion({
      currentTier: 'probabilistic',
      probationSamples: 25,
      backtest: okBacktest,
      baselineError: 0.1,
      postPromotionError: 0.1 * AUTONOMOUS_REGRESSION_FACTOR + 0.001,
    });
    expect(justOver.kind).toBe('demote');
  });

  test('missing backtest blocks promotion (cannot verify expectation)', () => {
    const decision = decideAutonomousPromotion({
      currentTier: 'probabilistic',
      probationSamples: 50,
    });
    expect(decision.kind).toBe('stay');
  });
});
