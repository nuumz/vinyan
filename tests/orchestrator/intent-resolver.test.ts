/**
 * Tests for Intent Resolver — LLM-powered semantic intent classification.
 */
import { describe, expect, test } from 'bun:test';
import { resolveIntent, fallbackStrategy, type IntentResolverDeps } from '../../src/orchestrator/intent-resolver.ts';
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

  test('respects timeout', { timeout: 15000 }, async () => {
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
  });
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

  test('general-reasoning + execute + no tools → full-pipeline (safe default)', () => {
    expect(fallbackStrategy('general-reasoning', 'execute', 'none')).toBe('full-pipeline');
  });
});
