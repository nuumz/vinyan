/**
 * Tests for Intent Resolver — LLM-powered semantic intent classification.
 *
 * Post-redux (see plan vinyan-agent-intent-replicated-kite.md):
 *   - No regex-based heuristic pre-filter.
 *   - Provider tier preference: balanced > tool-uses > fast.
 *   - Deterministic structural features injected into the user prompt.
 *   - Few-shot canonical examples embedded in the system prompt.
 *   - Session-scoped goal cache with TTL.
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import {
  clearIntentResolverCache,
  computeStructuralFeatures,
  fallbackStrategy,
  intentResolverCacheSize,
  resolveIntent,
  type IntentResolverDeps,
} from '../../src/orchestrator/intent-resolver.ts';
import { LLMProviderRegistry } from '../../src/orchestrator/llm/provider-registry.ts';
import type { LLMProvider, LLMRequest, LLMResponse, TaskInput } from '../../src/orchestrator/types.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeProvider(responseContent: string, id = 'test-fast', tier: LLMProvider['tier'] = 'fast'): LLMProvider {
  return {
    id,
    tier,
    async generate(_req: LLMRequest): Promise<LLMResponse> {
      return {
        content: responseContent,
        toolCalls: [],
        tokensUsed: { input: 50, output: 50 },
        model: id,
        stopReason: 'end_turn',
      };
    },
  };
}

function makeRegistry(...providers: LLMProvider[]): LLMProviderRegistry {
  const reg = new LLMProviderRegistry();
  for (const p of providers) reg.register(p);
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

function makeDeps(provider?: LLMProvider, extra: Partial<IntentResolverDeps> = {}): IntentResolverDeps {
  return {
    registry: provider ? makeRegistry(provider) : new LLMProviderRegistry(),
    ...extra,
  };
}

// Cache is module-scoped — reset before each test for isolation.
beforeEach(() => {
  clearIntentResolverCache();
});

// ---------------------------------------------------------------------------
// resolveIntent — core classification (behaviour preserved from pre-redux)
// ---------------------------------------------------------------------------

describe('resolveIntent', () => {
  test('classifies conversational intent from LLM response', async () => {
    const provider = makeProvider(JSON.stringify({
      strategy: 'conversational',
      refinedGoal: 'สวัสดี ผู้ใช้ทักทาย',
      reasoning: 'User is greeting.',
      confidence: 0.95,
    }));
    const result = await resolveIntent(makeInput('สวัสดี'), makeDeps(provider));

    expect(result.strategy).toBe('conversational');
    expect(result.confidence).toBe(0.95);
    expect(result.refinedGoal).toBe('สวัสดี ผู้ใช้ทักทาย');
    expect(result.reasoningSource).toBe('llm');
  });

  test('classifies direct-tool with tool call details', async () => {
    const provider = makeProvider(JSON.stringify({
      strategy: 'direct-tool',
      refinedGoal: 'Open Google Chrome application',
      reasoning: 'Single shell_exec call.',
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

  test('classifies agentic-workflow with workflow prompt', async () => {
    const provider = makeProvider(JSON.stringify({
      strategy: 'agentic-workflow',
      refinedGoal: 'Refactor auth module and deploy',
      reasoning: 'Multi-step task requiring planning.',
      workflowPrompt: 'Step 1: Identify auth files. Step 2: Refactor. Step 3: Run tests. Step 4: Deploy.',
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
    const emptyRegistry = new LLMProviderRegistry();
    await expect(resolveIntent(makeInput('hello'), { registry: emptyRegistry }))
      .rejects.toThrow('No LLM provider available');
  });

  test('throws on invalid JSON when no alternate provider is available', async () => {
    const provider = makeProvider('This is not JSON at all');
    await expect(resolveIntent(makeInput('hello'), makeDeps(provider)))
      .rejects.toThrow();
  });

  test('throws on invalid strategy value when no alternate is available', async () => {
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
      id: 'slow',
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
// resolveIntent — provider tier preference
// ---------------------------------------------------------------------------

describe('resolveIntent (provider tier preference)', () => {
  test('prefers balanced tier when available', async () => {
    let fastCalls = 0;
    let balancedCalls = 0;
    const fast: LLMProvider = {
      id: 'p-fast',
      tier: 'fast',
      async generate(_req): Promise<LLMResponse> {
        fastCalls++;
        return {
          content: JSON.stringify({ strategy: 'conversational', refinedGoal: 'x', reasoning: 'x', confidence: 0.9 }),
          toolCalls: [], tokensUsed: { input: 10, output: 10 }, model: 'p-fast', stopReason: 'end_turn',
        };
      },
    };
    const balanced: LLMProvider = {
      id: 'p-balanced',
      tier: 'balanced',
      async generate(_req): Promise<LLMResponse> {
        balancedCalls++;
        return {
          content: JSON.stringify({ strategy: 'agentic-workflow', refinedGoal: 'x', reasoning: 'x', confidence: 0.9 }),
          toolCalls: [], tokensUsed: { input: 10, output: 10 }, model: 'p-balanced', stopReason: 'end_turn',
        };
      },
    };
    const registry = makeRegistry(fast, balanced);

    const result = await resolveIntent(makeInput('อยากให้ช่วยเขียนนิยาย'), { registry });
    expect(result.strategy).toBe('agentic-workflow');
    expect(balancedCalls).toBe(1);
    expect(fastCalls).toBe(0);
  });

  test('falls back to tool-uses when balanced is not registered', async () => {
    let fastCalls = 0;
    let toolUsesCalls = 0;
    const fast: LLMProvider = {
      id: 'p-fast',
      tier: 'fast',
      async generate(_req): Promise<LLMResponse> {
        fastCalls++;
        return {
          content: JSON.stringify({ strategy: 'conversational', refinedGoal: 'x', reasoning: 'x' }),
          toolCalls: [], tokensUsed: { input: 10, output: 10 }, model: 'p-fast', stopReason: 'end_turn',
        };
      },
    };
    const toolUses: LLMProvider = {
      id: 'p-tool-uses',
      tier: 'tool-uses',
      async generate(_req): Promise<LLMResponse> {
        toolUsesCalls++;
        return {
          content: JSON.stringify({ strategy: 'direct-tool', refinedGoal: 'x', reasoning: 'x', directToolCall: { tool: 'shell_exec', parameters: { command: 'echo hi' } } }),
          toolCalls: [], tokensUsed: { input: 10, output: 10 }, model: 'p-tool-uses', stopReason: 'end_turn',
        };
      },
    };
    const registry = makeRegistry(fast, toolUses);

    const result = await resolveIntent(makeInput('echo hi please'), { registry });
    expect(result.strategy).toBe('direct-tool');
    expect(toolUsesCalls).toBe(1);
    expect(fastCalls).toBe(0);
  });

  test('retries with alternate tier when primary emits a semantically invalid command chain', async () => {
    const expectedCommand =
      process.platform === 'darwin'
        ? 'open https://mail.google.com/'
        : process.platform === 'win32'
          ? 'start "" https://mail.google.com/'
          : 'xdg-open https://mail.google.com/';

    let balancedCalls = 0;
    let toolUsesCalls = 0;
    const balanced: LLMProvider = {
      id: 'p-balanced',
      tier: 'balanced',
      async generate(_req): Promise<LLMResponse> {
        balancedCalls++;
        return {
          content: JSON.stringify({
            strategy: 'direct-tool',
            refinedGoal: 'Open Gmail',
            reasoning: 'Single action.',
            directToolCall: {
              tool: 'shell_exec',
              parameters: { command: 'open -a Gmail || gmail || xdg-open https://mail.google.com/' },
            },
            confidence: 0.8,
          }),
          toolCalls: [], tokensUsed: { input: 50, output: 50 }, model: 'p-balanced', stopReason: 'end_turn',
        };
      },
    };
    const toolUses: LLMProvider = {
      id: 'p-tool-uses',
      tier: 'tool-uses',
      async generate(_req): Promise<LLMResponse> {
        toolUsesCalls++;
        return {
          content: JSON.stringify({
            strategy: 'direct-tool',
            refinedGoal: 'Open Gmail in browser',
            reasoning: 'Canonical URL.',
            directToolCall: { tool: 'shell_exec', parameters: { command: expectedCommand } },
            confidence: 0.95,
          }),
          toolCalls: [], tokensUsed: { input: 50, output: 50 }, model: 'p-tool-uses', stopReason: 'end_turn',
        };
      },
    };
    const registry = makeRegistry(balanced, toolUses);

    const result = await resolveIntent(makeInput('เปิดแอพ gmail'), { registry, availableTools: ['shell_exec'] });
    expect(result.strategy).toBe('direct-tool');
    expect(result.directToolCall!.parameters.command).toBe(expectedCommand);
    expect(balancedCalls).toBe(1);
    expect(toolUsesCalls).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// resolveIntent — structural features in the user prompt
// ---------------------------------------------------------------------------

describe('resolveIntent (structural features)', () => {
  test('renders length, question marker, and turn number into the user prompt', async () => {
    let captured = '';
    const provider: LLMProvider = {
      id: 'capture',
      tier: 'fast',
      async generate(req): Promise<LLMResponse> {
        captured = req.userPrompt;
        return {
          content: JSON.stringify({ strategy: 'conversational', refinedGoal: 'x', reasoning: 'x' }),
          toolCalls: [], tokensUsed: { input: 1, output: 1 }, model: 'capture', stopReason: 'end_turn',
        };
      },
    };
    await resolveIntent(makeInput('อยากให้ช่วยเขียนนิยายลงขายในเว็บตูนสักเรื่อง'), makeDeps(provider));

    expect(captured).toContain('Goal metadata (deterministic)');
    expect(captured).toMatch(/length=\d+ chars/);
    expect(captured).toContain('session turn: #1');
    expect(captured).toContain('ends with question marker:');
  });

  test('computeStructuralFeatures detects Thai question particles', () => {
    expect(computeStructuralFeatures('นิยายเว็บตูนคืออะไร').endsWithQuestion).toBe(false);
    expect(computeStructuralFeatures('เขียนนิยายได้ไหม').endsWithQuestion).toBe(true);
    expect(computeStructuralFeatures('ช่วยได้มั้ย').endsWithQuestion).toBe(true);
    expect(computeStructuralFeatures('ทำได้หรือเปล่า').endsWithQuestion).toBe(true);
  });

  test('computeStructuralFeatures recognises ASCII and full-width question marks', () => {
    expect(computeStructuralFeatures('is this a novel?').endsWithQuestion).toBe(true);
    // Full-width '？' (U+FF1F) is common in Thai/CJK IME input; the original
    // code had a duplicate ASCII '?' check which silently missed this case.
    expect(computeStructuralFeatures('เขียนนิยายได้ไหม？').endsWithQuestion).toBe(true);
    expect(computeStructuralFeatures('เขียนนิยายเรื่องใหม่').endsWithQuestion).toBe(false);
  });

  test('computeStructuralFeatures increments turn number from history length', () => {
    expect(computeStructuralFeatures('hi').turnNumber).toBe(1);
    expect(
      computeStructuralFeatures('hi', [
        {
          id: 'u1',
          sessionId: 's',
          seq: 0,
          role: 'user',
          blocks: [{ type: 'text', text: 'a' }],
          tokenCount: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
          createdAt: 0,
        },
        {
          id: 'a1',
          sessionId: 's',
          seq: 1,
          role: 'assistant',
          blocks: [{ type: 'text', text: 'b' }],
          tokenCount: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
          createdAt: 1,
        },
      ]).turnNumber,
    ).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// resolveIntent — few-shot canonical examples in the system prompt
// ---------------------------------------------------------------------------

describe('resolveIntent (canonical examples)', () => {
  test('system prompt includes the webtoon bug case and the false-positive guard', async () => {
    let capturedSystem = '';
    const provider: LLMProvider = {
      id: 'capture',
      tier: 'fast',
      async generate(req): Promise<LLMResponse> {
        capturedSystem = req.systemPrompt ?? '';
        return {
          content: JSON.stringify({ strategy: 'conversational', refinedGoal: 'x', reasoning: 'x' }),
          toolCalls: [], tokensUsed: { input: 1, output: 1 }, model: 'capture', stopReason: 'end_turn',
        };
      },
    };
    await resolveIntent(makeInput('anything'), makeDeps(provider));

    expect(capturedSystem).toContain('Canonical Examples');
    // Bug case that motivated the redux:
    expect(capturedSystem).toContain('อยากให้ช่วยเขียนนิยายลงขายในเว็บตูนสักเรื่อง');
    // False-positive guard for noun-collision optimization tasks:
    expect(capturedSystem).toContain('ทำให้เว็บตูนโหลดเร็วขึ้น');
    // Translation-as-long-form distinction:
    expect(capturedSystem).toContain('แปลนิยายเรื่องนี้เป็นอังกฤษ');
  });
});

// ---------------------------------------------------------------------------
// resolveIntent — session cache
// ---------------------------------------------------------------------------

describe('resolveIntent (cache)', () => {
  test('returns cached result for identical (session, goal) within TTL', async () => {
    let calls = 0;
    const provider: LLMProvider = {
      id: 'cached',
      tier: 'fast',
      async generate(_req): Promise<LLMResponse> {
        calls++;
        return {
          content: JSON.stringify({ strategy: 'conversational', refinedGoal: 'x', reasoning: 'x', confidence: 0.9 }),
          toolCalls: [], tokensUsed: { input: 1, output: 1 }, model: 'cached', stopReason: 'end_turn',
        };
      },
    };
    const deps: IntentResolverDeps = { registry: makeRegistry(provider), sessionId: 's1', now: () => 10_000 };
    await resolveIntent(makeInput('hi'), deps);
    const second = await resolveIntent(makeInput('hi'), deps);

    expect(calls).toBe(1);
    expect(second.reasoningSource).toBe('cache');
  });

  test('re-classifies after TTL expires', async () => {
    let calls = 0;
    const provider: LLMProvider = {
      id: 'cached',
      tier: 'fast',
      async generate(_req): Promise<LLMResponse> {
        calls++;
        return {
          content: JSON.stringify({ strategy: 'conversational', refinedGoal: 'x', reasoning: 'x' }),
          toolCalls: [], tokensUsed: { input: 1, output: 1 }, model: 'cached', stopReason: 'end_turn',
        };
      },
    };
    let clock = 10_000;
    const deps: IntentResolverDeps = {
      registry: makeRegistry(provider),
      sessionId: 's1',
      now: () => clock,
    };
    await resolveIntent(makeInput('hi'), deps);
    clock += 60_000; // past 30s TTL
    await resolveIntent(makeInput('hi'), deps);

    expect(calls).toBe(2);
  });

  test('cache does not collide across sessions', async () => {
    let calls = 0;
    const provider: LLMProvider = {
      id: 'cached',
      tier: 'fast',
      async generate(_req): Promise<LLMResponse> {
        calls++;
        return {
          content: JSON.stringify({ strategy: 'conversational', refinedGoal: 'x', reasoning: 'x' }),
          toolCalls: [], tokensUsed: { input: 1, output: 1 }, model: 'cached', stopReason: 'end_turn',
        };
      },
    };
    const registry = makeRegistry(provider);
    await resolveIntent(makeInput('hi'), { registry, sessionId: 's1' });
    await resolveIntent(makeInput('hi'), { registry, sessionId: 's2' });

    expect(calls).toBe(2);
  });

  test('prunes expired entries once the cache crosses the eviction threshold', async () => {
    const provider = makeProvider(JSON.stringify({
      strategy: 'conversational',
      refinedGoal: 'x',
      reasoning: 'x',
    }));
    const registry = makeRegistry(provider);
    let clock = 10_000;
    const deps = (): IntentResolverDeps => ({ registry, now: () => clock });

    // Fill past the prune threshold (64).
    for (let i = 0; i < 70; i++) {
      await resolveIntent(makeInput(`goal-${i}`), deps());
    }
    const sizeBeforeExpiry = intentResolverCacheSize();
    expect(sizeBeforeExpiry).toBeGreaterThanOrEqual(70);

    // Jump past the 30s TTL so every entry above is now expired.
    clock += 60_000;
    // One more resolve triggers pruneIntentCache() which drops the expired
    // 70 entries before writing the new one.
    await resolveIntent(makeInput('trigger-prune'), deps());

    // After pruning: all 70 expired entries are gone, only the new one remains.
    expect(intentResolverCacheSize()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// resolveIntent — user-context injection (Phase B integration)
// ---------------------------------------------------------------------------

describe('resolveIntent (user-context injection)', () => {
  test('injects User context block into the user prompt when a miner is provided', async () => {
    let captured = '';
    const provider: LLMProvider = {
      id: 'capture',
      tier: 'fast',
      async generate(req): Promise<LLMResponse> {
        captured = req.userPrompt;
        return {
          content: JSON.stringify({ strategy: 'conversational', refinedGoal: 'x', reasoning: 'x' }),
          toolCalls: [], tokensUsed: { input: 1, output: 1 }, model: 'capture', stopReason: 'end_turn',
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
      { registry: makeRegistry(provider), userInterestMiner: miner, sessionId: 's1' },
    );

    expect(captured).toContain('User context (learned from past activity)');
    expect(captured).toContain('creative-writing');
  });

  test('omits User context block when miner is absent', async () => {
    let captured = '';
    const provider: LLMProvider = {
      id: 'capture',
      tier: 'fast',
      async generate(req): Promise<LLMResponse> {
        captured = req.userPrompt;
        return {
          content: JSON.stringify({ strategy: 'conversational', refinedGoal: 'x', reasoning: 'x' }),
          toolCalls: [], tokensUsed: { input: 1, output: 1 }, model: 'capture', stopReason: 'end_turn',
        };
      },
    };
    await resolveIntent(makeInput('hello'), makeDeps(provider));
    expect(captured).not.toContain('User context');
  });
});

// ---------------------------------------------------------------------------
// resolveIntent — the original bug case (documentation-style regression test)
// ---------------------------------------------------------------------------

describe('resolveIntent (original bug case)', () => {
  test('webtoon novel request classifies as agentic-workflow when the LLM returns the correct label', async () => {
    // Post-redux: we trust the LLM (with canonical examples + balanced tier +
    // structural features) to produce the right label. This test verifies the
    // plumbing surfaces that label correctly.
    const provider = makeProvider(
      JSON.stringify({
        strategy: 'agentic-workflow',
        refinedGoal: 'Write a webtoon novel for publication',
        reasoning: 'Long-form creative deliverable (multi-chapter novel).',
        workflowPrompt: 'Plan genre → outline → chapter drafts.',
        confidence: 0.95,
      }),
      'p-balanced',
      'balanced',
    );
    const result = await resolveIntent(
      makeInput('อยากให้ช่วยเขียนนิยายลงขายในเว็บตูนสักเรื่อง'),
      makeDeps(provider),
    );

    expect(result.strategy).toBe('agentic-workflow');
    expect(result.reasoningSource).toBe('llm');
    expect(result.workflowPrompt).toContain('genre');
  });
});

// ---------------------------------------------------------------------------
// fallbackStrategy (regex-based fallback — still used by core-loop when the
// LLM is unavailable)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// resolveIntent — deterministic-first pipeline (tier 0.8, A5)
// ---------------------------------------------------------------------------

import {
  composeDeterministicCandidate,
  mapUnderstandingToStrategy,
} from '../../src/orchestrator/intent-resolver.ts';
import type { SemanticTaskUnderstanding } from '../../src/orchestrator/types.ts';
import { createBus } from '../../src/core/bus.ts';

function makeUnderstanding(
  input: TaskInput,
  overrides: Partial<SemanticTaskUnderstanding> = {},
): SemanticTaskUnderstanding {
  return {
    rawGoal: input.goal,
    actionVerb: 'do',
    actionCategory: 'analysis',
    frameworkContext: [],
    constraints: input.constraints ?? [],
    acceptanceCriteria: input.acceptanceCriteria ?? [],
    expectsMutation: false,
    taskDomain: 'general-reasoning',
    taskIntent: 'inquire',
    toolRequirement: 'none',
    resolvedEntities: [],
    understandingDepth: 1,
    verifiedClaims: [],
    understandingFingerprint: `fp-${input.goal.length}-${input.id}`,
    ...overrides,
  };
}

describe('mapUnderstandingToStrategy', () => {
  test('conversational domain → conversational at high confidence', () => {
    const u = makeUnderstanding(makeInput('สวัสดี'), { taskDomain: 'conversational', taskIntent: 'converse' });
    const r = mapUnderstandingToStrategy(u);
    expect(r.strategy).toBe('conversational');
    expect(r.confidence).toBeGreaterThanOrEqual(0.9);
    expect(r.ambiguous).toBe(false);
  });

  test('code-mutation with resolved entity → full-pipeline at high confidence', () => {
    const u = makeUnderstanding(makeInput('fix bug in foo', { targetFiles: ['src/foo.ts'] }), {
      taskDomain: 'code-mutation',
      taskIntent: 'execute',
      toolRequirement: 'tool-needed',
      resolvedEntities: [
        {
          reference: 'foo',
          resolvedPaths: ['src/foo.ts'],
          resolution: 'exact',
          confidence: 0.95,
          confidenceSource: 'evidence-derived',
        },
      ],
    });
    const r = mapUnderstandingToStrategy(u);
    expect(r.strategy).toBe('full-pipeline');
    expect(r.confidence).toBeGreaterThanOrEqual(0.85);
    expect(r.ambiguous).toBe(false);
  });

  test('creative-generation ambiguity lowers confidence', () => {
    const u = makeUnderstanding(makeInput('เขียนนิยายสักเรื่อง'), {
      taskDomain: 'general-reasoning',
      taskIntent: 'execute',
      toolRequirement: 'none',
    });
    const r = mapUnderstandingToStrategy(u);
    expect(r.ambiguous).toBe(true);
    expect(r.confidence).toBeLessThan(0.7);
  });

  test('file-token without resolver hit flags ambiguity', () => {
    const u = makeUnderstanding(makeInput('explain config.yaml to me'), {
      taskDomain: 'code-reasoning',
      taskIntent: 'inquire',
      toolRequirement: 'none',
      resolvedEntities: [],
    });
    const r = mapUnderstandingToStrategy(u);
    expect(r.ambiguous).toBe(true);
  });
});

describe('composeDeterministicCandidate', () => {
  test('direct-tool pattern produces resolved shell_exec command', () => {
    const input = makeInput('เปิดแอพ Google Chrome');
    const u = makeUnderstanding(input, {
      taskDomain: 'general-reasoning',
      taskIntent: 'execute',
      toolRequirement: 'tool-needed',
    });
    const candidate = composeDeterministicCandidate(input, u);
    expect(candidate.strategy).toBe('direct-tool');
    expect(candidate.directToolCall).toBeDefined();
    expect(candidate.directToolCall!.tool).toBe('shell_exec');
    expect(String(candidate.directToolCall!.parameters.command)).toContain('Google Chrome');
    expect(candidate.reasoningSource).toBe('deterministic');
    expect(candidate.confidence).toBeGreaterThanOrEqual(0.85);
  });

  test('ambiguous rule produces skeleton without directToolCall', () => {
    const input = makeInput('จัดการระบบให้หน่อย');
    const u = makeUnderstanding(input, {
      taskDomain: 'general-reasoning',
      taskIntent: 'execute',
      toolRequirement: 'none',
    });
    const candidate = composeDeterministicCandidate(input, u);
    expect(candidate.deterministicCandidate.ambiguous).toBe(true);
    expect(candidate.directToolCall).toBeUndefined();
    expect(candidate.type).toBe('uncertain');
  });

  test('inspection verb (Thai ตรวจสอบ) with tool-needed → full-pipeline, NOT direct-tool', () => {
    // Regression for session e8ab15a7: "ช่วยตรวจสอบการทำงานของ Vinyan" was
    // incorrectly routed to direct-tool (no resolvable command) causing an
    // A5 contradiction with the LLM. Inspection verbs want a textual report.
    const input = makeInput('ช่วยตรวจสอบการทำงานของ Vinyan');
    const u = makeUnderstanding(input, {
      taskDomain: 'general-reasoning',
      taskIntent: 'execute',
      toolRequirement: 'tool-needed',
    });
    const candidate = composeDeterministicCandidate(input, u);
    expect(candidate.strategy).toBe('full-pipeline');
    expect(candidate.directToolCall).toBeUndefined();
    expect(candidate.deterministicCandidate.ambiguous).toBe(true);
  });

  test('inspection verb (English check) with tool-needed → full-pipeline', () => {
    const input = makeInput('check git status and summarize');
    const u = makeUnderstanding(input, {
      taskDomain: 'general-reasoning',
      taskIntent: 'execute',
      toolRequirement: 'tool-needed',
    });
    const candidate = composeDeterministicCandidate(input, u);
    expect(candidate.strategy).toBe('full-pipeline');
    expect(candidate.directToolCall).toBeUndefined();
  });

  test('unresolvable direct-tool rule is demoted to full-pipeline (no hollow direct-tool)', () => {
    // STU says execute + tool-needed but the goal carries no recognizable
    // app/launch idiom, so classifyDirectTool returns null. The old code
    // would still emit strategy='direct-tool' with no directToolCall — an
    // empty artifact that then fights the LLM. Demote instead.
    const input = makeInput('ทำตามคำสั่งให้หน่อย');
    const u = makeUnderstanding(input, {
      taskDomain: 'general-reasoning',
      taskIntent: 'execute',
      toolRequirement: 'tool-needed',
    });
    const candidate = composeDeterministicCandidate(input, u);
    // Rule-mapper emits direct-tool, composer demotes to full-pipeline.
    expect(candidate.strategy).toBe('full-pipeline');
    expect(candidate.directToolCall).toBeUndefined();
    expect(candidate.type).toBe('uncertain');
  });
});

describe('resolveIntent (deterministic pipeline)', () => {
  test('high-confidence deterministic greeting skips the LLM entirely', async () => {
    let llmCalls = 0;
    const provider: LLMProvider = {
      id: 'should-not-fire',
      tier: 'balanced',
      async generate(_req): Promise<LLMResponse> {
        llmCalls++;
        return {
          content: JSON.stringify({ strategy: 'conversational', refinedGoal: 'x', reasoning: 'x' }),
          toolCalls: [], tokensUsed: { input: 1, output: 1 }, model: 'x', stopReason: 'end_turn',
        };
      },
    };
    const input = makeInput('สวัสดี');
    const understanding = makeUnderstanding(input, {
      taskDomain: 'conversational',
      taskIntent: 'converse',
      toolRequirement: 'none',
    });
    const result = await resolveIntent(input, { registry: makeRegistry(provider), understanding });

    expect(result.strategy).toBe('conversational');
    expect(result.type).toBe('known');
    expect(result.reasoningSource).toBe('deterministic');
    expect(llmCalls).toBe(0);
  });

  test('direct-tool app launch skips LLM and resolves platform command', async () => {
    let llmCalls = 0;
    const provider: LLMProvider = {
      id: 'llm',
      tier: 'balanced',
      async generate(_req): Promise<LLMResponse> {
        llmCalls++;
        return {
          content: JSON.stringify({ strategy: 'conversational', refinedGoal: 'x', reasoning: 'x' }),
          toolCalls: [], tokensUsed: { input: 1, output: 1 }, model: 'llm', stopReason: 'end_turn',
        };
      },
    };
    const input = makeInput('เปิดแอพ Safari');
    const understanding = makeUnderstanding(input, {
      taskDomain: 'general-reasoning',
      taskIntent: 'execute',
      toolRequirement: 'tool-needed',
    });
    const result = await resolveIntent(input, { registry: makeRegistry(provider), understanding });

    expect(result.strategy).toBe('direct-tool');
    expect(result.directToolCall).toBeDefined();
    expect(llmCalls).toBe(0);
  });

  test('disagreement → contradictory (A5: rule wins, event emitted)', async () => {
    const provider = makeProvider(
      JSON.stringify({
        strategy: 'direct-tool',
        refinedGoal: 'open a thing',
        reasoning: 'LLM thinks this is a direct tool call',
        directToolCall: { tool: 'shell_exec', parameters: { command: 'echo hi' } },
        confidence: 0.9,
      }),
      'p-balanced',
      'balanced',
    );
    const bus = createBus();
    let contradictionEvents = 0;
    bus.on('intent:contradiction', () => { contradictionEvents++; });

    const input = makeInput('analyze the codebase for performance bottlenecks');
    const understanding = makeUnderstanding(input, {
      // Rule: general-reasoning + inquire + no-tools → conversational (non-ambiguous)
      taskDomain: 'general-reasoning',
      taskIntent: 'inquire',
      toolRequirement: 'none',
    });
    const result = await resolveIntent(input, {
      registry: makeRegistry(provider),
      understanding,
      bus,
    });

    expect(result.type).toBe('contradictory');
    // A5: rule (conversational) beats LLM (direct-tool)
    expect(result.strategy).toBe('conversational');
    expect(result.clarificationRequest).toBeDefined();
    expect(contradictionEvents).toBe(1);
  });

  test('low LLM confidence → uncertain + clarification surfaced', async () => {
    const provider = makeProvider(
      JSON.stringify({
        strategy: 'agentic-workflow',
        refinedGoal: 'unclear ask',
        reasoning: 'Not sure what to do',
        confidence: 0.3,
      }),
      'p-balanced',
      'balanced',
    );
    const bus = createBus();
    let uncertainEvents = 0;
    bus.on('intent:uncertain', () => { uncertainEvents++; });

    const input = makeInput('จัดการเรื่องนี้ให้หน่อย');
    const understanding = makeUnderstanding(input, {
      taskDomain: 'general-reasoning',
      taskIntent: 'execute',
      toolRequirement: 'none',
    });
    const result = await resolveIntent(input, {
      registry: makeRegistry(provider),
      understanding,
      bus,
    });

    expect(result.type).toBe('uncertain');
    expect(result.clarificationRequest).toBeDefined();
    expect(uncertainEvents).toBe(1);
  });

  test('agreement → LLM enrichment accepted (workflowPrompt added)', async () => {
    const provider = makeProvider(
      JSON.stringify({
        strategy: 'agentic-workflow',
        refinedGoal: 'Refactor auth',
        reasoning: 'Multi-step refactor',
        workflowPrompt: 'Step 1: locate auth module. Step 2: extract interface. Step 3: run tests.',
        confidence: 0.9,
      }),
      'p-balanced',
      'balanced',
    );
    const input = makeInput('refactor the auth module carefully');
    const understanding = makeUnderstanding(input, {
      // Rule says agentic-workflow too (general-reasoning + execute + no tools)
      taskDomain: 'general-reasoning',
      taskIntent: 'execute',
      toolRequirement: 'none',
    });
    const result = await resolveIntent(input, {
      registry: makeRegistry(provider),
      understanding,
    });

    expect(result.strategy).toBe('agentic-workflow');
    expect(result.type).toBe('known');
    expect(result.workflowPrompt).toContain('Step 1');
    expect(result.reasoningSource).toBe('merged');
  });

  test('cache hit fires intent:cache_hit event and re-uses result', async () => {
    let llmCalls = 0;
    const provider: LLMProvider = {
      id: 'p-balanced',
      tier: 'balanced',
      async generate(_req): Promise<LLMResponse> {
        llmCalls++;
        return {
          content: JSON.stringify({
            strategy: 'agentic-workflow',
            refinedGoal: 'x',
            reasoning: 'x',
            workflowPrompt: 'step 1',
            confidence: 0.9,
          }),
          toolCalls: [], tokensUsed: { input: 1, output: 1 }, model: 'p-balanced', stopReason: 'end_turn',
        };
      },
    };
    const bus = createBus();
    let cacheHits = 0;
    bus.on('intent:cache_hit', () => { cacheHits++; });

    const input = makeInput('refactor the auth module carefully');
    const understanding = makeUnderstanding(input, {
      taskDomain: 'general-reasoning',
      taskIntent: 'execute',
      toolRequirement: 'none',
    });
    const deps: IntentResolverDeps = { registry: makeRegistry(provider), understanding, bus };
    await resolveIntent(input, deps);
    const second = await resolveIntent(input, deps);

    expect(llmCalls).toBe(1);
    expect(second.reasoningSource).toBe('cache');
    expect(cacheHits).toBe(1);
  });
});

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
