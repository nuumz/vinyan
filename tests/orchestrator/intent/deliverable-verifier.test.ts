/**
 * Deliverable verifier tests — exercises the focused-binary LLM call that
 * decides whether a goal expects a publishable artifact.
 *
 * The verifier is the separate-from-generator second tier (Axiom A1). Tests
 * use stub providers so the assertions stay deterministic.
 */
import { describe, expect, it } from 'bun:test';
import {
  pickVerifierProvider,
  synthesizeWorkflowPromptFromGoal,
  verifyDeliverable,
  VERIFIER_TIER_PREFERENCE,
} from '../../../src/orchestrator/intent/deliverable-verifier.ts';
import type { LLMProvider } from '../../../src/orchestrator/types.ts';

function stubProvider(tier: LLMProvider['tier'], content: string): LLMProvider {
  return {
    id: `stub/${tier}`,
    tier,
    async generate() {
      return {
        content,
        toolCalls: [],
        tokensUsed: { input: 0, output: 0 },
        model: 'stub',
        stopReason: 'end_turn',
      };
    },
  };
}

interface MiniRegistry {
  byTier: Map<LLMProvider['tier'], LLMProvider>;
  selectByTier(tier: LLMProvider['tier']): LLMProvider | undefined;
  listProviders(): LLMProvider[];
}

function makeRegistry(map: Partial<Record<LLMProvider['tier'], LLMProvider>>): MiniRegistry {
  const byTier = new Map<LLMProvider['tier'], LLMProvider>();
  for (const [tier, p] of Object.entries(map)) {
    if (p) byTier.set(tier as LLMProvider['tier'], p);
  }
  return {
    byTier,
    selectByTier(tier) {
      return byTier.get(tier);
    },
    listProviders() {
      return [...byTier.values()];
    },
  };
}

describe('pickVerifierProvider', () => {
  it('prefers fast tier first', () => {
    const fast = stubProvider('fast', '{}');
    const balanced = stubProvider('balanced', '{}');
    const reg = makeRegistry({ fast, balanced });
    expect(pickVerifierProvider(reg as never)?.id).toBe(fast.id);
    expect(VERIFIER_TIER_PREFERENCE[0]).toBe('fast');
  });

  it('falls through to balanced when fast is missing', () => {
    const balanced = stubProvider('balanced', '{}');
    const reg = makeRegistry({ balanced });
    expect(pickVerifierProvider(reg as never)?.id).toBe(balanced.id);
  });

  it('returns null when registry is empty', () => {
    expect(pickVerifierProvider(makeRegistry({}) as never)).toBeNull();
  });
});

describe('verifyDeliverable', () => {
  it('parses a positive verdict and returns the structured shape', async () => {
    const reg = makeRegistry({
      fast: stubProvider(
        'fast',
        JSON.stringify({
          isDeliverable: true,
          artifactKind: 'novel-chapter',
          estimatedSections: 2,
          reason: 'two chapters of bedtime prose requested',
        }),
      ),
    });
    const verdict = await verifyDeliverable(reg as never, 'เขียนนิยาย 2 บท', 'primary said conversational');
    expect(verdict.isDeliverable).toBe(true);
    expect(verdict.artifactKind).toBe('novel-chapter');
    expect(verdict.estimatedSections).toBe(2);
  });

  it('parses a negative verdict', async () => {
    const reg = makeRegistry({
      fast: stubProvider(
        'fast',
        JSON.stringify({ isDeliverable: false, reason: 'short factual question' }),
      ),
    });
    const verdict = await verifyDeliverable(reg as never, 'นิยายคืออะไร', 'primary said conversational');
    expect(verdict.isDeliverable).toBe(false);
  });

  it('strips ```json fences before parsing', async () => {
    const reg = makeRegistry({
      fast: stubProvider(
        'fast',
        '```json\n{"isDeliverable": true, "reason": "fenced"}\n```',
      ),
    });
    const verdict = await verifyDeliverable(reg as never, 'go', 'r');
    expect(verdict.isDeliverable).toBe(true);
  });

  it('throws on malformed JSON (caller treats as non-override)', async () => {
    const reg = makeRegistry({ fast: stubProvider('fast', 'not json at all') });
    await expect(verifyDeliverable(reg as never, 'go', 'r')).rejects.toBeDefined();
  });

  it('throws when no provider is registered', async () => {
    const reg = makeRegistry({});
    await expect(verifyDeliverable(reg as never, 'go', 'r')).rejects.toThrow(
      /no llm provider/i,
    );
  });
});

describe('synthesizeWorkflowPromptFromGoal', () => {
  it('echoes the goal and includes artifact + section count', () => {
    const out = synthesizeWorkflowPromptFromGoal('เขียนนิยาย 2 บท', {
      artifactKind: 'novel-chapter',
      estimatedSections: 2,
    });
    expect(out).toContain('เขียนนิยาย');
    expect(out).toContain('novel-chapter');
    expect(out).toContain('2');
  });

  it('omits artifact / section blocks when verdict is sparse', () => {
    const out = synthesizeWorkflowPromptFromGoal('write a story', {});
    expect(out).toContain('write a story');
    expect(out).not.toContain('Expected artifact');
    expect(out).not.toContain('Approximate scope');
  });

  it('always includes the producer instruction so downstream knows to actually generate', () => {
    const out = synthesizeWorkflowPromptFromGoal('x', {});
    expect(out.toLowerCase()).toContain('produce the deliverable');
  });
});
