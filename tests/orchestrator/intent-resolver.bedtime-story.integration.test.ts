/**
 * Integration test for the bedtime-story misclassification bug.
 *
 * The reported user case: "ช่วยเขียนนิยายก่อนนอน สำหรับกล่อมลูกนอนให้สัก2บท"
 * was being classified as `conversational` and the secretary persona then
 * fabricated a delegation reply ("ผมจะส่งต่อให้ novelist") with no actual
 * work performed.
 *
 * The fix is a *deterministic* creative-deliverable pre-rule in
 * `intent/strategy.ts` — when the goal text contains an authoring verb
 * paired with a multi-section artifact noun, the resolver returns
 * `agentic-workflow` at high confidence WITHOUT consulting the LLM. This
 * pre-empts both the comprehender's potentially-wrong domain classification
 * AND the cost of an LLM advisory call. The follow-up "จัดการให้เลย" case
 * is handled by the short-affirmative pre-classifier (pure rule, no LLM).
 *
 * No verifier tier, no extra LLM calls — the fix attacks the root cause.
 */
import { beforeEach, describe, expect, it } from 'bun:test';
import { LLMProviderRegistry } from '../../src/orchestrator/llm/provider-registry.ts';
import {
  clearIntentResolverCache,
  resolveIntent,
  type IntentResolverDeps,
} from '../../src/orchestrator/intent-resolver.ts';
import type {
  LLMProvider,
  SemanticTaskUnderstanding,
  TaskInput,
  Turn,
} from '../../src/orchestrator/types.ts';

/**
 * Provider that throws if invoked. The bedtime-story path must NEVER call
 * the LLM — the deterministic pre-rule handles it. Any LLM invocation here
 * is a regression that re-introduces the original bug surface.
 */
const throwingProvider: LLMProvider = {
  id: 'must-not-be-called',
  tier: 'balanced',
  async generate() {
    throw new Error(
      'LLM should not be called — deterministic creative-deliverable pre-rule must short-circuit',
    );
  },
};

function makeInput(goal: string, overrides?: Partial<TaskInput>): TaskInput {
  return {
    id: 'task-bedtime-1',
    source: 'cli',
    goal,
    taskType: 'reasoning',
    budget: { maxTokens: 4000, maxDurationMs: 30000, maxRetries: 1 },
    ...overrides,
  };
}

/**
 * Mirror the production STU shape that triggered the bedtime-story bug.
 * The comprehender labelled the request `taskDomain=conversational`, which
 * — without the deterministic pre-rule — pushed the resolver into the
 * conversational shortcircuit at confidence 0.95.
 */
function makeUnderstanding(
  over: Partial<SemanticTaskUnderstanding> = {},
): SemanticTaskUnderstanding {
  return {
    rawGoal: over.rawGoal ?? '',
    taskDomain: 'conversational',
    taskIntent: 'inquire',
    toolRequirement: 'none',
    resolvedEntities: [],
    semanticIntent: { pattern: 'chat', implicitConstraints: [] },
    ...over,
  } as SemanticTaskUnderstanding;
}

function userTurn(seq: number, text: string): Turn {
  return {
    id: `u${seq}`,
    sessionId: 's1',
    seq,
    role: 'user',
    blocks: [{ type: 'text', text }],
    tokenCount: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    createdAt: Date.now(),
  };
}

function assistantTurn(seq: number, text: string): Turn {
  return {
    id: `a${seq}`,
    sessionId: 's1',
    seq,
    role: 'assistant',
    blocks: [{ type: 'text', text }],
    tokenCount: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    createdAt: Date.now(),
  };
}

beforeEach(() => {
  clearIntentResolverCache();
});

describe('intent resolver — bedtime-story bug fix (deterministic path)', () => {
  it('routes the bedtime-story prompt to agentic-workflow without invoking the LLM', async () => {
    const registry = new LLMProviderRegistry();
    registry.register(throwingProvider);

    const goal = 'ช่วยเขียนนิยายก่อนนอน สำหรับกล่อมลูกนอนให้สัก2บท';
    const result = await resolveIntent(makeInput(goal), {
      registry,
      understanding: makeUnderstanding({ rawGoal: goal }),
    } satisfies IntentResolverDeps);

    expect(result.strategy).toBe('agentic-workflow');
    expect(result.reasoningSource).toBe('deterministic');
    expect(result.confidence).toBeGreaterThanOrEqual(0.85);
    expect(result.deterministicCandidate?.source).toBe('creative-deliverable-pattern');
  });

  it('also handles English authoring requests deterministically', async () => {
    const registry = new LLMProviderRegistry();
    registry.register(throwingProvider);

    const goal = 'please write me a 2-chapter bedtime story for my kid';
    const result = await resolveIntent(makeInput(goal), {
      registry,
      understanding: makeUnderstanding({ rawGoal: goal }),
    } satisfies IntentResolverDeps);

    expect(result.strategy).toBe('agentic-workflow');
    expect(result.reasoningSource).toBe('deterministic');
  });

  it('does NOT trigger on a definition question (verb absent — bare noun does not count)', async () => {
    // The pre-rule requires verb + noun proximity. "นิยายเว็บตูนคืออะไร"
    // is a definition request — no authoring verb — so the deterministic
    // pre-rule does NOT fire and the request stays conversational.
    let primaryCalls = 0;
    const primary: LLMProvider = {
      id: 'primary',
      tier: 'balanced',
      async generate() {
        primaryCalls += 1;
        return {
          content: JSON.stringify({
            strategy: 'conversational',
            refinedGoal: 'definition request',
            reasoning: 'asking what a webtoon novel is',
            confidence: 0.95,
          }),
          toolCalls: [],
          tokensUsed: { input: 0, output: 0 },
          model: 'primary',
          stopReason: 'end_turn',
        };
      },
    };
    const registry = new LLMProviderRegistry();
    registry.register(primary);

    const goal = 'นิยายเว็บตูนคืออะไร';
    const result = await resolveIntent(makeInput(goal), {
      registry,
      understanding: makeUnderstanding({ rawGoal: goal }),
    } satisfies IntentResolverDeps);

    expect(result.strategy).toBe('conversational');
    // High-confidence deterministic skip (STU=conversational, conf=0.95) — primary still not called.
    expect(primaryCalls).toBe(0);
  });
});

describe('intent resolver — short-affirmative continuation fix', () => {
  it('routes "จัดการให้เลย" to agentic-workflow with reconstructed prompt, no LLM call', async () => {
    const registry = new LLMProviderRegistry();
    registry.register(throwingProvider);

    const turns: Turn[] = [
      userTurn(0, 'ช่วยเขียนนิยายก่อนนอน สำหรับกล่อมลูกนอนให้สัก2บท'),
      assistantTurn(
        1,
        'รับทราบครับ ผมจะส่งต่อให้ novelist เขียนนิทานก่อนนอนที่แสนอบอุ่นให้ทันทีครับ',
      ),
    ];

    const result = await resolveIntent(makeInput('จัดการให้เลย', { id: 'task-followup' }), {
      registry,
      turns,
    } satisfies IntentResolverDeps);

    expect(result.strategy).toBe('agentic-workflow');
    expect(result.reasoningSource).toBe('short-affirmative-continuation');
    expect(result.workflowPrompt).toBeDefined();
    expect(result.workflowPrompt!).toContain('นิยายก่อนนอน');
  });
});
