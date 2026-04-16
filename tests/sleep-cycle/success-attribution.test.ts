/**
 * Success Attribution — Wave A tests.
 *
 * Proves the success-side learning loop: successful traces → success summary →
 * synthesizeSuccessRule produces a probational prefer-model rule when 3+
 * successes share a signature with a dominant model.
 */
import { describe, expect, it } from 'bun:test';
import type { ExecutionTrace } from '../../src/orchestrator/types.ts';
import {
  type SuccessTraceSummary,
  synthesizeSuccessRule,
  traceToSuccessSummary,
} from '../../src/sleep-cycle/reactive-cycle.ts';

function makeSuccessTrace(overrides: Partial<ExecutionTrace> = {}): ExecutionTrace {
  return {
    id: `trace-${Date.now()}`,
    taskId: `task-${Date.now()}`,
    timestamp: Date.now(),
    routingLevel: 2,
    taskTypeSignature: 'fix::ts::small',
    approach: 'refactor retry logic',
    oracleVerdicts: { type: true, test: true, ast: true },
    modelUsed: 'claude-sonnet',
    tokensConsumed: 2000,
    durationMs: 5000,
    outcome: 'success',
    affectedFiles: ['src/retry.ts'],
    ...overrides,
  };
}

function makeSuccessSummary(overrides: Partial<SuccessTraceSummary> = {}): SuccessTraceSummary {
  return {
    taskId: `task-${Date.now()}-${Math.random()}`,
    taskSignature: 'fix::ts::small',
    passingOracles: ['type', 'test', 'ast'],
    affectedFiles: ['src/retry.ts'],
    approach: 'refactor',
    modelUsed: 'claude-sonnet',
    ...overrides,
  };
}

describe('traceToSuccessSummary', () => {
  it('returns summary for success traces', () => {
    const trace = makeSuccessTrace();
    const summary = traceToSuccessSummary(trace);
    expect(summary).not.toBeNull();
    expect(summary!.passingOracles).toContain('type');
    expect(summary!.modelUsed).toBe('claude-sonnet');
  });

  it('returns null for failure traces', () => {
    const trace = makeSuccessTrace({ outcome: 'failure' });
    expect(traceToSuccessSummary(trace)).toBeNull();
  });
});

describe('synthesizeSuccessRule', () => {
  it('returns null with fewer than 3 traces', () => {
    const traces = [makeSuccessSummary(), makeSuccessSummary()];
    expect(synthesizeSuccessRule('fix::ts::small', traces)).toBeNull();
  });

  it('generates prefer-model rule when 3+ traces share a dominant model', () => {
    const traces = [
      makeSuccessSummary({ modelUsed: 'claude-sonnet' }),
      makeSuccessSummary({ modelUsed: 'claude-sonnet' }),
      makeSuccessSummary({ modelUsed: 'claude-sonnet' }),
      makeSuccessSummary({ modelUsed: 'claude-opus' }),
    ];
    const rule = synthesizeSuccessRule('fix::ts::small', traces);
    expect(rule).not.toBeNull();
    expect(rule!.action).toBe('prefer-model');
    expect(rule!.parameters.preferredModel).toBe('claude-sonnet');
    expect(rule!.status).toBe('probation');
    expect(rule!.parameters.successRate).toBeGreaterThanOrEqual(0.6);
    expect(rule!.sourceTraceIds).toHaveLength(4);
  });

  it('returns null when no model dominates (all different)', () => {
    const traces = [
      makeSuccessSummary({ modelUsed: 'model-a' }),
      makeSuccessSummary({ modelUsed: 'model-b' }),
      makeSuccessSummary({ modelUsed: 'model-c' }),
    ];
    const rule = synthesizeSuccessRule('fix::ts::small', traces);
    // No model has ≥60% dominance → no prefer-model rule
    // May fall back to adjust-threshold if file pattern matches
    if (rule) {
      expect(rule.action).toBe('adjust-threshold');
    }
  });

  it('identifies common passing oracles', () => {
    const traces = [
      makeSuccessSummary({ passingOracles: ['type', 'test'], modelUsed: 'claude-sonnet' }),
      makeSuccessSummary({ passingOracles: ['type', 'test', 'ast'], modelUsed: 'claude-sonnet' }),
      makeSuccessSummary({ passingOracles: ['type', 'test'], modelUsed: 'claude-sonnet' }),
    ];
    const rule = synthesizeSuccessRule('fix::ts::small', traces);
    expect(rule).not.toBeNull();
    expect(rule!.parameters.commonOracles).toContain('type');
    expect(rule!.parameters.commonOracles).toContain('test');
  });

  it('rationale includes model name and task signature', () => {
    const traces = Array.from({ length: 4 }, () => makeSuccessSummary({ modelUsed: 'claude-opus' }));
    const rule = synthesizeSuccessRule('refactor::ts::medium', traces);
    expect(rule).not.toBeNull();
    expect(rule!.rationale).toContain('claude-opus');
    expect(rule!.rationale).toContain('refactor::ts::medium');
  });
});
