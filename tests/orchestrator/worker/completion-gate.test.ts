/**
 * Wave 4: completion-gate + continuation-prompt tests.
 *
 * Table-driven tests over all decision branches of decideCompletion, plus
 * snapshot-style assertions on buildContinuationPrompt output structure.
 */
import { describe, expect, test } from 'bun:test';
import { decideCompletion, type CompletionGateInputs } from '../../../src/orchestrator/agent/completion-gate.ts';
import { buildContinuationPrompt } from '../../../src/orchestrator/agent/continuation-prompt.ts';

const baseInputs: CompletionGateInputs = {
  goalScore: 0.5,
  threshold: 0.75,
  continuationsUsed: 0,
  maxContinuations: 2,
  budgetRemaining: 5000,
  continuationCost: 1000,
  blockers: [],
};

describe('decideCompletion', () => {
  test('score >= threshold → accept', () => {
    const result = decideCompletion({ ...baseInputs, goalScore: 0.8 });
    expect(result.decision).toBe('accept');
    expect(result.reason).toContain('0.80');
  });

  test('score < threshold with budget + continuations available → continue', () => {
    const result = decideCompletion(baseInputs);
    expect(result.decision).toBe('continue');
    expect(result.reason).toContain('2 continuation');
  });

  test('max continuations reached → reject', () => {
    const result = decideCompletion({ ...baseInputs, continuationsUsed: 2 });
    expect(result.decision).toBe('reject');
    expect(result.reason).toContain('max continuations');
  });

  test('insufficient budget → reject', () => {
    const result = decideCompletion({ ...baseInputs, budgetRemaining: 500, continuationCost: 1000 });
    expect(result.decision).toBe('reject');
    expect(result.reason).toContain('insufficient budget');
  });

  test('all blockers unresolvable → reject', () => {
    const result = decideCompletion({
      ...baseInputs,
      blockers: [
        { category: 'hard-constraint', detail: 'file is read-only', resolvable: false },
        { category: 'missing-dep', detail: 'external API down', resolvable: false },
      ],
    });
    expect(result.decision).toBe('reject');
    expect(result.reason).toContain('unresolvable');
  });

  test('mixed blockers with at least one resolvable → continue', () => {
    const result = decideCompletion({
      ...baseInputs,
      blockers: [
        { category: 'hard-constraint', detail: 'file is read-only', resolvable: false },
        { category: 'acceptance-criteria', detail: 'missing tests', resolvable: true },
      ],
    });
    expect(result.decision).toBe('continue');
  });

  test('accept takes priority over other checks', () => {
    const result = decideCompletion({
      ...baseInputs,
      goalScore: 0.9,
      continuationsUsed: 5, // would otherwise reject
      budgetRemaining: 0, // would otherwise reject
      blockers: [{ category: 'x', detail: 'y', resolvable: false }], // would otherwise reject
    });
    expect(result.decision).toBe('accept');
  });
});

describe('buildContinuationPrompt', () => {
  test('includes attempt counter, goal, blockers, failed oracles', () => {
    const prompt = buildContinuationPrompt({
      goal: 'add tests for auth module',
      blockers: [
        { category: 'acceptance-criteria', detail: 'no test file created', resolvable: true },
        { category: 'oracle-contradiction', detail: 'conflicting verdicts', resolvable: false },
      ],
      failedOracles: ['test', 'type'],
      attemptNumber: 1,
      maxAttempts: 2,
    });

    expect(prompt).toContain('CONTINUATION 1/2');
    expect(prompt).toContain('DO NOT restart');
    expect(prompt).toContain('add tests for auth module');
    expect(prompt).toContain('acceptance-criteria');
    expect(prompt).toContain('no test file created');
    expect(prompt).toContain('non-resolvable');
    expect(prompt).toContain('test, type');
  });

  test('handles empty blockers gracefully', () => {
    const prompt = buildContinuationPrompt({
      goal: 'fix bug',
      blockers: [],
      failedOracles: [],
      attemptNumber: 2,
      maxAttempts: 2,
    });

    expect(prompt).toContain('CONTINUATION 2/2');
    expect(prompt).toContain('fix bug');
    expect(prompt).not.toContain('Unresolved blockers');
    expect(prompt).not.toContain('Oracles that rejected');
  });
});
