/**
 * Behavior tests for the T3 critic ↔ kernel `preCheck` bridge.
 *
 * Pinned contracts:
 *   - `verdict: 'rejected'` → `PreCheckVerdict { passed: false }` emitted
 *   - `verdict: 'approved'` → `PreCheckVerdict { passed: true }` emitted
 *   - `verdict: 'abstain'`  → entry OMITTED (selector treats absence as pass)
 *   - sequential per-hypothesis dispatch (no concurrent provider load)
 *   - reason string carried through to audit trail
 */
import { describe, expect, test } from 'bun:test';
import type { CriticEngine, CriticResult, WorkerProposal } from '../../../src/orchestrator/critic/critic-engine.ts';
import { buildKernelPreCheck } from '../../../src/orchestrator/critic/kernel-precheck-bridge.ts';
import type { Hypothesis } from '../../../src/orchestrator/thinking/hypothesis.ts';
import { hypothesisId } from '../../../src/orchestrator/thinking/hypothesis.ts';
import type { PerceptualHierarchy, TaskInput } from '../../../src/orchestrator/types.ts';

class StubCritic implements CriticEngine {
  calls: WorkerProposal[] = [];
  constructor(private readonly responses: CriticResult[]) {}
  async review(proposal: WorkerProposal): Promise<CriticResult> {
    this.calls.push(proposal);
    const next = this.responses[this.calls.length - 1];
    if (!next) throw new Error(`stub-critic: no response queued for call ${this.calls.length}`);
    return next;
  }
}

function critResult(args: {
  verdict: 'approved' | 'rejected' | 'abstain';
  reason?: string;
  confidence?: number;
}): CriticResult {
  return {
    approved: args.verdict !== 'rejected',
    verdict: args.verdict,
    confidence: args.confidence ?? 0.7,
    aspects: [],
    reason: args.reason,
    verdicts: {},
    tokensUsed: { input: 100, output: 50 },
  };
}

function mkHypothesis(id: string, content: string): Hypothesis {
  return {
    id: hypothesisId(id),
    engineId: 'eng-A',
    approachLabel: 'direct',
    content,
    diversityFingerprint: `fp-${id}`,
    tokensUsed: { input: 50, output: 25 },
    terminationReason: 'completed',
  };
}

const dummyTask: TaskInput = {
  id: 't-1',
  goal: 'do the thing',
  taskType: 'code',
  budget: { maxTokens: 50_000, maxDurationMs: 60_000, maxRetries: 3 },
  source: 'cli',
};

const dummyPerception: PerceptualHierarchy = {
  taskTarget: { file: 'a.ts', description: 'edit' },
  dependencyCone: { directImporters: [], directImportees: [], transitiveBlastRadius: 0 },
  diagnostics: { lintWarnings: [], typeErrors: [], failingTests: [] },
  verifiedFacts: [],
  runtime: { nodeVersion: 'v22', os: 'linux', availableTools: [] },
};

describe('buildKernelPreCheck — verdict mapping', () => {
  test('rejected verdict → PreCheckVerdict passed:false', async () => {
    const stub = new StubCritic([critResult({ verdict: 'rejected', reason: 'logic flaw' })]);
    const preCheck = buildKernelPreCheck({ critic: stub, task: dummyTask, perception: dummyPerception });
    const verdicts = await preCheck([mkHypothesis('h1', 'broken proposal')]);
    expect(verdicts.length).toBe(1);
    expect(verdicts[0]?.passed).toBe(false);
    expect(verdicts[0]?.oracle).toBe('critic');
    expect(verdicts[0]?.reason).toBe('logic flaw');
  });

  test('approved verdict → PreCheckVerdict passed:true', async () => {
    const stub = new StubCritic([critResult({ verdict: 'approved', reason: 'looks good' })]);
    const preCheck = buildKernelPreCheck({ critic: stub, task: dummyTask, perception: dummyPerception });
    const verdicts = await preCheck([mkHypothesis('h1', 'good proposal')]);
    expect(verdicts.length).toBe(1);
    expect(verdicts[0]?.passed).toBe(true);
    expect(verdicts[0]?.reason).toBe('looks good');
  });

  test('abstain verdict → entry OMITTED (no PreCheckVerdict for that hypothesis)', async () => {
    const stub = new StubCritic([critResult({ verdict: 'abstain', reason: 'no signal' })]);
    const preCheck = buildKernelPreCheck({ critic: stub, task: dummyTask, perception: dummyPerception });
    const verdicts = await preCheck([mkHypothesis('h1', 'ambiguous proposal')]);
    expect(verdicts.length).toBe(0);
    // Critic was still called — abstain is an emitted verdict, not a skipped review
    expect(stub.calls.length).toBe(1);
  });

  test('mixed verdicts across hypotheses produces correct ordered + filtered output', async () => {
    const stub = new StubCritic([
      critResult({ verdict: 'approved' }),
      critResult({ verdict: 'abstain' }),
      critResult({ verdict: 'rejected' }),
    ]);
    const preCheck = buildKernelPreCheck({ critic: stub, task: dummyTask, perception: dummyPerception });
    const verdicts = await preCheck([mkHypothesis('h1', 'a'), mkHypothesis('h2', 'b'), mkHypothesis('h3', 'c')]);
    // h2 abstained → omitted; h1 + h3 should remain in original order
    expect(verdicts.length).toBe(2);
    expect(verdicts[0]?.hypothesisId).toBe(hypothesisId('h1'));
    expect(verdicts[0]?.passed).toBe(true);
    expect(verdicts[1]?.hypothesisId).toBe(hypothesisId('h3'));
    expect(verdicts[1]?.passed).toBe(false);
  });

  test('legacy CriticResult without verdict field (boolean only) maps via criticVerdictOf', async () => {
    // Stub returns a result with NO verdict field — legacy consumer shape.
    // Bridge should derive verdict from `approved` boolean via criticVerdictOf.
    const stub = new StubCritic([
      {
        approved: true,
        confidence: 0.7,
        aspects: [],
        verdicts: {},
        tokensUsed: { input: 0, output: 0 },
      } as CriticResult,
    ]);
    const preCheck = buildKernelPreCheck({ critic: stub, task: dummyTask, perception: dummyPerception });
    const verdicts = await preCheck([mkHypothesis('h1', 'a')]);
    expect(verdicts.length).toBe(1);
    expect(verdicts[0]?.passed).toBe(true);
  });
});

describe('buildKernelPreCheck — sequential dispatch (A1 / cost control)', () => {
  test('critic called once per hypothesis, in input order', async () => {
    const stub = new StubCritic([
      critResult({ verdict: 'approved' }),
      critResult({ verdict: 'approved' }),
      critResult({ verdict: 'approved' }),
    ]);
    const preCheck = buildKernelPreCheck({ critic: stub, task: dummyTask, perception: dummyPerception });
    await preCheck([mkHypothesis('h1', 'a'), mkHypothesis('h2', 'b'), mkHypothesis('h3', 'c')]);
    expect(stub.calls.length).toBe(3);
    // Each call's mutation file path encodes the hypothesis id we sent it
    expect(stub.calls[0]?.mutations[0]?.file).toBe('<hypothesis:h1>');
    expect(stub.calls[1]?.mutations[0]?.file).toBe('<hypothesis:h2>');
    expect(stub.calls[2]?.mutations[0]?.file).toBe('<hypothesis:h3>');
  });

  test('empty hypothesis list → no critic calls, empty verdicts', async () => {
    const stub = new StubCritic([]);
    const preCheck = buildKernelPreCheck({ critic: stub, task: dummyTask, perception: dummyPerception });
    const verdicts = await preCheck([]);
    expect(verdicts.length).toBe(0);
    expect(stub.calls.length).toBe(0);
  });
});
