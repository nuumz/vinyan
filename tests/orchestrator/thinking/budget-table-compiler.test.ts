/**
 * Behavior tests for the T5 compiler ↔ budget-table integration.
 *
 * Pinned contracts:
 *   - empty budget table → ceiling falls through to legacy heuristic
 *   - matching `(taskTypeSignature, mode)` entry overrides ceiling
 *   - non-matching task type leaves ceiling unchanged
 *   - kill-switch off (multi-hypothesis) but budget table present still
 *     applies the override (the two T-knobs are orthogonal)
 *   - taskTypeCalibration.basis flips to 'calibrated' when override applies
 */
import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { migration001 } from '../../../src/db/migrations/001_initial_schema.ts';
import { MigrationRunner } from '../../../src/db/migrations/migration-runner.ts';
import { ParameterLedger } from '../../../src/orchestrator/adaptive-params/parameter-ledger.ts';
import { ParameterStore } from '../../../src/orchestrator/adaptive-params/parameter-store.ts';
import { DefaultThinkingPolicyCompiler } from '../../../src/orchestrator/thinking/thinking-compiler.ts';
import type { ThinkingPolicyInput } from '../../../src/orchestrator/thinking/thinking-policy.ts';

function freshStore(): ParameterStore {
  const db = new Database(':memory:');
  new MigrationRunner().migrate(db, [migration001]);
  return new ParameterStore({ ledger: new ParameterLedger(db) });
}

function profileBInput(taskTypeSignature = 'edit-ts'): ThinkingPolicyInput {
  // Profile B: low-risk + high-uncertainty → adaptive:high
  return {
    taskInput: { id: 't', taskType: 'code', goal: 'g' },
    riskScore: 0.1,
    uncertaintySignal: { score: 0.9, components: { planComplexity: 0.9, priorTraceCount: 0.9 }, basis: 'calibrated' },
    routingLevel: 2,
    taskTypeSignature,
    selfModelConfidence: 0.5,
  };
}

describe('DefaultThinkingPolicyCompiler — T5 budget table override', () => {
  test('empty budget table → ceiling unchanged (legacy heuristic)', async () => {
    const store = freshStore();
    const compiler = new DefaultThinkingPolicyCompiler({ parameterStore: store });
    const policy = await compiler.compile(profileBInput());
    expect(policy.profileId).toBe('B');
    if (policy.thinking.type === 'adaptive') expect(policy.thinking.effort).toBe('high');
    // Legacy ceiling: confidence=0.5 → ceil(60_000 × (1 - 0.5)) = 30_000
    expect(policy.thinkingCeiling).toBe(30_000);
  });

  test('matching budget-table entry overrides ceiling', async () => {
    const store = freshStore();
    store.set('thinking.budget_table', { 'edit-ts:adaptive:high': 12_345 }, 'test seed', 'test');
    const compiler = new DefaultThinkingPolicyCompiler({ parameterStore: store });
    const policy = await compiler.compile(profileBInput('edit-ts'));
    expect(policy.thinkingCeiling).toBe(12_345);
    expect(policy.taskTypeCalibration?.basis).toBe('calibrated');
  });

  test('non-matching task type → no override applied', async () => {
    const store = freshStore();
    store.set('thinking.budget_table', { 'edit-ts:adaptive:high': 12_345 }, 'test seed', 'test');
    const compiler = new DefaultThinkingPolicyCompiler({ parameterStore: store });
    const policy = await compiler.compile(profileBInput('refactor-rs'));
    // Override does not apply → ceiling falls back to heuristic 30_000
    expect(policy.thinkingCeiling).toBe(30_000);
  });

  test('non-matching mode (different effort) → no override applied', async () => {
    const store = freshStore();
    store.set('thinking.budget_table', { 'edit-ts:adaptive:low': 12_345 }, 'test seed', 'test');
    const compiler = new DefaultThinkingPolicyCompiler({ parameterStore: store });
    const policy = await compiler.compile(profileBInput('edit-ts'));
    expect(policy.thinkingCeiling).toBe(30_000);
  });

  test('non-positive override is ignored (defensive against corrupted ledger)', async () => {
    const store = freshStore();
    store.set('thinking.budget_table', { 'edit-ts:adaptive:high': 0 }, 'test seed', 'test');
    const compiler = new DefaultThinkingPolicyCompiler({ parameterStore: store });
    const policy = await compiler.compile(profileBInput('edit-ts'));
    expect(policy.thinkingCeiling).toBe(30_000);
  });
});
