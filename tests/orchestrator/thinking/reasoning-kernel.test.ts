import { describe, expect, test } from 'bun:test';
import {
  type GenerationInput,
  type GenerationOutcome,
  type Hypothesis,
  hypothesisId,
  type MultiHypothesisPolicy,
} from '../../../src/orchestrator/thinking/hypothesis.ts';
import type { HypothesisGenerator } from '../../../src/orchestrator/thinking/hypothesis-generator.ts';
import type { PreCheckVerdict } from '../../../src/orchestrator/thinking/hypothesis-selector.ts';
import { runReasoningKernel } from '../../../src/orchestrator/thinking/reasoning-kernel.ts';

class StubGenerator implements HypothesisGenerator {
  calls = 0;
  constructor(private readonly outcome: GenerationOutcome) {}
  async generate(_input: GenerationInput, _policy: MultiHypothesisPolicy): Promise<GenerationOutcome> {
    this.calls++;
    return this.outcome;
  }
}

const baseInput: GenerationInput = {
  systemPrompt: 's',
  userPrompt: 'u',
  perBranchTokens: 200,
};
const basePolicy: MultiHypothesisPolicy = { branches: 2, diversityConstraint: 'different-patterns' };

function hypo(id: string, overrides: Partial<Hypothesis> = {}): Hypothesis {
  return {
    id: hypothesisId(id),
    engineId: overrides.engineId ?? 'eng-1',
    approachLabel: overrides.approachLabel ?? 'direct',
    content: overrides.content ?? `proposal for ${id}`,
    diversityFingerprint: overrides.diversityFingerprint ?? `fp-${id}`,
    tokensUsed: overrides.tokensUsed ?? { input: 100, output: 50 },
    terminationReason: overrides.terminationReason ?? 'completed',
  };
}

describe('runReasoningKernel — happy path', () => {
  test('selects winner and emits replayable audit', async () => {
    const outcome: GenerationOutcome = {
      hypotheses: [
        hypo('h1', { tokensUsed: { input: 100, output: 60 } }),
        hypo('h2', { tokensUsed: { input: 100, output: 30 } }),
      ],
      rejected: [],
      totalTokens: { input: 200, output: 90, thinking: 0 },
    };
    const result = await runReasoningKernel({ generator: new StubGenerator(outcome) }, baseInput, basePolicy);
    expect(result.type).toBe('select');
    if (result.type === 'select') {
      // h2 is cheaper → cost tiebreaker picks it without history.
      expect(result.winner.id).toBe(hypothesisId('h2'));
      expect(result.audit.branchesAccepted).toBe(2);
      expect(result.audit.branchesRejected).toBe(0);
      expect(result.audit.totalTokens.input).toBe(200);
      expect(result.audit.selectionRationale.length).toBeGreaterThan(0);
    }
  });
});

describe('runReasoningKernel — abstain paths (A2)', () => {
  test('zero hypotheses → unknown with replayable audit', async () => {
    const outcome: GenerationOutcome = {
      hypotheses: [],
      rejected: [{ approachLabel: 'direct', engineId: 'e', rejection: { reason: 'empty-content' } }],
      totalTokens: { input: 100, output: 0, thinking: 0 },
    };
    const result = await runReasoningKernel({ generator: new StubGenerator(outcome) }, baseInput, basePolicy);
    expect(result.type).toBe('unknown');
    if (result.type === 'unknown') {
      expect(result.reason).toContain('no acceptable hypotheses');
      expect(result.audit.branchesAttempted).toBe(1);
      expect(result.audit.branchesRejected).toBe(1);
    }
  });

  test('selector abstain (all pre-checks fail) propagates as unknown', async () => {
    const hs = [hypo('h1'), hypo('h2')];
    const outcome: GenerationOutcome = {
      hypotheses: hs,
      rejected: [],
      totalTokens: { input: 200, output: 100, thinking: 0 },
    };
    const preCheck = (hypotheses: Hypothesis[]): PreCheckVerdict[] =>
      hypotheses.map((h) => ({ hypothesisId: h.id, passed: false, oracle: 'lint', reason: 'forbidden import' }));
    const result = await runReasoningKernel({ generator: new StubGenerator(outcome), preCheck }, baseInput, basePolicy);
    expect(result.type).toBe('unknown');
    if (result.type === 'unknown') {
      expect(result.reason).toContain('eliminated');
      expect(result.audit.eliminations.length).toBe(2);
    }
  });
});

describe('runReasoningKernel — A1 separation contract', () => {
  test('selector never sees the same engine that generated', async () => {
    // Behavior contract: the kernel's generator + selector are different
    // objects. We verify by spying that the supplied selector is what gets
    // used (NOT some accidental fallback that calls back into the generator).
    const hs = [hypo('h1'), hypo('h2')];
    const outcome: GenerationOutcome = {
      hypotheses: hs,
      rejected: [],
      totalTokens: { input: 200, output: 100, thinking: 0 },
    };
    let selectorCalled = 0;
    const generator = new StubGenerator(outcome);
    const result = await runReasoningKernel(
      {
        generator,
        selector: {
          select: (input) => {
            selectorCalled++;
            const winner = input.hypotheses[0];
            if (!winner) return { type: 'abstain', reason: 'empty', eliminations: [] };
            return {
              type: 'select',
              winner,
              rationale: ['custom-selector'],
              eliminations: [],
            };
          },
        },
      },
      baseInput,
      basePolicy,
    );
    expect(generator.calls).toBe(1);
    expect(selectorCalled).toBe(1);
    expect(result.type).toBe('select');
  });
});
