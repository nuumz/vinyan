/**
 * Integration test for the bedtime-story misclassification bug.
 *
 * The user reported that "ช่วยเขียนนิยายก่อนนอน สำหรับกล่อมลูกนอนให้สัก2บท"
 * (a clear creative-deliverable request) was being classified as
 * `conversational` and routed through the secretary persona's hallucinated
 * delegation instead of into agentic-workflow.
 *
 * This test pins the two-stage classifier fix: when the primary LLM picks
 * conversational on a goal containing strong deliverable signals, the
 * uncertainty detector fires, the focused binary verifier runs, and the
 * verdict is flipped to agentic-workflow with a synthesized workflow prompt.
 *
 * Also pins the short-affirmative continuation fix: a follow-up "จัดการให้เลย"
 * after an unfulfilled deliverable proposal must short-circuit straight to
 * agentic-workflow without consulting the LLM at all.
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
  LLMRequest,
  LLMResponse,
  SemanticTaskUnderstanding,
  TaskInput,
  Turn,
} from '../../src/orchestrator/types.ts';

/**
 * Stub provider that returns a fixed JSON response. The primary classifier
 * and the deliverable verifier both call provider.generate() but with
 * different system prompts; we route by tier so we can wire two distinct
 * stub responses into the same registry.
 */
function stubProvider(tier: LLMProvider['tier'], jsonContent: string): LLMProvider {
  return {
    id: `stub/${tier}`,
    tier,
    async generate(_req: LLMRequest): Promise<LLMResponse> {
      return {
        content: jsonContent,
        toolCalls: [],
        tokensUsed: { input: 0, output: 0 },
        model: `stub/${tier}`,
        stopReason: 'end_turn',
      };
    },
  };
}

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
 * Mirror the production STU shape that triggered the bedtime-story bug: the
 * comprehender classified the request as `taskDomain=conversational`, which
 * pushed deterministic strategy to conversational at confidence 0.95 (skip
 * threshold met) and bypassed the LLM tier entirely. The two-stage classifier
 * fix overrides the deterministic skip when deliverable signals are present.
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

describe('intent resolver — bedtime story misclassification fix', () => {
  it('flips conversational → agentic-workflow when verifier confirms a deliverable', async () => {
    // Primary classifier (balanced tier — first in TIER_PREFERENCE) picks
    // conversational, mirroring the reported production bug.
    const primary = stubProvider(
      'balanced',
      JSON.stringify({
        strategy: 'conversational',
        refinedGoal: 'ช่วยเขียนนิยายก่อนนอน สำหรับกล่อมลูกนอนให้สัก2บท',
        reasoning: 'short polite request, treating as chat',
        confidence: 0.55,
      }),
    );
    // Verifier (fast tier — first in VERIFIER_TIER_PREFERENCE) returns the
    // narrow binary verdict.
    const verifier = stubProvider(
      'fast',
      JSON.stringify({
        isDeliverable: true,
        artifactKind: 'novel-chapter',
        estimatedSections: 2,
        reason: 'two chapters of bedtime prose explicitly requested',
      }),
    );
    const registry = new LLMProviderRegistry();
    registry.register(primary);
    registry.register(verifier);

    const goal = 'ช่วยเขียนนิยายก่อนนอน สำหรับกล่อมลูกนอนให้สัก2บท';
    const result = await resolveIntent(makeInput(goal), {
      registry,
      understanding: makeUnderstanding({ rawGoal: goal }),
    } satisfies IntentResolverDeps);

    expect(result.strategy).toBe('agentic-workflow');
    expect(result.reasoningSource).toBe('verifier');
    expect(result.workflowPrompt).toBeDefined();
    expect(result.workflowPrompt!).toContain('นิยาย');
    expect(result.workflowPrompt!).toContain('novel-chapter');
    // Confidence is clamped up to reflect the verifier's narrow-question reliability.
    expect(result.confidence).toBeGreaterThanOrEqual(0.7);
    expect(result.reasoning).toContain('verifier override');
  });

  it('preserves conversational verdict when verifier says NOT a deliverable', async () => {
    // Even though the goal contains "นิยาย", the verifier (separate LLM,
    // narrower question) rules it out — primary verdict survives. This is
    // the safety net against false-positive verifier triggers.
    const primary = stubProvider(
      'balanced',
      JSON.stringify({
        strategy: 'conversational',
        refinedGoal: 'นิยายเว็บตูนคืออะไร',
        reasoning: 'definition request',
        confidence: 0.6,
      }),
    );
    const verifier = stubProvider(
      'fast',
      JSON.stringify({
        isDeliverable: false,
        reason: 'definition question, single-paragraph answer suffices',
      }),
    );
    const registry = new LLMProviderRegistry();
    registry.register(primary);
    registry.register(verifier);

    // Goal that triggers the deliverable regex (mentions "เขียนนิยาย") but
    // is structurally a question — the verifier catches this.
    const goal = 'อยากรู้ว่าการเขียนนิยายแบบเว็บตูนต้องเริ่มจากตรงไหนดี';
    const result = await resolveIntent(makeInput(goal), {
      registry,
      understanding: makeUnderstanding({ rawGoal: goal }),
    } satisfies IntentResolverDeps);

    expect(result.strategy).toBe('conversational');
    expect(result.reasoningSource).not.toBe('verifier');
  });

  it('does NOT invoke verifier on plain greetings (no deliverable signal)', async () => {
    // Tracks whether the verifier provider was called by counting invocations.
    let verifierCalls = 0;
    const verifier: LLMProvider = {
      id: 'stub/fast',
      tier: 'fast',
      async generate() {
        verifierCalls += 1;
        return {
          content: '{"isDeliverable":false,"reason":"unused"}',
          toolCalls: [],
          tokensUsed: { input: 0, output: 0 },
          model: 'stub/fast',
          stopReason: 'end_turn',
        };
      },
    };
    const primary = stubProvider(
      'balanced',
      JSON.stringify({
        strategy: 'conversational',
        refinedGoal: 'สวัสดี',
        reasoning: 'greeting',
        confidence: 0.95,
      }),
    );
    const registry = new LLMProviderRegistry();
    registry.register(primary);
    registry.register(verifier);

    const result = await resolveIntent(makeInput('สวัสดีครับ'), {
      registry,
      understanding: makeUnderstanding({ rawGoal: 'สวัสดีครับ', taskDomain: 'conversational' }),
    } satisfies IntentResolverDeps);

    expect(result.strategy).toBe('conversational');
    expect(verifierCalls).toBe(0); // no extra LLM cost on baseline conversational traffic
  });
});

describe('intent resolver — short-affirmative continuation fix', () => {
  it('routes "จัดการให้เลย" to agentic-workflow with reconstructed prompt, no LLM call', async () => {
    // Throwing provider — proves the LLM is NEVER called on the short-affirmative path.
    const throwingPrimary: LLMProvider = {
      id: 'should-not-be-called',
      tier: 'balanced',
      async generate() {
        throw new Error('LLM should not be called when short-affirmative pre-classifier matches');
      },
    };
    const registry = new LLMProviderRegistry();
    registry.register(throwingPrimary);

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
    expect(result.confidence).toBeGreaterThanOrEqual(0.8);
  });
});
