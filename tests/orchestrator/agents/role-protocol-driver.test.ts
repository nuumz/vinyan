/**
 * Tests for RoleProtocolDriver — Phase A1 inert framework.
 *
 * Behavior-only: every assertion exercises `resolve` or `run` against a
 * stubbed dispatcher and verifies the documented contract.
 *
 * Coverage:
 *   - resolve: explicit override > persona default > null; conversational
 *     short-circuit; missing-protocol bypass; class-mismatch bypass
 *   - run happy path: all steps succeed, evidence accumulates, aggregate
 *     confidence is the mean of step confidences
 *   - precondition unmet: dependent step is `skipped`, others run
 *   - blocking oracle fails: step is `oracle-blocked` after exhausting
 *     `retryMax` retries
 *   - non-blocking oracle: failure is recorded but step still succeeds
 *   - A1 honesty: `requiresPersonaClass: 'verifier'` step on a generator
 *     persona is `failure` (no silent re-routing)
 *   - exit criteria: evidence-confidence threshold met → `exitedEarly: true`
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { RoleProtocolDriver } from '../../../src/orchestrator/agents/role-protocol-driver.ts';
import {
  clearDynamicRoleProtocols,
  registerRoleProtocol,
} from '../../../src/orchestrator/agents/role-protocols/registry.ts';
import {
  makeRoleProtocolId,
  type RoleProtocol,
  type StepDispatchCallback,
  type StepDispatchResult,
  type StepOracleEvaluator,
} from '../../../src/orchestrator/agents/role-protocols/types.ts';
import type { AgentSpec } from '../../../src/orchestrator/types.ts';

function makePersona(overrides: Partial<AgentSpec> = {}): AgentSpec {
  return {
    id: 'researcher',
    name: 'Researcher',
    description: 'test persona',
    role: 'researcher',
    ...overrides,
  };
}

function makeProtocol(overrides: Partial<RoleProtocol> = {}): RoleProtocol {
  return {
    id: makeRoleProtocolId('test.investigate'),
    description: 'test protocol',
    steps: [
      { id: 'discover', kind: 'discover', description: 'find sources', promptPrepend: 'discover.' },
      {
        id: 'gather',
        kind: 'gather',
        description: 'collect evidence',
        promptPrepend: 'gather.',
        preconditions: ['discover'],
      },
    ],
    ...overrides,
  };
}

function dispatchStub(results: ReadonlyArray<Partial<StepDispatchResult>> = []): StepDispatchCallback {
  let i = 0;
  return async () => {
    const r = results[i++] ?? {};
    return {
      mutations: r.mutations ?? [],
      evidence: r.evidence,
      confidence: r.confidence,
      tokensConsumed: r.tokensConsumed ?? 100,
      durationMs: r.durationMs ?? 10,
    };
  };
}

afterEach(() => {
  clearDynamicRoleProtocols();
});

describe('resolve', () => {
  const driver = new RoleProtocolDriver();

  test('returns null when persona has no roleProtocolId and no override', () => {
    expect(driver.resolve({ persona: makePersona() })).toBeNull();
  });

  test('returns null when conversational, even if persona has a protocol', () => {
    const proto = makeProtocol();
    registerRoleProtocol(proto);
    const persona = makePersona({ roleProtocolId: 'test.investigate' });
    expect(driver.resolve({ persona, isConversational: true })).toBeNull();
  });

  test('returns null when the persona-declared protocol is not registered', () => {
    const persona = makePersona({ roleProtocolId: 'test.never-registered' });
    expect(driver.resolve({ persona })).toBeNull();
  });

  test('returns the persona-declared protocol when registered', () => {
    const proto = makeProtocol();
    registerRoleProtocol(proto);
    const persona = makePersona({ roleProtocolId: 'test.investigate' });
    expect(driver.resolve({ persona })).toBe(proto);
  });

  test('explicit override wins over persona default', () => {
    const dflt = makeProtocol({ id: makeRoleProtocolId('test.default') });
    const override = makeProtocol({ id: makeRoleProtocolId('test.override') });
    registerRoleProtocol(dflt);
    registerRoleProtocol(override);
    const persona = makePersona({ roleProtocolId: 'test.default' });
    expect(driver.resolve({ persona, overrideProtocolId: 'test.override' })).toBe(override);
  });

  test('returns null when protocol requires a class the persona is not', () => {
    const proto = makeProtocol({ requiresPersonaClass: 'verifier' });
    registerRoleProtocol(proto);
    const persona = makePersona({ role: 'researcher', roleProtocolId: 'test.investigate' }); // generator
    expect(driver.resolve({ persona })).toBeNull();
  });

  test('mixed-class persona may resolve a verifier-required protocol', () => {
    const proto = makeProtocol({ requiresPersonaClass: 'verifier' });
    registerRoleProtocol(proto);
    const persona = makePersona({ id: 'assistant', role: 'assistant', roleProtocolId: 'test.investigate' });
    expect(driver.resolve({ persona })).toBe(proto);
  });
});

describe('run — happy path', () => {
  const driver = new RoleProtocolDriver();

  test('every step succeeds; outcome is success', async () => {
    const proto = makeProtocol();
    const result = await driver.run({
      protocol: proto,
      persona: makePersona(),
      dispatch: dispatchStub([{ confidence: 0.8 }, { confidence: 0.9 }]),
    });
    expect(result.outcome).toBe('success');
    expect(result.steps.map((s) => s.outcome)).toEqual(['success', 'success']);
    expect(result.totalTokensConsumed).toBe(200);
    expect(result.aggregateConfidence).toBeCloseTo((0.8 + 0.9) / 2, 5);
    expect(result.exitedEarly).toBeUndefined();
  });

  test('records evidence and per-step confidence on each step', async () => {
    const proto = makeProtocol();
    const result = await driver.run({
      protocol: proto,
      persona: makePersona(),
      dispatch: dispatchStub([
        { evidence: { sources: ['url-1'] }, confidence: 0.7 },
        { evidence: { synthesized: true }, confidence: 0.85 },
      ]),
    });
    expect(result.steps[0]?.evidence).toEqual({ sources: ['url-1'] });
    expect(result.steps[1]?.evidence).toEqual({ synthesized: true });
    expect(result.steps[0]?.confidence).toBe(0.7);
  });
});

describe('run — preconditions', () => {
  const driver = new RoleProtocolDriver();

  test('skips a step whose precondition produced a non-success outcome', async () => {
    const proto = makeProtocol({
      steps: [
        {
          id: 'discover',
          kind: 'discover',
          description: 'd',
          promptPrepend: '',
          oracleHooks: [{ oracleName: 'source-citation', blocking: true }],
        },
        {
          id: 'gather',
          kind: 'gather',
          description: 'g',
          promptPrepend: '',
          preconditions: ['discover'],
        },
      ],
    });
    // Oracle evaluator marks the first step's blocking oracle as failed —
    // so step is `oracle-blocked` and `gather` cannot run.
    const evaluator: StepOracleEvaluator = async () => ({ 'source-citation': false });
    const result = await driver.run({
      protocol: proto,
      persona: makePersona(),
      dispatch: dispatchStub(),
      oracleEvaluator: evaluator,
    });
    expect(result.steps[0]?.outcome).toBe('oracle-blocked');
    expect(result.steps[1]?.outcome).toBe('skipped');
    expect(result.steps[1]?.reason).toContain('unmet precondition');
    expect(result.outcome).toBe('failure'); // no successful steps
  });
});

describe('run — blocking oracle', () => {
  const driver = new RoleProtocolDriver();

  test('retries up to retryMax then marks oracle-blocked', async () => {
    const proto = makeProtocol({
      steps: [
        {
          id: 'cite',
          kind: 'verify',
          description: 'c',
          promptPrepend: '',
          oracleHooks: [{ oracleName: 'source-citation', blocking: true }],
          retryMax: 2,
        },
      ],
    });
    let calls = 0;
    const dispatch: StepDispatchCallback = async () => {
      calls++;
      return { mutations: [], tokensConsumed: 50, durationMs: 5 };
    };
    const evaluator: StepOracleEvaluator = async () => ({ 'source-citation': false });
    const result = await driver.run({
      protocol: proto,
      persona: makePersona(),
      dispatch,
      oracleEvaluator: evaluator,
    });
    expect(calls).toBe(3); // initial + 2 retries
    expect(result.steps[0]?.outcome).toBe('oracle-blocked');
    expect(result.steps[0]?.attempts).toBe(3);
  });

  test('non-blocking oracle failure is recorded but step still succeeds', async () => {
    const proto = makeProtocol({
      steps: [
        {
          id: 'cite',
          kind: 'verify',
          description: 'c',
          promptPrepend: '',
          oracleHooks: [{ oracleName: 'soft-check', blocking: false }],
        },
      ],
    });
    const evaluator: StepOracleEvaluator = async () => ({ 'soft-check': false });
    const result = await driver.run({
      protocol: proto,
      persona: makePersona(),
      dispatch: dispatchStub(),
      oracleEvaluator: evaluator,
    });
    expect(result.steps[0]?.outcome).toBe('success');
    expect(result.steps[0]?.oracleVerdicts).toEqual({ 'soft-check': false });
  });

  test('absent oracleEvaluator defaults to "every declared oracle passes"', async () => {
    const proto = makeProtocol({
      steps: [
        {
          id: 'cite',
          kind: 'verify',
          description: 'c',
          promptPrepend: '',
          oracleHooks: [{ oracleName: 'source-citation', blocking: true }],
        },
      ],
    });
    const result = await driver.run({
      protocol: proto,
      persona: makePersona(),
      dispatch: dispatchStub(),
    });
    expect(result.steps[0]?.outcome).toBe('success');
    expect(result.steps[0]?.oracleVerdicts).toEqual({ 'source-citation': true });
  });
});

describe('run — A1 honesty', () => {
  const driver = new RoleProtocolDriver();

  test('verifier-required step on a generator persona is failure (no silent re-routing)', async () => {
    const proto = makeProtocol({
      steps: [
        {
          id: 'verify',
          kind: 'verify',
          description: 'check',
          promptPrepend: '',
          requiresPersonaClass: 'verifier',
        },
      ],
    });
    const result = await driver.run({
      protocol: proto,
      persona: makePersona({ role: 'researcher' }),
      dispatch: dispatchStub(),
    });
    expect(result.steps[0]?.outcome).toBe('failure');
    expect(result.steps[0]?.reason).toContain('requires verifier');
  });

  test('verifier-required step on a verifier persona runs normally', async () => {
    const proto = makeProtocol({
      steps: [
        {
          id: 'verify',
          kind: 'verify',
          description: 'check',
          promptPrepend: '',
          requiresPersonaClass: 'verifier',
        },
      ],
    });
    const result = await driver.run({
      protocol: proto,
      persona: makePersona({ id: 'reviewer', role: 'reviewer' }),
      dispatch: dispatchStub(),
    });
    expect(result.steps[0]?.outcome).toBe('success');
  });
});

describe('run — A3 adaptive overrides', () => {
  const driver = new RoleProtocolDriver();

  test('defaultRetryMax fills in for steps that omit retryMax', async () => {
    const proto = makeProtocol({
      steps: [
        {
          id: 'cite',
          kind: 'verify',
          description: 'c',
          promptPrepend: '',
          oracleHooks: [{ oracleName: 'soft', blocking: true }],
          // no retryMax declared — should fall back to runOpts default
        },
      ],
    });
    let calls = 0;
    const dispatch: StepDispatchCallback = async () => {
      calls++;
      return { mutations: [], tokensConsumed: 50, durationMs: 5 };
    };
    const evaluator: StepOracleEvaluator = async () => ({ soft: false });
    const result = await driver.run({
      protocol: proto,
      persona: makePersona(),
      dispatch,
      oracleEvaluator: evaluator,
      defaultRetryMax: 3,
    });
    expect(calls).toBe(4); // initial + 3 retries
    expect(result.steps[0]?.attempts).toBe(4);
  });

  test("step's explicit retryMax wins over defaultRetryMax", async () => {
    const proto = makeProtocol({
      steps: [
        {
          id: 'cite',
          kind: 'verify',
          description: 'c',
          promptPrepend: '',
          oracleHooks: [{ oracleName: 'soft', blocking: true }],
          retryMax: 0, // explicit fail-fast
        },
      ],
    });
    let calls = 0;
    const evaluator: StepOracleEvaluator = async () => ({ soft: false });
    await driver.run({
      protocol: proto,
      persona: makePersona(),
      dispatch: async () => {
        calls++;
        return { mutations: [], tokensConsumed: 0, durationMs: 0 };
      },
      oracleEvaluator: evaluator,
      defaultRetryMax: 5, // ignored — step pinned to 0
    });
    expect(calls).toBe(1);
  });

  test('exitConfidenceFloorOverride raises the bar above the declared threshold', async () => {
    const proto = makeProtocol({
      steps: [
        { id: 'a', kind: 'gather', description: '', promptPrepend: '' },
        { id: 'b', kind: 'analyze', description: '', promptPrepend: '', preconditions: ['a'] },
      ],
      exitCriteria: [{ kind: 'evidence-confidence', threshold: 0.7 }],
    });
    // Step 1 confidence 0.75 — exceeds the protocol's threshold (0.7)
    // BUT operator raised the floor to 0.9 → must NOT exit early.
    const result = await driver.run({
      protocol: proto,
      persona: makePersona(),
      dispatch: dispatchStub([{ confidence: 0.75 }, { confidence: 0.6 }]),
      exitConfidenceFloorOverride: 0.9,
    });
    expect(result.exitedEarly).toBeUndefined();
    expect(result.steps).toHaveLength(2);
  });

  test('exitConfidenceFloorOverride lowers the bar below the declared threshold', async () => {
    const proto = makeProtocol({
      steps: [
        { id: 'a', kind: 'gather', description: '', promptPrepend: '' },
        { id: 'b', kind: 'analyze', description: '', promptPrepend: '', preconditions: ['a'] },
      ],
      exitCriteria: [{ kind: 'evidence-confidence', threshold: 0.95 }],
    });
    // Step 1 confidence 0.6 — below the protocol's strict threshold (0.95)
    // BUT operator lowered the floor to 0.5 → must exit early after step 1.
    const result = await driver.run({
      protocol: proto,
      persona: makePersona(),
      dispatch: dispatchStub([{ confidence: 0.6 }]),
      exitConfidenceFloorOverride: 0.5,
    });
    expect(result.exitedEarly).toBe(true);
    expect(result.steps).toHaveLength(1);
  });
});

describe('run — exit criteria', () => {
  const driver = new RoleProtocolDriver();

  test('evidence-confidence threshold met after first step → exits early', async () => {
    const proto = makeProtocol({
      steps: [
        { id: 'a', kind: 'gather', description: '', promptPrepend: '' },
        { id: 'b', kind: 'analyze', description: '', promptPrepend: '', preconditions: ['a'] },
      ],
      exitCriteria: [{ kind: 'evidence-confidence', threshold: 0.9 }],
    });
    const result = await driver.run({
      protocol: proto,
      persona: makePersona(),
      dispatch: dispatchStub([{ confidence: 0.95 }]),
    });
    expect(result.exitedEarly).toBe(true);
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]?.outcome).toBe('success');
  });

  test('step-count minSteps unmet → no early exit', async () => {
    const proto = makeProtocol({
      steps: [
        { id: 'a', kind: 'gather', description: '', promptPrepend: '' },
        { id: 'b', kind: 'analyze', description: '', promptPrepend: '', preconditions: ['a'] },
      ],
      exitCriteria: [{ kind: 'step-count', minSteps: 2 }],
    });
    const result = await driver.run({
      protocol: proto,
      persona: makePersona(),
      dispatch: dispatchStub([{ confidence: 0.5 }, { confidence: 0.6 }]),
    });
    expect(result.exitedEarly).toBeUndefined();
    expect(result.steps).toHaveLength(2);
  });
});
