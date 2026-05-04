/**
 * Behavior tests for the T6 alignment-score downgrade in
 * `kernel-precheck-bridge`.
 *
 * Pinned contracts:
 *   - score < 0.5 → emits PreCheckVerdict { passed: false, oracle: 'goal-alignment' }
 *   - score in [0.5, 0.7] → audit-warning (passed: true with reason text)
 *   - score > 0.7 → no extra verdict (critic verdict stands alone)
 *   - alignment + critic verdicts coexist for the same hypothesis
 *   - undefined / NaN scores skip the alignment row entirely
 */
import { describe, expect, test } from 'bun:test';
import type { CriticEngine, CriticResult, WorkerProposal } from '../../../src/orchestrator/critic/critic-engine.ts';
import {
  ALIGNMENT_AUDIT_WARNING_CEILING,
  ALIGNMENT_REJECT_THRESHOLD,
  buildKernelPreCheck,
} from '../../../src/orchestrator/critic/kernel-precheck-bridge.ts';
import type { Hypothesis } from '../../../src/orchestrator/thinking/hypothesis.ts';
import { hypothesisId } from '../../../src/orchestrator/thinking/hypothesis.ts';
import type { PerceptualHierarchy, TaskInput } from '../../../src/orchestrator/types.ts';

class StubCritic implements CriticEngine {
  constructor(private readonly verdict: 'approved' | 'rejected' | 'abstain') {}
  async review(_proposal: WorkerProposal): Promise<CriticResult> {
    return {
      approved: this.verdict !== 'rejected',
      verdict: this.verdict,
      confidence: 0.8,
      aspects: [],
      verdicts: {},
      tokensUsed: { input: 0, output: 0 },
    };
  }
}

function mkHypothesis(id: string): Hypothesis {
  return {
    id: hypothesisId(id),
    engineId: 'eng-A',
    approachLabel: 'direct',
    content: 'proposal content',
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

describe('kernel-precheck-bridge — T6 alignment downgrade', () => {
  test('score < 0.5 emits hard rejection verdict (oracle: goal-alignment)', async () => {
    const preCheck = buildKernelPreCheck({
      critic: new StubCritic('approved'),
      task: dummyTask,
      perception: dummyPerception,
      alignmentScorer: () => 0.2,
    });
    const verdicts = await preCheck([mkHypothesis('h1')]);
    const align = verdicts.find((v) => v.oracle === 'goal-alignment');
    expect(align?.passed).toBe(false);
    expect(align?.reason).toContain('0.20');
  });

  test('score in [0.5, 0.7] emits audit warning (passed: true)', async () => {
    const preCheck = buildKernelPreCheck({
      critic: new StubCritic('approved'),
      task: dummyTask,
      perception: dummyPerception,
      alignmentScorer: () => 0.6,
    });
    const verdicts = await preCheck([mkHypothesis('h1')]);
    const align = verdicts.find((v) => v.oracle === 'goal-alignment');
    expect(align?.passed).toBe(true);
    expect(align?.reason).toContain('audit-warning band');
  });

  test('score > 0.7 emits NO alignment row (critic verdict stands alone)', async () => {
    const preCheck = buildKernelPreCheck({
      critic: new StubCritic('approved'),
      task: dummyTask,
      perception: dummyPerception,
      alignmentScorer: () => 0.85,
    });
    const verdicts = await preCheck([mkHypothesis('h1')]);
    expect(verdicts.find((v) => v.oracle === 'goal-alignment')).toBeUndefined();
    expect(verdicts.find((v) => v.oracle === 'critic')?.passed).toBe(true);
  });

  test('critic + alignment verdicts COEXIST for the same hypothesis', async () => {
    const preCheck = buildKernelPreCheck({
      critic: new StubCritic('approved'),
      task: dummyTask,
      perception: dummyPerception,
      alignmentScorer: () => 0.3,
    });
    const verdicts = await preCheck([mkHypothesis('h1')]);
    expect(verdicts.length).toBe(2);
    expect(verdicts[0]?.oracle).toBe('critic');
    expect(verdicts[1]?.oracle).toBe('goal-alignment');
    // Selector treats either passed:false as elimination, so the
    // strictest signal wins (alignment rejects, hypothesis dies).
    expect(verdicts[0]?.passed).toBe(true);
    expect(verdicts[1]?.passed).toBe(false);
  });

  test('undefined score skips alignment row', async () => {
    const preCheck = buildKernelPreCheck({
      critic: new StubCritic('approved'),
      task: dummyTask,
      perception: dummyPerception,
      alignmentScorer: () => undefined,
    });
    const verdicts = await preCheck([mkHypothesis('h1')]);
    expect(verdicts.find((v) => v.oracle === 'goal-alignment')).toBeUndefined();
  });

  test('thresholds match the exported constants (regression pin)', () => {
    // If these change, T6's downgrade ladder semantics changed —
    // operators relying on the audit-warning band for tuning will break.
    expect(ALIGNMENT_REJECT_THRESHOLD).toBe(0.5);
    expect(ALIGNMENT_AUDIT_WARNING_CEILING).toBe(0.7);
  });
});
