/**
 * OpenRouter provider — broadcast/trace data wiring.
 *
 * Verifies that ambient `runWithLLMTrace(...)` context and per-request
 * overrides land on the outbound HTTP payload as `session_id`, `user`,
 * `trace`, plus the `x-session-id` header. See
 * https://openrouter.ai/docs/guides/features/broadcast/overview.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { runWithLLMTrace } from '../../../src/orchestrator/llm/llm-trace-context.ts';
import { createOpenRouterProvider } from '../../../src/orchestrator/llm/openrouter-provider.ts';
import type { LLMRequest } from '../../../src/orchestrator/types.ts';

interface CapturedCall {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

function installFetchSpy(): {
  calls: CapturedCall[];
  restore: () => void;
} {
  const calls: CapturedCall[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const headers: Record<string, string> = {};
    const rawHeaders = init?.headers;
    if (rawHeaders) {
      if (rawHeaders instanceof Headers) {
        rawHeaders.forEach((v, k) => {
          headers[k.toLowerCase()] = v;
        });
      } else if (Array.isArray(rawHeaders)) {
        for (const entry of rawHeaders) {
          const [k, v] = entry;
          if (k && typeof v === 'string') headers[k.toLowerCase()] = v;
        }
      } else {
        for (const [k, v] of Object.entries(rawHeaders as Record<string, string>)) {
          headers[k.toLowerCase()] = v;
        }
      }
    }
    const body = JSON.parse((init?.body as string) ?? '{}') as Record<string, unknown>;
    calls.push({ url, headers, body });

    const responsePayload = {
      choices: [{ message: { content: 'ok', tool_calls: [] }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
      model: 'test-model',
    };
    return new Response(JSON.stringify(responsePayload), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof globalThis.fetch;

  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

const baseRequest = (): LLMRequest => ({
  systemPrompt: 'sys',
  userPrompt: 'usr',
  maxTokens: 16,
});

describe('OpenRouter provider — broadcast trace metadata', () => {
  let spy: ReturnType<typeof installFetchSpy>;

  beforeEach(() => {
    spy = installFetchSpy();
  });

  afterEach(() => {
    spy.restore();
  });

  it('omits trace fields when no ambient context is active', async () => {
    const provider = createOpenRouterProvider({ tier: 'fast', apiKey: 'sk-test' });
    expect(provider).not.toBeNull();
    await provider!.generate(baseRequest());

    expect(spy.calls).toHaveLength(1);
    const { body, headers } = spy.calls[0]!;
    expect(body.session_id).toBeUndefined();
    expect(body.user).toBeUndefined();
    expect(body.trace).toBeUndefined();
    expect(headers['x-session-id']).toBeUndefined();
  });

  it('attaches ambient session_id, user, trace_id, and x-session-id header', async () => {
    const provider = createOpenRouterProvider({ tier: 'fast', apiKey: 'sk-test' });
    await runWithLLMTrace(
      {
        sessionId: 'session_abc',
        userId: 'user_42',
        traceId: 'task_xyz',
        traceName: 'plan-phase',
        environment: 'test',
      },
      () => provider!.generate(baseRequest()),
    );

    const { body, headers } = spy.calls[0]!;
    expect(body.session_id).toBe('session_abc');
    expect(body.user).toBe('user_42');
    expect(headers['x-session-id']).toBe('session_abc');
    const trace = body.trace as Record<string, unknown>;
    expect(trace).toMatchObject({
      trace_id: 'task_xyz',
      trace_name: 'plan-phase',
      environment: 'test',
    });
  });

  it('lets per-request trace override ambient fields and merges extras', async () => {
    const provider = createOpenRouterProvider({ tier: 'fast', apiKey: 'sk-test' });
    await runWithLLMTrace(
      {
        sessionId: 'session_outer',
        traceId: 'trace_outer',
        extra: { feature: 'core-loop' },
      },
      () =>
        provider!.generate({
          ...baseRequest(),
          trace: {
            generationName: 'critic',
            extra: { phase: 'verify' },
          },
        }),
    );

    const { body } = spy.calls[0]!;
    expect(body.session_id).toBe('session_outer');
    const trace = body.trace as Record<string, unknown>;
    expect(trace.trace_id).toBe('trace_outer');
    expect(trace.generation_name).toBe('critic');
    // Extras merged from both layers.
    expect(trace.feature).toBe('core-loop');
    expect(trace.phase).toBe('verify');
  });

  it('clamps session_id and user to OpenRouter 128-char limit', async () => {
    const provider = createOpenRouterProvider({ tier: 'fast', apiKey: 'sk-test' });
    const longId = 'x'.repeat(200);
    await runWithLLMTrace({ sessionId: longId, userId: longId }, () => provider!.generate(baseRequest()));

    const { body, headers } = spy.calls[0]!;
    expect((body.session_id as string).length).toBe(128);
    expect((body.user as string).length).toBe(128);
    expect(headers['x-session-id']!.length).toBe(128);
  });
});
