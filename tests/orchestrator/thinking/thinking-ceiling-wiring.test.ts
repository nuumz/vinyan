/**
 * T0a wiring contract — `phase-predict` now feeds the compiled `ThinkingPolicy`
 * through `translatePolicyToProvider` BEFORE storing `routing.thinkingConfig`.
 *
 * Why this matters: the policy compiler computes `thinkingCeiling` (P9 — 10%
 * floor + audit-sample bypass) for every task that crosses the calibrated
 * confidence threshold, but until this PR no consumer enforced it. This test
 * pins the end-to-end contract so a regression where someone inlines the
 * compiler without the translator immediately fails CI.
 */
import { describe, expect, test } from 'bun:test';
import { translatePolicyToProvider } from '../../../src/orchestrator/llm/thinking-policy-translator.ts';
import { compileThinkingPolicy } from '../../../src/orchestrator/thinking/thinking-compiler.ts';

describe('Thinking-ceiling wiring (T0a contract)', () => {
  test('high-risk + high-uncertainty + high-confidence → ceiling clamps adaptive max → enabled budget', async () => {
    // Profile D (highRisk + highUncertainty) → adaptive 'max' with baseBudget 100_000.
    // Confidence 0.9 (≥0.85) triggers the 10% floor: ceiling = 10_000.
    // After translator: thinking becomes `enabled` with budgetTokens = 10_000.
    const policy = await compileThinkingPolicy({
      taskInput: { id: 't', taskType: 'code', goal: 'g' },
      riskScore: 0.9,
      uncertaintySignal: { score: 0.9, components: { planComplexity: 0.9, priorTraceCount: 0.9 }, basis: 'calibrated' },
      routingLevel: 3,
      taskTypeSignature: 'code::ts::large',
      selfModelConfidence: 0.9,
      auditSampleRate: 0, // make audit-sample bypass deterministic (always trigger floor)
    });
    expect(policy.profileId).toBe('D');
    expect(policy.thinkingCeiling).toBeDefined();
    expect(policy.thinkingCeiling).toBeLessThan(100_000); // ceiling actually clamped

    const translated = translatePolicyToProvider(policy);
    expect(translated.thinkingConfig.type).toBe('enabled');
    if (translated.thinkingConfig.type === 'enabled' && policy.thinkingCeiling !== undefined) {
      expect(translated.thinkingConfig.budgetTokens).toBe(policy.thinkingCeiling);
    }
  });

  test('low-confidence → no ceiling → translator passes adaptive through unchanged', async () => {
    // Confidence below 0.4 → computeThinkingCeiling returns undefined.
    // Translator should pass the adaptive config through verbatim.
    const policy = await compileThinkingPolicy({
      taskInput: { id: 't', taskType: 'code', goal: 'g' },
      riskScore: 0.9,
      uncertaintySignal: { score: 0.9, components: { planComplexity: 0.9, priorTraceCount: 0.9 }, basis: 'cold-start' },
      routingLevel: 3,
      taskTypeSignature: 'code::ts::large',
      selfModelConfidence: 0.0,
    });
    expect(policy.thinkingCeiling).toBeUndefined();
    const translated = translatePolicyToProvider(policy);
    expect(translated.thinkingConfig.type).toBe('adaptive');
  });
});
