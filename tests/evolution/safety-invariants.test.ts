import { describe, expect, test } from 'bun:test';
import { checkSafetyInvariants, filterSafeRules } from '../../src/evolution/safety-invariants.ts';
import type { EvolutionaryRule } from '../../src/orchestrator/types.ts';

function makeRule(overrides?: Partial<EvolutionaryRule>): EvolutionaryRule {
  return {
    id: 'rule-1',
    source: 'sleep-cycle',
    condition: {},
    action: 'escalate',
    parameters: { toLevel: 2 },
    status: 'active',
    createdAt: Date.now(),
    effectiveness: 0.5,
    specificity: 0,
    ...overrides,
  };
}

describe('checkSafetyInvariants', () => {
  test('safe rule passes all invariants', () => {
    const result = checkSafetyInvariants(makeRule());
    expect(result.safe).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  test('I1: detects disabled human escalation', () => {
    const result = checkSafetyInvariants(
      makeRule({
        action: 'adjust-threshold',
        parameters: { disableHumanEscalation: true },
      }),
    );
    expect(result.safe).toBe(false);
    expect(result.violations[0]).toContain('I1');
  });

  test('I2: detects relaxed security', () => {
    const result = checkSafetyInvariants(
      makeRule({
        action: 'adjust-threshold',
        parameters: { relaxSecurity: true },
      }),
    );
    expect(result.safe).toBe(false);
    expect(result.violations[0]).toContain('I2');
  });

  test('I3: detects budget ceiling violation (maxTokens)', () => {
    const result = checkSafetyInvariants(
      makeRule({
        action: 'adjust-threshold',
        parameters: { maxTokens: 1_000_000 },
      }),
    );
    expect(result.safe).toBe(false);
    expect(result.violations[0]).toContain('I3');
  });

  test('I3: detects budget ceiling violation (maxDurationMs)', () => {
    const result = checkSafetyInvariants(
      makeRule({
        action: 'adjust-threshold',
        parameters: { maxDurationMs: 700_000 },
      }),
    );
    expect(result.safe).toBe(false);
    expect(result.violations.some((v) => v.includes('I3'))).toBe(true);
  });

  test('I4: detects skipped tests', () => {
    const result = checkSafetyInvariants(
      makeRule({
        action: 'adjust-threshold',
        parameters: { skipTests: true },
      }),
    );
    expect(result.safe).toBe(false);
    expect(result.violations[0]).toContain('I4');
  });

  test('I5: detects disabled rollback', () => {
    const result = checkSafetyInvariants(
      makeRule({
        action: 'adjust-threshold',
        parameters: { disableRollback: true },
      }),
    );
    expect(result.safe).toBe(false);
    expect(result.violations[0]).toContain('I5');
  });

  test('I6: detects routing floor violation (forceL0ForMultiFile)', () => {
    const result = checkSafetyInvariants(
      makeRule({
        action: 'adjust-threshold',
        parameters: { forceL0ForMultiFile: true },
      }),
    );
    expect(result.safe).toBe(false);
    expect(result.violations[0]).toContain('I6');
  });

  test('I6: detects escalation to negative level', () => {
    const result = checkSafetyInvariants(
      makeRule({
        action: 'escalate',
        parameters: { toLevel: -1 },
      }),
    );
    expect(result.safe).toBe(false);
    expect(result.violations.some((v) => v.includes('I6'))).toBe(true);
  });

  test('multiple violations detected at once', () => {
    const result = checkSafetyInvariants(
      makeRule({
        action: 'adjust-threshold',
        parameters: { skipTests: true, disableRollback: true, relaxSecurity: true },
      }),
    );
    expect(result.safe).toBe(false);
    expect(result.violations.length).toBeGreaterThanOrEqual(3);
  });
});

describe('filterSafeRules', () => {
  test('filters out unsafe rules and reports violations', () => {
    const rules = [
      makeRule({ id: 'safe-1' }),
      makeRule({ id: 'unsafe-1', action: 'adjust-threshold', parameters: { skipTests: true } }),
      makeRule({ id: 'safe-2', parameters: { toLevel: 3 } }),
    ];

    const result = filterSafeRules(rules);
    expect(result.safe).toHaveLength(2);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]!.ruleId).toBe('unsafe-1');
  });
});

describe('checkSafetyInvariants — I9/I10/I11 Fleet Governance', () => {
  test('I9: assign-worker with skipOracles is rejected', () => {
    const result = checkSafetyInvariants(
      makeRule({
        action: 'assign-worker',
        parameters: { workerId: 'w-1', skipOracles: true },
      }),
    );
    expect(result.safe).toBe(false);
    expect(result.violations.some((v) => v.includes('I9'))).toBe(true);
  });

  test('I10: probation worker with allowCommit is rejected', () => {
    const result = checkSafetyInvariants(
      makeRule({
        action: 'assign-worker',
        parameters: { workerId: 'w-1', workerStatus: 'probation', allowCommit: true },
      }),
    );
    expect(result.safe).toBe(false);
    expect(result.violations.some((v) => v.includes('I10'))).toBe(true);
  });

  test('I11: exclusiveAllocation > 0.70 is rejected', () => {
    const result = checkSafetyInvariants(
      makeRule({
        action: 'assign-worker',
        parameters: { workerId: 'w-1', exclusiveAllocation: 0.85 },
      }),
    );
    expect(result.safe).toBe(false);
    expect(result.violations.some((v) => v.includes('I11'))).toBe(true);
  });

  test('I11: exclusiveAllocation = 0.70 is allowed (at boundary)', () => {
    const result = checkSafetyInvariants(
      makeRule({
        action: 'assign-worker',
        parameters: { workerId: 'w-1', exclusiveAllocation: 0.7 },
      }),
    );
    expect(result.safe).toBe(true);
  });

  test('assign-worker without violations is allowed', () => {
    const result = checkSafetyInvariants(
      makeRule({
        action: 'assign-worker',
        parameters: { workerId: 'w-1' },
      }),
    );
    expect(result.safe).toBe(true);
  });
});

describe('checkSafetyInvariants — I6 risk threshold floor', () => {
  test('adjust-threshold with riskThreshold: 0.0 is rejected with I6 violation', () => {
    const result = checkSafetyInvariants(
      makeRule({
        action: 'adjust-threshold',
        parameters: { riskThreshold: 0.0 },
      }),
    );
    expect(result.safe).toBe(false);
    expect(result.violations.some((v) => v.includes('I6'))).toBe(true);
  });

  test('adjust-threshold with riskThreshold: 0.2 is allowed', () => {
    const result = checkSafetyInvariants(
      makeRule({
        action: 'adjust-threshold',
        parameters: { riskThreshold: 0.2 },
      }),
    );
    expect(result.safe).toBe(true);
    expect(result.violations).toHaveLength(0);
  });
});

describe('checkSafetyInvariants — I7 model allowlist', () => {
  test("prefer-model with preferredModel: 'evil-model' is rejected with I7 violation", () => {
    const result = checkSafetyInvariants(
      makeRule({
        action: 'prefer-model',
        parameters: { preferredModel: 'evil-model' },
      }),
    );
    expect(result.safe).toBe(false);
    expect(result.violations.some((v) => v.includes('I7'))).toBe(true);
  });

  test("prefer-model with preferredModel: 'claude-sonnet' is allowed", () => {
    const result = checkSafetyInvariants(
      makeRule({
        action: 'prefer-model',
        parameters: { preferredModel: 'claude-sonnet' },
      }),
    );
    expect(result.safe).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  test("prefer-model with preferredModel: 'gpt-4' is allowed", () => {
    const result = checkSafetyInvariants(
      makeRule({
        action: 'prefer-model',
        parameters: { preferredModel: 'gpt-4' },
      }),
    );
    expect(result.safe).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  test("prefer-model with preferredModel: 'mock/test' is allowed", () => {
    const result = checkSafetyInvariants(
      makeRule({
        action: 'prefer-model',
        parameters: { preferredModel: 'mock/test' },
      }),
    );
    expect(result.safe).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  test("prefer-model with preferredModel: 'openrouter/uncensored-model' is rejected (I7)", () => {
    const result = checkSafetyInvariants(
      makeRule({
        action: 'prefer-model',
        parameters: { preferredModel: 'openrouter/uncensored-model' },
      }),
    );
    expect(result.safe).toBe(false);
    expect(result.violations.some((v) => v.includes('I7'))).toBe(true);
  });

  test("prefer-model with preferredModel: 'openrouter/anthropic/claude-3.5-sonnet' is allowed (explicit allowlist)", () => {
    const result = checkSafetyInvariants(
      makeRule({
        action: 'prefer-model',
        parameters: { preferredModel: 'openrouter/anthropic/claude-3.5-sonnet' },
      }),
    );
    expect(result.safe).toBe(true);
    expect(result.violations).toHaveLength(0);
  });
});
