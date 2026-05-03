/**
 * Phase A2 integration test for `researcher.investigate`.
 *
 * Wires the real driver, the real source-citation oracle, the real
 * built-in evaluator factory, and the real protocol declaration. Uses
 * a stubbed `dispatchUnderlying` to inject canned step outputs (synthesis
 * text + gather-step hashes) — this is the seam that A2.5 will replace
 * with actual `workerPool.dispatch` calls. Today, the stub proves that
 * the recipe + verifier work end-to-end without touching production
 * dispatch paths.
 *
 * The integration uses the `assistant` persona (Mixed class) so all 6
 * steps can run under one persona — researcher (Generator) cannot
 * fulfil the verify steps' `requiresPersonaClass: 'verifier'` in a
 * single-persona run, and that's the documented A1 behavior.
 *
 * Coverage:
 *   - happy path: every step succeeds, source-citation passes, exit early after step 5
 *   - oracle failure: synthesis cites an ungathered hash → verify-citations
 *     blocks with retryMax=1, total attempts=2, run outcome 'partial'
 *   - protocol shape: builtin protocol passes structural validation
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { RoleProtocolDriver } from '../../../../../src/orchestrator/agents/role-protocol-driver.ts';
import {
  RESEARCHER_INVESTIGATE_ID,
  registerBuiltinProtocols,
  researcherInvestigate,
} from '../../../../../src/orchestrator/agents/role-protocols/builtin/researcher-investigate.ts';
import { buildBuiltinOracleEvaluator } from '../../../../../src/orchestrator/agents/role-protocols/oracle-evaluator.ts';
import {
  clearDynamicRoleProtocols,
  registerRoleProtocol,
  validateProtocol,
} from '../../../../../src/orchestrator/agents/role-protocols/registry.ts';
import type { StepDispatchCallback } from '../../../../../src/orchestrator/agents/role-protocols/types.ts';
import type { AgentSpec } from '../../../../../src/orchestrator/types.ts';

function assistantPersona(): AgentSpec {
  return {
    id: 'assistant',
    name: 'Assistant',
    description: 'mixed-class persona for the integration test',
    role: 'assistant',
    roleProtocolId: RESEARCHER_INVESTIGATE_ID,
  };
}

const SOURCE_HASHES = ['hash-a', 'hash-b', 'hash-c'];

const SYNTHESIS_GOOD = [
  '# Findings',
  '',
  'Most browsers ship JavaScript engines.[^a]',
  'Engines have evolved toward JIT compilation in the past two decades.[^b]',
  'Memory pressure remains the primary mobile constraint. [hash:hash-c]',
  '',
  '[^a]: hash-a',
  '[^b]: hash-b',
].join('\n');

const SYNTHESIS_BAD_UNCITED = [
  '# Findings',
  '',
  'Most browsers ship JavaScript engines.[^a]',
  'A bald claim with no citation at all.',
  '',
  '[^a]: hash-a',
].join('\n');

const SYNTHESIS_BAD_DANGLING = [
  '# Findings',
  '',
  'Most browsers ship JavaScript engines.[^a]',
  'Engines went JIT a long time ago. [hash:not-in-gathered-set]',
  '',
  '[^a]: hash-a',
].join('\n');

/**
 * Build a dispatch callback that returns canned outputs per step. The
 * dispatcher is the only fixture that needs to know the protocol's step
 * ids — a real production wiring would translate them into per-step
 * prompts via `WorkerContract.systemPromptPrepend`.
 */
function buildDispatch(synthesisText: string): StepDispatchCallback {
  return async ({ step }) => {
    switch (step.id) {
      case 'discover':
        return {
          mutations: [],
          evidence: { candidates: ['source-1', 'source-2', 'source-3'] },
          confidence: 0.7,
          tokensConsumed: 100,
          durationMs: 5,
        };
      case 'gather':
        return {
          mutations: [],
          evidence: { hashes: SOURCE_HASHES },
          confidence: 0.85,
          tokensConsumed: 250,
          durationMs: 12,
        };
      case 'compare-extract':
        return {
          mutations: [],
          evidence: { extractedClaims: 7 },
          confidence: 0.8,
          tokensConsumed: 200,
          durationMs: 10,
        };
      case 'synthesize':
        return {
          mutations: [],
          evidence: { synthesisText },
          confidence: 0.78,
          tokensConsumed: 300,
          durationMs: 15,
        };
      case 'verify-citations':
        // The verify step doesn't generate new synthesis — it inspects the
        // prior synthesize step's output. The orchestration layer (A2.5)
        // will be responsible for forwarding `synthesisText` from the
        // synthesize step's evidence into this step's input. For the
        // integration test, the dispatcher does that forwarding so the
        // oracle has something to read.
        return {
          mutations: [],
          evidence: { synthesisText },
          confidence: 0.92,
          tokensConsumed: 80,
          durationMs: 4,
        };
      case 'verify-cross-source':
        return {
          mutations: [],
          evidence: { loneSourceClaims: 0 },
          confidence: 0.9,
          tokensConsumed: 60,
          durationMs: 3,
        };
      default:
        throw new Error(`unexpected step ${step.id}`);
    }
  };
}

afterEach(() => {
  clearDynamicRoleProtocols();
});

describe('researcher.investigate — protocol shape', () => {
  test('passes structural validation', () => {
    expect(() => validateProtocol(researcherInvestigate)).not.toThrow();
  });

  test('declares 6 steps in canonical order', () => {
    expect(researcherInvestigate.steps.map((s) => s.id)).toEqual([
      'discover',
      'gather',
      'compare-extract',
      'synthesize',
      'verify-citations',
      'verify-cross-source',
    ]);
  });

  test('source-citation oracle is declared on verify-citations step (blocking)', () => {
    const verifyStep = researcherInvestigate.steps.find((s) => s.id === 'verify-citations');
    expect(verifyStep?.oracleHooks).toEqual([{ oracleName: 'source-citation', blocking: true }]);
  });

  test('verify steps require verifier-class persona', () => {
    const verifySteps = researcherInvestigate.steps.filter((s) => s.kind === 'verify');
    for (const step of verifySteps) {
      expect(step.requiresPersonaClass).toBe('verifier');
    }
  });

  test('registerBuiltinProtocols makes the protocol resolvable', () => {
    registerBuiltinProtocols();
    const driver = new RoleProtocolDriver();
    const protocol = driver.resolve({ persona: assistantPersona() });
    expect(protocol?.id).toBe(RESEARCHER_INVESTIGATE_ID);
  });
});

describe('researcher.investigate — happy path with real oracle', () => {
  test('every step succeeds; source-citation passes; final outcome=success', async () => {
    registerRoleProtocol(researcherInvestigate);
    const driver = new RoleProtocolDriver();
    const evaluator = buildBuiltinOracleEvaluator({ onWarn: () => {} });

    const result = await driver.run({
      protocol: researcherInvestigate,
      persona: assistantPersona(),
      dispatch: buildDispatch(SYNTHESIS_GOOD),
      oracleEvaluator: evaluator,
    });

    expect(result.outcome).toBe('success');
    // Exit-criterion `oracle-pass: source-citation` is satisfied AND
    // `step-count minSteps: 4` is satisfied after step 5 — driver may
    // exit early after verify-citations. Whether early or after all 6
    // steps run, every executed step's outcome is success.
    for (const step of result.steps) {
      expect(step.outcome).toBe('success');
    }
    // verify-citations registered the oracle verdict
    const verifyStep = result.steps.find((s) => s.stepId === 'verify-citations');
    expect(verifyStep?.oracleVerdicts).toEqual({ 'source-citation': true });
  });
});

describe('researcher.investigate — oracle blocks on uncited claim', () => {
  test('uncited claim → verify-citations is oracle-blocked after retryMax exhausted', async () => {
    registerRoleProtocol(researcherInvestigate);
    const driver = new RoleProtocolDriver();
    const evaluator = buildBuiltinOracleEvaluator({ onWarn: () => {} });

    const result = await driver.run({
      protocol: researcherInvestigate,
      persona: assistantPersona(),
      dispatch: buildDispatch(SYNTHESIS_BAD_UNCITED),
      oracleEvaluator: evaluator,
    });

    const verifyStep = result.steps.find((s) => s.stepId === 'verify-citations');
    expect(verifyStep?.outcome).toBe('oracle-blocked');
    // retryMax=1 in the protocol → 1 + 1 = 2 attempts
    expect(verifyStep?.attempts).toBe(2);
    expect(verifyStep?.reason).toContain('source-citation');

    // verify-cross-source has a precondition on verify-citations → skipped
    const crossStep = result.steps.find((s) => s.stepId === 'verify-cross-source');
    expect(crossStep?.outcome).toBe('skipped');
    expect(crossStep?.reason).toContain('unmet precondition');

    // Some steps succeeded (discover/gather/compare-extract/synthesize) → 'partial'
    expect(result.outcome).toBe('partial');
  });
});

describe('researcher.investigate — oracle blocks on dangling citation', () => {
  test('citation resolves to a value not in gatheredHashes → oracle-blocked', async () => {
    registerRoleProtocol(researcherInvestigate);
    const driver = new RoleProtocolDriver();
    const evaluator = buildBuiltinOracleEvaluator({ onWarn: () => {} });

    const result = await driver.run({
      protocol: researcherInvestigate,
      persona: assistantPersona(),
      dispatch: buildDispatch(SYNTHESIS_BAD_DANGLING),
      oracleEvaluator: evaluator,
    });

    const verifyStep = result.steps.find((s) => s.stepId === 'verify-citations');
    expect(verifyStep?.outcome).toBe('oracle-blocked');
    expect(verifyStep?.oracleVerdicts).toEqual({ 'source-citation': false });
  });
});

describe('researcher.investigate — generator persona cannot complete verify steps', () => {
  test('researcher persona running this protocol fails the verify steps (A1 honesty)', async () => {
    registerRoleProtocol(researcherInvestigate);
    const driver = new RoleProtocolDriver();
    const evaluator = buildBuiltinOracleEvaluator({ onWarn: () => {} });

    const researcher: AgentSpec = {
      id: 'researcher',
      name: 'Researcher',
      description: 'generator-class persona',
      role: 'researcher',
      roleProtocolId: RESEARCHER_INVESTIGATE_ID,
    };

    const result = await driver.run({
      protocol: researcherInvestigate,
      persona: researcher,
      dispatch: buildDispatch(SYNTHESIS_GOOD),
      oracleEvaluator: evaluator,
    });

    // First 4 steps succeed; the two verify steps are 'failure' because
    // researcher (generator) ≠ requiresPersonaClass 'verifier'.
    const verifyCit = result.steps.find((s) => s.stepId === 'verify-citations');
    expect(verifyCit?.outcome).toBe('failure');
    expect(verifyCit?.reason).toContain('requires verifier');

    const verifyCross = result.steps.find((s) => s.stepId === 'verify-cross-source');
    // Class check fires BEFORE the precondition check inside the driver, so
    // verify-cross-source is recorded as 'failure' (class mismatch), not
    // 'skipped' (unmet precondition). Both are true causes; the driver
    // surfaces the root cause encountered first. The reason field captures
    // the specific issue for audit consumers.
    expect(verifyCross?.outcome).toBe('failure');
    expect(verifyCross?.reason).toContain('requires verifier');

    expect(result.outcome).toBe('partial');
  });
});
