/**
 * Behavior tests for the T3 multi-hypothesis activation kill-switch.
 *
 * Pinned contracts:
 *   - default (no parameter store, kill-switch off) → Profile-D emits adaptive (legacy)
 *   - kill-switch off explicitly → Profile-D emits adaptive
 *   - kill-switch on → Profile-D emits multi-hypothesis with sane defaults
 *   - non-Profile-D tasks NEVER emit multi-hypothesis even when kill-switch is on
 */
import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { migration001 } from '../../../src/db/migrations/001_initial_schema.ts';
import { MigrationRunner } from '../../../src/db/migrations/migration-runner.ts';
import { ParameterLedger } from '../../../src/orchestrator/adaptive-params/parameter-ledger.ts';
import { ParameterStore } from '../../../src/orchestrator/adaptive-params/parameter-store.ts';
import { DefaultThinkingPolicyCompiler } from '../../../src/orchestrator/thinking/thinking-compiler.ts';
import type { ThinkingPolicyInput } from '../../../src/orchestrator/thinking/thinking-policy.ts';

function profileDInput(overrides: Partial<ThinkingPolicyInput> = {}): ThinkingPolicyInput {
  return {
    taskInput: { id: 't', taskType: 'code', goal: 'g' },
    riskScore: 0.9,
    uncertaintySignal: { score: 0.9, components: { planComplexity: 0.9, priorTraceCount: 0.9 }, basis: 'calibrated' },
    routingLevel: 3,
    taskTypeSignature: 'code::ts::large',
    selfModelConfidence: 0.5,
    ...overrides,
  };
}

function profileAInput(): ThinkingPolicyInput {
  return profileDInput({
    riskScore: 0.1,
    uncertaintySignal: { score: 0.1, components: { planComplexity: 0.1, priorTraceCount: 0.1 }, basis: 'calibrated' },
    routingLevel: 0,
  });
}

function buildStore(initial?: { multiHypothesisEnabled: boolean }): ParameterStore {
  const db = new Database(':memory:');
  new MigrationRunner().migrate(db, [migration001]);
  const ledger = new ParameterLedger(db);
  const store = new ParameterStore({ ledger });
  if (initial) {
    store.set('thinking.multi_hypothesis_enabled', initial.multiHypothesisEnabled, 'test-fixture', 'test');
  }
  return store;
}

describe('multi-hypothesis activation (T3 kill-switch)', () => {
  test('no parameter store → Profile-D emits legacy adaptive config (kernel dormant)', async () => {
    const compiler = new DefaultThinkingPolicyCompiler();
    const policy = await compiler.compile(profileDInput());
    expect(policy.profileId).toBe('D');
    expect(policy.thinking.type).toBe('adaptive');
  });

  test('kill-switch off → Profile-D emits legacy adaptive (default behavior)', async () => {
    const store = buildStore({ multiHypothesisEnabled: false });
    const compiler = new DefaultThinkingPolicyCompiler({ parameterStore: store });
    const policy = await compiler.compile(profileDInput());
    expect(policy.profileId).toBe('D');
    expect(policy.thinking.type).toBe('adaptive');
  });

  test('kill-switch on → Profile-D emits multi-hypothesis with sane defaults', async () => {
    const store = buildStore({ multiHypothesisEnabled: true });
    const compiler = new DefaultThinkingPolicyCompiler({ parameterStore: store });
    const policy = await compiler.compile(profileDInput());
    expect(policy.profileId).toBe('D');
    expect(policy.thinking.type).toBe('multi-hypothesis');
    if (policy.thinking.type === 'multi-hypothesis') {
      expect(policy.thinking.branches).toBe(3);
      expect(policy.thinking.diversityConstraint).toBe('different-resources');
    }
  });

  test('kill-switch on but Profile-A task → emits disabled (no multi-hypothesis)', async () => {
    const store = buildStore({ multiHypothesisEnabled: true });
    const compiler = new DefaultThinkingPolicyCompiler({ parameterStore: store });
    const policy = await compiler.compile(profileAInput());
    expect(policy.profileId).toBe('A');
    expect(policy.thinking.type).toBe('disabled');
  });

  test('flipping kill-switch live changes next-compile output', async () => {
    const store = buildStore({ multiHypothesisEnabled: false });
    const compiler = new DefaultThinkingPolicyCompiler({ parameterStore: store });

    const before = await compiler.compile(profileDInput());
    expect(before.thinking.type).toBe('adaptive');

    // Operator flips the kill-switch — same compiler instance.
    store.set('thinking.multi_hypothesis_enabled', true, 'operator-action', 'test');

    const after = await compiler.compile(profileDInput());
    expect(after.thinking.type).toBe('multi-hypothesis');
  });
});
