/**
 * Tests for Intent Resolver — LLM-powered semantic intent classification.
 */
import { describe, expect, test } from 'bun:test';
import {
  resolveIntent,
  fallbackStrategy,
  heuristicCreativePreFilter,
  hasCreativeCues,
  type IntentResolverDeps,
} from '../../src/orchestrator/intent-resolver.ts';
import { LLMProviderRegistry } from '../../src/orchestrator/llm/provider-registry.ts';
import type { LLMProvider, LLMRequest, LLMResponse, TaskInput } from '../../src/orchestrator/types.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeProvider(responseContent: string): LLMProvider {
  return {
    id: 'test-fast',
    tier: 'fast',
    async generate(_req: LLMRequest): Promise<LLMResponse> {
      return {
        content: responseContent,
        toolCalls: [],
        tokensUsed: { input: 50, output: 50 },
        model: 'test-fast',
        stopReason: 'end_turn',
      };
    },
  };
}

function makeRegistry(provider?: LLMProvider): LLMProviderRegistry {
  const reg = new LLMProviderRegistry();
  if (provider) reg.register(provider);
  return reg;
}

function makeInput(goal: string, overrides?: Partial<TaskInput>): TaskInput {
  return {
    id: 'test-1',
    source: 'cli',
    goal,
    taskType: 'reasoning',
    budget: { maxTokens: 4000, maxDurationMs: 30000, maxRetries: 1 },
    ...overrides,
  };
}

function makeDeps(provider?: LLMProvider): IntentResolverDeps {
  return {
    registry: makeRegistry(provider),
  };
}

// ---------------------------------------------------------------------------
// resolveIntent
// ---------------------------------------------------------------------------

describe('resolveIntent', () => {
  test('classifies conversational intent from LLM response', async () => {
    const provider = makeProvider(JSON.stringify({
      strategy: 'conversational',
      refinedGoal: 'สวัสดี ผู้ใช้ทักทาย',
      reasoning: 'User is greeting, no task to execute.',
      confidence: 0.95,
    }));
    const result = await resolveIntent(makeInput('สวัสดี'), makeDeps(provider));

    expect(result.strategy).toBe('conversational');
    expect(result.confidence).toBe(0.95);
    expect(result.refinedGoal).toBe('สวัสดี ผู้ใช้ทักทาย');
  });

  test('classifies direct-tool with tool call details', async () => {
    const provider = makeProvider(JSON.stringify({
      strategy: 'direct-tool',
      refinedGoal: 'Open Google Chrome application',
      reasoning: 'User wants to open an application — single shell_exec call.',
      directToolCall: { tool: 'shell_exec', parameters: { command: 'open -a "Google Chrome"' } },
      confidence: 0.9,
    }));
    const result = await resolveIntent(
      makeInput('อยากให้เปิดแอพ google chrome ให้เลย'),
      makeDeps(provider),
    );

    expect(result.strategy).toBe('direct-tool');
    expect(result.directToolCall).toBeDefined();
    expect(result.directToolCall!.tool).toBe('shell_exec');
    expect(result.directToolCall!.parameters.command).toBe('open -a "Google Chrome"');
  });

  test('retries with balanced provider when fast provider emits a chained cross-platform command', async () => {
    const expectedCommand = process.platform === 'darwin'
      ? 'open https://mail.google.com/'
      : process.platform === 'win32'
        ? 'start "" https://mail.google.com/'
        : 'xdg-open https://mail.google.com/';
    let fastCalls = 0;
    let balancedCalls = 0;
    const fastProvider: LLMProvider = {
      id: 'test-tool-uses',
      tier: 'tool-uses',
      async generate(_req: LLMRequest): Promise<LLMResponse> {
        fastCalls++;
        return {
          content: JSON.stringify({
            strategy: 'direct-tool',
            refinedGoal: 'เปิดแอพพลิเคชัน Gmail',
            reasoning: 'User wants to open Gmail app — a single fire-and-forget action with no textual output expected; the side-effect (app opening) is the entire goal.',
            directToolCall: {
              tool: 'shell_exec',
              parameters: {
                command: 'open -a Gmail || gmail || xdg-open https://mail.google.com/',
              },
            },
            confidence: 0.8,
          }),
          toolCalls: [],
          tokensUsed: { input: 50, output: 50 },
          model: 'test-tool-uses',
          stopReason: 'end_turn',
        };
      },
    };
    const balancedProvider: LLMProvider = {
      id: 'test-balanced',
      tier: 'balanced',
      async generate(_req: LLMRequest): Promise<LLMResponse> {
        balancedCalls++;
        return {
          content: JSON.stringify({
            strategy: 'direct-tool',
            refinedGoal: 'เปิด Gmail ในเบราว์เซอร์',
            reasoning: 'Gmail is primarily a web service, so the canonical URL is the correct direct action.',
            directToolCall: {
              tool: 'shell_exec',
              parameters: {
                command: expectedCommand,
              },
            },
            confidence: 0.95,
          }),
          toolCalls: [],
          tokensUsed: { input: 50, output: 50 },
          model: 'test-balanced',
          stopReason: 'end_turn',
        };
      },
    };

    const registry = new LLMProviderRegistry();
    registry.register(fastProvider);
    registry.register(balancedProvider);

    const result = await resolveIntent(makeInput('เปิดแอพ gmail'), { registry, availableTools: ['shell_exec'] });

    expect(result.strategy).toBe('direct-tool');
    expect(result.directToolCall).toBeDefined();
    expect(result.directToolCall!.tool).toBe('shell_exec');
    expect(result.directToolCall!.parameters.command).toBe(expectedCommand);
    expect(fastCalls).toBe(1);
    expect(balancedCalls).toBe(1);
  });

  test('classifies agentic-workflow with workflow prompt', async () => {
    const provider = makeProvider(JSON.stringify({
      strategy: 'agentic-workflow',
      refinedGoal: 'Refactor auth module and deploy',
      reasoning: 'Multi-step task requiring planning: refactor then deploy.',
      workflowPrompt: 'Step 1: Identify auth module files. Step 2: Refactor to use JWT. Step 3: Run tests. Step 4: Deploy to staging.',
      confidence: 0.85,
    }));
    const result = await resolveIntent(
      makeInput('ช่วย refactor auth module แล้ว deploy ให้ด้วย'),
      makeDeps(provider),
    );

    expect(result.strategy).toBe('agentic-workflow');
    expect(result.workflowPrompt).toContain('Step 1');
    expect(result.workflowPrompt).toContain('Step 4');
  });

  test('classifies full-pipeline for code modification', async () => {
    const provider = makeProvider(JSON.stringify({
      strategy: 'full-pipeline',
      refinedGoal: 'Fix type error in src/foo.ts',
      reasoning: 'Code modification task with specific file target.',
      confidence: 0.92,
    }));
    const result = await resolveIntent(
      makeInput('fix type error in src/foo.ts', { targetFiles: ['src/foo.ts'] }),
      makeDeps(provider),
    );

    expect(result.strategy).toBe('full-pipeline');
  });

  test('defaults confidence to 0.8 when LLM omits it', async () => {
    const provider = makeProvider(JSON.stringify({
      strategy: 'conversational',
      refinedGoal: 'Hello',
      reasoning: 'Greeting.',
    }));
    const result = await resolveIntent(makeInput('hello'), makeDeps(provider));

    expect(result.confidence).toBe(0.8);
  });

  test('handles markdown-fenced JSON response', async () => {
    const provider = makeProvider('```json\n' + JSON.stringify({
      strategy: 'conversational',
      refinedGoal: 'Hi',
      reasoning: 'Greeting.',
    }) + '\n```');
    const result = await resolveIntent(makeInput('hi'), makeDeps(provider));

    expect(result.strategy).toBe('conversational');
  });

  test('throws when no provider is available', async () => {
    const emptyRegistry = makeRegistry();

    await expect(resolveIntent(makeInput('hello'), { registry: emptyRegistry }))
      .rejects.toThrow('No LLM provider available');
  });

  test('throws on invalid JSON from LLM', async () => {
    const provider = makeProvider('This is not JSON at all');

    await expect(resolveIntent(makeInput('hello'), makeDeps(provider)))
      .rejects.toThrow();
  });

  test('throws on invalid strategy value from LLM', async () => {
    const provider = makeProvider(JSON.stringify({
      strategy: 'invalid-strategy',
      refinedGoal: 'Test',
      reasoning: 'Test.',
    }));

    await expect(resolveIntent(makeInput('hello'), makeDeps(provider)))
      .rejects.toThrow();
  });

  test('respects timeout', async () => {
    const slowProvider: LLMProvider = {
      id: 'slow-provider',
      tier: 'fast',
      async generate(_req: LLMRequest): Promise<LLMResponse> {
        await new Promise((resolve) => setTimeout(resolve, 15000));
        return {
          content: JSON.stringify({ strategy: 'conversational', refinedGoal: 'hi', reasoning: 'x' }),
          toolCalls: [],
          tokensUsed: { input: 10, output: 10 },
          model: 'slow',
          stopReason: 'end_turn',
        };
      },
    };

    await expect(resolveIntent(makeInput('hello'), makeDeps(slowProvider)))
      .rejects.toThrow('Intent resolution timeout');
  }, 15000);
});

// ---------------------------------------------------------------------------
// fallbackStrategy
// ---------------------------------------------------------------------------

describe('fallbackStrategy', () => {
  test('conversational domain → conversational', () => {
    expect(fallbackStrategy('conversational', 'converse', 'none')).toBe('conversational');
  });

  test('general-reasoning + inquire → conversational', () => {
    expect(fallbackStrategy('general-reasoning', 'inquire', 'none')).toBe('conversational');
  });

  test('execute + tool-needed + non-code domain → direct-tool', () => {
    expect(fallbackStrategy('general-reasoning', 'execute', 'tool-needed')).toBe('direct-tool');
  });

  test('code-mutation always → full-pipeline', () => {
    expect(fallbackStrategy('code-mutation', 'execute', 'tool-needed')).toBe('full-pipeline');
  });

  test('code-reasoning + inquire → full-pipeline (not conversational due to code domain)', () => {
    expect(fallbackStrategy('code-reasoning', 'inquire', 'none')).toBe('full-pipeline');
  });

  test('general-reasoning + execute + no tools → agentic-workflow (creative/generative tasks)', () => {
    expect(fallbackStrategy('general-reasoning', 'execute', 'none')).toBe('agentic-workflow');
  });
});

// ---------------------------------------------------------------------------
// heuristicCreativePreFilter
// ---------------------------------------------------------------------------

describe('heuristicCreativePreFilter', () => {
  test('matches Thai request to write a webtoon novel (the original bug)', () => {
    const result = heuristicCreativePreFilter('อยากให้ช่วยเขียนนิยายลงขายในเว็บตูนสักเรื่อง');
    expect(result.matched).toBe(true);
    expect(result.strategy).toBe('agentic-workflow');
    expect(result.matchedPattern).toBe('creative-th');
  });

  test('matches Thai request to write an article', () => {
    const result = heuristicCreativePreFilter('ช่วยเขียนบทความเกี่ยวกับ AI สักหัวข้อ');
    expect(result.matched).toBe(true);
    expect(result.strategy).toBe('agentic-workflow');
  });

  test('matches Thai request to produce a TikTok clip content', () => {
    const result = heuristicCreativePreFilter('อยากทำคลิปสยองขวัญ');
    expect(result.matched).toBe(true);
    expect(result.strategy).toBe('agentic-workflow');
  });

  test('matches English request to write a webtoon novel', () => {
    const result = heuristicCreativePreFilter('help me write a webtoon novel');
    expect(result.matched).toBe(true);
    expect(result.strategy).toBe('agentic-workflow');
    expect(result.matchedPattern).toBe('creative-en');
  });

  test('matches English request to draft a blog post', () => {
    const result = heuristicCreativePreFilter('draft a blog post about rust performance');
    expect(result.matched).toBe(true);
    expect(result.strategy).toBe('agentic-workflow');
  });

  test('does NOT match a greeting', () => {
    expect(heuristicCreativePreFilter('สวัสดี').matched).toBe(false);
    expect(heuristicCreativePreFilter('hi there').matched).toBe(false);
  });

  test('does NOT match a question-about-a-topic (negation keywords)', () => {
    expect(heuristicCreativePreFilter('นิยายคืออะไร').matched).toBe(false);
    expect(heuristicCreativePreFilter('แค่อยากรู้ว่านิยายเว็บตูนต่างจากนิยายทั่วไปยังไง').matched).toBe(false);
    expect(heuristicCreativePreFilter('what is a webtoon').matched).toBe(false);
    expect(heuristicCreativePreFilter("what's a novel?").matched).toBe(false);
    expect(heuristicCreativePreFilter('explain what a blog post is').matched).toBe(false);
  });

  test('does NOT match a code bug fix request', () => {
    expect(heuristicCreativePreFilter('fix type error in src/foo.ts').matched).toBe(false);
    expect(heuristicCreativePreFilter('แก้ bug ใน auth.ts').matched).toBe(false);
  });

  test('does NOT match very short input', () => {
    expect(heuristicCreativePreFilter('hi').matched).toBe(false);
    expect(heuristicCreativePreFilter('').matched).toBe(false);
  });

  test('hasCreativeCues detects loose creative verbs without needing object match', () => {
    expect(hasCreativeCues('ช่วยเขียนต่อหน่อย')).toBe(true);
    expect(hasCreativeCues('can you compose something for me')).toBe(true);
    expect(hasCreativeCues('fix the bug in foo.ts')).toBe(false);
    expect(hasCreativeCues('สวัสดี')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// resolveIntent — heuristic short-circuit path
// ---------------------------------------------------------------------------

describe('resolveIntent (heuristic pre-filter)', () => {
  test('short-circuits to agentic-workflow without calling the LLM for webtoon novel request', async () => {
    let providerCalls = 0;
    const provider: LLMProvider = {
      id: 'test-fast',
      tier: 'fast',
      async generate(_req: LLMRequest): Promise<LLMResponse> {
        providerCalls++;
        return {
          content: JSON.stringify({
            strategy: 'conversational',
            refinedGoal: 'fake',
            reasoning: 'should not be used',
          }),
          toolCalls: [],
          tokensUsed: { input: 1, output: 1 },
          model: 'test-fast',
          stopReason: 'end_turn',
        };
      },
    };
    const result = await resolveIntent(
      makeInput('อยากให้ช่วยเขียนนิยายลงขายในเว็บตูนสักเรื่อง'),
      makeDeps(provider),
    );
    expect(result.strategy).toBe('agentic-workflow');
    expect(result.reasoningSource).toBe('heuristic');
    expect(result.confidence).toBe(0.9);
    expect(result.reasoning).toContain('heuristic-creative-th');
    expect(providerCalls).toBe(0);
  });

  test('short-circuits without a provider registered (heuristic path is LLM-free)', async () => {
    const emptyRegistry = makeRegistry();
    const result = await resolveIntent(
      makeInput('help me write a webtoon novel'),
      { registry: emptyRegistry },
    );
    expect(result.strategy).toBe('agentic-workflow');
    expect(result.reasoningSource).toBe('heuristic');
  });

  test('non-creative goal falls through to LLM and reasoningSource is "llm"', async () => {
    const provider = makeProvider(JSON.stringify({
      strategy: 'conversational',
      refinedGoal: 'hello',
      reasoning: 'Greeting.',
      confidence: 0.95,
    }));
    const result = await resolveIntent(makeInput('hello'), makeDeps(provider));
    expect(result.strategy).toBe('conversational');
    expect(result.reasoningSource).toBe('llm');
  });

  test('question-about-topic is NOT short-circuited (lets LLM decide)', async () => {
    let providerCalls = 0;
    const provider: LLMProvider = {
      id: 'test-fast',
      tier: 'fast',
      async generate(_req: LLMRequest): Promise<LLMResponse> {
        providerCalls++;
        return {
          content: JSON.stringify({
            strategy: 'conversational',
            refinedGoal: 'Explain what a webtoon is',
            reasoning: 'Informational question.',
            confidence: 0.9,
          }),
          toolCalls: [],
          tokensUsed: { input: 50, output: 50 },
          model: 'test-fast',
          stopReason: 'end_turn',
        };
      },
    };
    const result = await resolveIntent(
      makeInput('นิยายเว็บตูนคืออะไร'),
      makeDeps(provider),
    );
    expect(result.strategy).toBe('conversational');
    expect(result.reasoningSource).toBe('llm');
    expect(providerCalls).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// resolveIntent — user-context injection
// ---------------------------------------------------------------------------

describe('resolveIntent (user-context injection)', () => {
  test('injects User context block into the LLM user prompt when a miner is provided', async () => {
    let capturedUserPrompt = '';
    const provider: LLMProvider = {
      id: 'test-fast',
      tier: 'fast',
      async generate(req: LLMRequest): Promise<LLMResponse> {
        capturedUserPrompt = req.userPrompt;
        return {
          content: JSON.stringify({
            strategy: 'conversational',
            refinedGoal: 'ack',
            reasoning: 'generic',
            confidence: 0.95,
          }),
          toolCalls: [],
          tokensUsed: { input: 1, output: 1 },
          model: 'test-fast',
          stopReason: 'end_turn',
        };
      },
    };
    const { UserInterestMiner } = await import('../../src/orchestrator/user-context/user-interest-miner.ts');
    const miner = new UserInterestMiner({
      traceStore: {
        findRecent: () => [
          {
            id: 't1',
            taskId: 't1',
            timestamp: Date.now() - 1000,
            routingLevel: 1 as const,
            approach: 'x',
            oracleVerdicts: {},
            modelUsed: 'mock',
            tokensConsumed: 0,
            durationMs: 0,
            outcome: 'success' as const,
            affectedFiles: [],
            taskTypeSignature: 'write::novel::long',
          },
        ],
      } as never,
    });

    await resolveIntent(
      makeInput('ทักทายหน่อย', { sessionId: 's1' }),
      {
        registry: makeRegistry(provider),
        userInterestMiner: miner,
        sessionId: 's1',
      },
    );

    expect(capturedUserPrompt).toContain('User context (learned from past activity)');
    expect(capturedUserPrompt).toContain('write::novel::long');
    expect(capturedUserPrompt).toContain('creative-writing');
  });

  test('omits User context block when miner is absent', async () => {
    let capturedUserPrompt = '';
    const provider: LLMProvider = {
      id: 'test-fast',
      tier: 'fast',
      async generate(req: LLMRequest): Promise<LLMResponse> {
        capturedUserPrompt = req.userPrompt;
        return {
          content: JSON.stringify({
            strategy: 'conversational',
            refinedGoal: 'ack',
            reasoning: 'generic',
            confidence: 0.95,
          }),
          toolCalls: [],
          tokensUsed: { input: 1, output: 1 },
          model: 'test-fast',
          stopReason: 'end_turn',
        };
      },
    };
    await resolveIntent(makeInput('hello'), makeDeps(provider));
    expect(capturedUserPrompt).not.toContain('User context');
  });
});

// ---------------------------------------------------------------------------
// resolveIntent — confidence escalation with creative cues
// ---------------------------------------------------------------------------

describe('resolveIntent (creative-cue escalation)', () => {
  test('lowers escalation threshold to 0.65 for goals with creative cues', async () => {
    // Ambiguous Thai goal: creative cue ("ช่วยเล่า") but no explicit deliverable noun,
    // so the heuristic pre-filter does NOT match. We want the LLM escalation
    // threshold to still catch a low-confidence conversational classification.
    let fastCalls = 0;
    let balancedCalls = 0;
    const fastProvider: LLMProvider = {
      id: 'test-fast',
      tier: 'fast',
      async generate(_req: LLMRequest): Promise<LLMResponse> {
        fastCalls++;
        return {
          content: JSON.stringify({
            strategy: 'conversational',
            refinedGoal: 'User wants a short story continuation',
            reasoning: 'Could be conversational continuation.',
            confidence: 0.7, // between 0.65 and 0.75 — only escalates with creative cue
          }),
          toolCalls: [],
          tokensUsed: { input: 50, output: 50 },
          model: 'test-fast',
          stopReason: 'end_turn',
        };
      },
    };
    const balancedProvider: LLMProvider = {
      id: 'test-balanced',
      tier: 'balanced',
      async generate(_req: LLMRequest): Promise<LLMResponse> {
        balancedCalls++;
        return {
          content: JSON.stringify({
            strategy: 'agentic-workflow',
            refinedGoal: 'Continue the user\'s ongoing creative piece',
            reasoning: 'Creative continuation needs planning.',
            workflowPrompt: 'Step 1: review context...',
            confidence: 0.85,
          }),
          toolCalls: [],
          tokensUsed: { input: 50, output: 50 },
          model: 'test-balanced',
          stopReason: 'end_turn',
        };
      },
    };

    const registry = new LLMProviderRegistry();
    registry.register(fastProvider);
    registry.register(balancedProvider);

    // Goal with creative cue but no deliverable object noun → heuristic does NOT match.
    // fast tier returns conversational with 0.7 confidence → should escalate (creative threshold 0.65).
    const result = await resolveIntent(
      makeInput('ช่วยเรียบเรียงต่อจากที่คุยกันนะ เผื่อจะลงคอลัมน์ได้'),
      { registry },
    );

    expect(result.strategy).toBe('agentic-workflow');
    expect(result.reasoning).toContain('escalated from low-confidence conversational');
    expect(fastCalls).toBe(1);
    expect(balancedCalls).toBe(1);
  });
});
