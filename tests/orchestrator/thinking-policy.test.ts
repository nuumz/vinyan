import { describe, test, expect } from 'bun:test';
import {
  ThinkingPolicySchema,
  TaskUncertaintySignalSchema,
  ThinkingProfileIdSchema,
} from '../../src/orchestrator/thinking/thinking-policy.ts';

describe('ThinkingProfileIdSchema', () => {
  test('accepts valid profiles', () => {
    for (const id of ['A', 'B', 'C', 'D']) {
      expect(ThinkingProfileIdSchema.safeParse(id).success).toBe(true);
    }
  });

  test('rejects invalid profiles', () => {
    expect(ThinkingProfileIdSchema.safeParse('E').success).toBe(false);
    expect(ThinkingProfileIdSchema.safeParse('').success).toBe(false);
  });
});

describe('TaskUncertaintySignalSchema', () => {
  test('accepts valid signal', () => {
    const result = TaskUncertaintySignalSchema.safeParse({
      score: 0.65,
      components: { planComplexity: 0.4, priorTraceCount: 0.8 },
      basis: 'novelty-based',
    });
    expect(result.success).toBe(true);
  });

  test('rejects score out of range', () => {
    expect(TaskUncertaintySignalSchema.safeParse({
      score: 1.5,
      components: { planComplexity: 0.5, priorTraceCount: 0.5 },
      basis: 'cold-start',
    }).success).toBe(false);
  });

  test('rejects invalid basis', () => {
    expect(TaskUncertaintySignalSchema.safeParse({
      score: 0.5,
      components: { planComplexity: 0.5, priorTraceCount: 0.5 },
      basis: 'invalid',
    }).success).toBe(false);
  });
});

describe('ThinkingPolicySchema', () => {
  test('accepts valid policy with adaptive thinking', () => {
    const result = ThinkingPolicySchema.safeParse({
      policyBasis: 'calibrated',
      thinking: { type: 'adaptive', effort: 'high' },
      profileId: 'D',
      uncertaintyScore: 0.7,
      riskScore: 0.8,
      selfModelConfidence: 0.5,
      observationKey: 'code-modify:abc123',
      thinkingCeiling: 50000,
      taskTypeCalibration: {
        taskTypeSignature: 'code-modify',
        minObservationCount: 10,
        basis: 'emerging',
      },
    });
    expect(result.success).toBe(true);
  });

  test('accepts valid policy with disabled thinking', () => {
    const result = ThinkingPolicySchema.safeParse({
      policyBasis: 'default',
      thinking: { type: 'disabled' },
      profileId: 'A',
    });
    expect(result.success).toBe(true);
  });

  test('accepts valid policy with enabled thinking', () => {
    const result = ThinkingPolicySchema.safeParse({
      policyBasis: 'override',
      thinking: { type: 'enabled', budgetTokens: 10000 },
      profileId: 'C',
    });
    expect(result.success).toBe(true);
  });

  test('rejects invalid policyBasis', () => {
    expect(ThinkingPolicySchema.safeParse({
      policyBasis: 'auto',
      thinking: { type: 'disabled' },
      profileId: 'A',
    }).success).toBe(false);
  });

  test('rejects missing required fields', () => {
    expect(ThinkingPolicySchema.safeParse({
      policyBasis: 'default',
    }).success).toBe(false);
  });
});
