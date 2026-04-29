/**
 * OpenRouter provider — `llm:retry_attempt` emission.
 *
 * Pins the Layer 2 contract for the delegate watchdog: when the provider
 * sleeps between retryable failures (429, 5xx, transient fetch errors),
 * it MUST emit `llm:retry_attempt` so external watchdogs (delegate
 * sub-agent watchdog, dashboards) can treat the silent backoff as live
 * activity. taskId is resolved via ambient `runWithLLMTrace` so the
 * provider does not need to know about workflow ids.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createBus } from '../../../src/core/bus.ts';
import { runWithLLMTrace } from '../../../src/orchestrator/llm/llm-trace-context.ts';
import { createOpenRouterProvider } from '../../../src/orchestrator/llm/openrouter-provider.ts';
import type { LLMRequest } from '../../../src/orchestrator/types.ts';

interface RetryAttemptEvent {
  taskId: string;
  providerId: string;
  attempt: number;
  delayMs: number;
  reason: string;
  status?: number;
}

function installFetchSpyWithThrottle(failures: number): {
  callCount: () => number;
  restore: () => void;
} {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    if (calls <= failures) {
      const body = JSON.stringify({ error: { message: 'rate limited' } });
      return new Response(body, {
        status: 429,
        headers: { 'content-type': 'application/json' },
      });
    }
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
    callCount: () => calls,
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

describe('OpenRouter provider — llm:retry_attempt emission', () => {
  let spy: ReturnType<typeof installFetchSpyWithThrottle>;

  afterEach(() => {
    spy?.restore();
  });

  it('emits llm:retry_attempt before each backoff sleep with ambient taskId', async () => {
    spy = installFetchSpyWithThrottle(2);
    const bus = createBus();
    const events: RetryAttemptEvent[] = [];
    bus.on('llm:retry_attempt', (e) => events.push(e as RetryAttemptEvent));

    const provider = createOpenRouterProvider({ tier: 'fast', apiKey: 'sk-test', bus });
    expect(provider).not.toBeNull();

    await runWithLLMTrace({ traceId: 'task_abc' }, () => provider!.generate(baseRequest()));

    // Two 429s → two backoff sleeps → two retry_attempt emits. Final
    // success does not emit (the success path does not call onAttempt).
    expect(events).toHaveLength(2);
    expect(events[0]?.taskId).toBe('task_abc');
    expect(events[0]?.providerId).toMatch(/openrouter\/fast/);
    expect(events[0]?.attempt).toBe(0);
    expect(events[0]?.delayMs).toBeGreaterThan(0);
    expect(events[0]?.status).toBe(429);
    expect(events[1]?.attempt).toBe(1);
    expect(spy.callCount()).toBe(3); // 2 failures + 1 success
  });

  it('suppresses emit when no taskId can be resolved (no ambient or explicit trace)', async () => {
    spy = installFetchSpyWithThrottle(1);
    const bus = createBus();
    const events: RetryAttemptEvent[] = [];
    bus.on('llm:retry_attempt', (e) => events.push(e as RetryAttemptEvent));

    const provider = createOpenRouterProvider({ tier: 'fast', apiKey: 'sk-test', bus });
    // No runWithLLMTrace wrapping — taskId resolution must fail and the
    // provider must NOT emit an orphan event with an empty correlation.
    await provider!.generate(baseRequest());

    expect(events).toHaveLength(0);
  });

  it('does not emit when bus is not provided (legacy / test construction)', async () => {
    spy = installFetchSpyWithThrottle(1);
    const provider = createOpenRouterProvider({ tier: 'fast', apiKey: 'sk-test' });

    // Just verify the call succeeds without crashing — there's no bus to
    // observe and the closure short-circuits at construction time.
    await runWithLLMTrace({ traceId: 'task_xyz' }, () => provider!.generate(baseRequest()));
    // spy still observed the calls; provider returned successfully.
    expect(spy.callCount()).toBeGreaterThan(0);
  });
});
