/**
 * Adaptive thinking budget tests — G5 interior LLM control.
 */
import { describe, expect, test } from 'bun:test';
import {
  applyAdaptiveThinkingBudget,
  computeAdaptiveMultiplier,
} from '../../../src/orchestrator/llm/adaptive-thinking.ts';
import type { ThinkingConfig } from '../../../src/orchestrator/types.ts';

describe('computeAdaptiveMultiplier', () => {
  test('baseline (no signals) → multiplier 1.0', () => {
    expect(computeAdaptiveMultiplier({})).toBe(1.0);
  });

  test('many type errors → multiplier ≥ 1.3', () => {
    expect(computeAdaptiveMultiplier({ typeErrorCount: 10 })).toBeCloseTo(1.3, 5);
  });

  test('a few type errors → multiplier 1.1', () => {
    expect(computeAdaptiveMultiplier({ typeErrorCount: 2 })).toBeCloseTo(1.1, 5);
  });

  test('large blast radius → multiplier ≥ 1.3', () => {
    expect(computeAdaptiveMultiplier({ blastRadius: 25 })).toBeCloseTo(1.3, 5);
  });

  test('low test coverage → multiplier ≥ 1.2', () => {
    expect(computeAdaptiveMultiplier({ testCoverage: 0.1 })).toBeCloseTo(1.2, 5);
  });

  test('low tier reliability → multiplier ≥ 1.2', () => {
    expect(computeAdaptiveMultiplier({ avgTierReliability: 0.3 })).toBeCloseTo(1.2, 5);
  });

  test('read-only task → multiplier 0.8 (less thinking needed)', () => {
    expect(computeAdaptiveMultiplier({ isMutation: false })).toBeCloseTo(0.8, 5);
  });

  test('signals stack additively', () => {
    // 1.0 + 0.3 (typeErrors) + 0.3 (blast) + 0.2 (coverage) + 0.2 (reliability) = 2.0
    const m = computeAdaptiveMultiplier({
      typeErrorCount: 8,
      blastRadius: 25,
      testCoverage: 0.1,
      avgTierReliability: 0.3,
    });
    expect(m).toBeCloseTo(2.0, 5);
  });

  test('clamped to maxMultiplier', () => {
    // Without clamp, this would exceed 2.0 — the default max.
    const m = computeAdaptiveMultiplier({
      typeErrorCount: 10,
      blastRadius: 25,
      testCoverage: 0.1,
      avgTierReliability: 0.3,
    });
    expect(m).toBeLessThanOrEqual(2.0);
  });

  test('clamped to minMultiplier', () => {
    // isMutation=false subtracts 0.2, no positive signals → 0.8.
    // With strong override testing min clamp:
    const m = computeAdaptiveMultiplier({ isMutation: false }, { minMultiplier: 0.9 });
    expect(m).toBe(0.9);
  });

  test('respects custom min/max bounds', () => {
    const m = computeAdaptiveMultiplier(
      { typeErrorCount: 10, blastRadius: 25 },
      { minMultiplier: 0.5, maxMultiplier: 1.2 },
    );
    expect(m).toBe(1.2);
  });
});

describe('applyAdaptiveThinkingBudget', () => {
  test('multiplier 1.0 returns config unchanged (identity short-circuit)', () => {
    const cfg: ThinkingConfig = { type: 'enabled', budgetTokens: 10000 };
    expect(applyAdaptiveThinkingBudget(cfg, 1)).toBe(cfg);
  });

  test('enabled config: budget multiplied + rounded', () => {
    const cfg: ThinkingConfig = { type: 'enabled', budgetTokens: 10000 };
    const result = applyAdaptiveThinkingBudget(cfg, 1.5);
    expect(result.type).toBe('enabled');
    expect((result as { budgetTokens: number }).budgetTokens).toBe(15000);
  });

  test('enabled config: shrinks on multiplier < 1', () => {
    const cfg: ThinkingConfig = { type: 'enabled', budgetTokens: 10000 };
    const result = applyAdaptiveThinkingBudget(cfg, 0.6);
    expect((result as { budgetTokens: number }).budgetTokens).toBe(6000);
  });

  test('adaptive config: high multiplier bumps effort up one step', () => {
    const cfg: ThinkingConfig = { type: 'adaptive', effort: 'medium' };
    const result = applyAdaptiveThinkingBudget(cfg, 1.6);
    expect(result.type).toBe('adaptive');
    expect((result as { effort: string }).effort).toBe('high');
  });

  test('adaptive config: low multiplier bumps effort down one step', () => {
    const cfg: ThinkingConfig = { type: 'adaptive', effort: 'medium' };
    const result = applyAdaptiveThinkingBudget(cfg, 0.6);
    expect((result as { effort: string }).effort).toBe('low');
  });

  test('adaptive config: max effort cannot bump up further', () => {
    const cfg: ThinkingConfig = { type: 'adaptive', effort: 'max' };
    const result = applyAdaptiveThinkingBudget(cfg, 2.0);
    expect((result as { effort: string }).effort).toBe('max');
  });

  test('adaptive config: low effort cannot bump down further', () => {
    const cfg: ThinkingConfig = { type: 'adaptive', effort: 'low' };
    const result = applyAdaptiveThinkingBudget(cfg, 0.5);
    expect((result as { effort: string }).effort).toBe('low');
  });

  test('adaptive config: mid-range multiplier (0.7..1.5) leaves effort unchanged', () => {
    const cfg: ThinkingConfig = { type: 'adaptive', effort: 'medium' };
    const result = applyAdaptiveThinkingBudget(cfg, 1.2);
    expect((result as { effort: string }).effort).toBe('medium');
  });

  test('disabled config: passes through unchanged (heuristic does not enable thinking)', () => {
    const cfg: ThinkingConfig = { type: 'disabled' };
    const result = applyAdaptiveThinkingBudget(cfg, 2.0);
    expect(result.type).toBe('disabled');
  });

  test('does not mutate the input config', () => {
    const cfg: ThinkingConfig = { type: 'enabled', budgetTokens: 10000 };
    const result = applyAdaptiveThinkingBudget(cfg, 1.5);
    expect(cfg.type === 'enabled' && cfg.budgetTokens).toBe(10000);
    expect(result).not.toBe(cfg);
  });
});
