import { describe, expect, test } from 'bun:test';
import { generateRule } from '../../src/evolution/rule-generator.ts';
import type { EvolutionaryRule, ExtractedPattern } from '../../src/orchestrator/types.ts';

function makeAntiPattern(overrides?: Partial<ExtractedPattern>): ExtractedPattern {
  return {
    id: 'ap-test-1',
    type: 'anti-pattern',
    description: 'test anti-pattern',
    frequency: 10,
    confidence: 0.8,
    taskTypeSignature: 'bugfix::ts::single',
    approach: 'inline-all',
    sourceTraceIds: ['t-1', 't-2'],
    createdAt: Date.now(),
    decayWeight: 1.0,
    ...overrides,
  };
}

function makeSuccessPattern(overrides?: Partial<ExtractedPattern>): ExtractedPattern {
  return {
    id: 'sp-test-1',
    type: 'success-pattern',
    description: 'test success-pattern',
    frequency: 20,
    confidence: 0.7,
    taskTypeSignature: 'refactor::ts::single',
    approach: 'extract-method',
    comparedApproach: 'inline-all',
    qualityDelta: 0.35,
    sourceTraceIds: ['t-3', 't-4'],
    createdAt: Date.now(),
    decayWeight: 1.0,
    ...overrides,
  };
}

describe('PH3.3: Evolution Pipeline Enhancement', () => {
  describe('Fix 2: Proportional toLevel', () => {
    test('toLevel = min(3, failedAtLevel + 1) for level 1', () => {
      const rule = generateRule(makeAntiPattern({ routingLevel: 1 }))!;
      expect(rule.action).toBe('escalate');
      expect(rule.parameters.toLevel).toBe(2);
    });

    test('toLevel = min(3, failedAtLevel + 1) for level 2', () => {
      const rule = generateRule(makeAntiPattern({ routingLevel: 2 }))!;
      expect(rule.parameters.toLevel).toBe(3);
    });

    test('toLevel capped at 3 for level 3', () => {
      const rule = generateRule(makeAntiPattern({ routingLevel: 3 }))!;
      expect(rule.parameters.toLevel).toBe(3);
    });

    test('defaults to level 2 when routingLevel not set', () => {
      const rule = generateRule(makeAntiPattern({ routingLevel: undefined }))!;
      expect(rule.parameters.toLevel).toBe(2);
    });
  });

  describe('Fix 4: Multi-condition rules', () => {
    test('escalation rule includes oracleName when pattern provides it', () => {
      const rule = generateRule(makeAntiPattern({ oracleName: 'type-checker' }))!;
      expect(rule.condition.oracleName).toBe('type-checker');
      expect(rule.specificity).toBeGreaterThan(0);
    });

    test('escalation rule includes riskAbove when pattern provides it', () => {
      const rule = generateRule(makeAntiPattern({ riskAbove: 0.5 }))!;
      expect(rule.condition.riskAbove).toBe(0.5);
    });

    test('escalation rule includes modelPattern when pattern provides it', () => {
      const rule = generateRule(makeAntiPattern({ modelPattern: 'claude-haiku' }))!;
      expect(rule.condition.modelPattern).toBe('claude-haiku');
    });

    test('preference rule includes multi-conditions', () => {
      const rule = generateRule(makeSuccessPattern({ oracleName: 'ast', riskAbove: 0.3 }))!;
      expect(rule.action).toBe('prefer-model');
      expect(rule.condition.oracleName).toBe('ast');
      expect(rule.condition.riskAbove).toBe(0.3);
    });

    test('no extra conditions when pattern has no oracle/risk/model data', () => {
      const rule = generateRule(makeAntiPattern())!;
      expect(rule.condition.oracleName).toBeUndefined();
      expect(rule.condition.riskAbove).toBeUndefined();
      expect(rule.condition.modelPattern).toBeUndefined();
    });
  });
});
