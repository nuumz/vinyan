/**
 * Anthropic provider — raw-fetch Messages API contract.
 *
 * Pins the wire shape after the SDK → fetch rewrite (P0 onboarding):
 * auth headers, request body, response mapping (text / thinking /
 * tool_use blocks, cache usage), SSE streaming accumulation, 429
 * retry, and 413 → PromptTooLargeError. Mirrors the fetch-spy harness
 * used by openrouter-retry-attempt.test.ts.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { createAnthropicProvider } from '../../../src/orchestrator/llm/anthropic-provider.ts';
import type { LLMRequest } from '../../../src/orchestrator/types.ts';
import { PromptTooLargeError } from '../../../src/orchestrator/types.ts';

interface CapturedCall {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

function installFetchSpy(responses: Array<() => Response>): {
  calls: CapturedCall[];
  restore: () => void;
} {
  const original = globalThis.fetch;
  const calls: CapturedCall[] = [];
  let index = 0;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(url),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
    });
    const make = responses[Math.min(index, responses.length - 1)];
    index++;
    if (!make) throw new Error('fetch spy exhausted');
    return make();
  }) as unknown as typeof globalThis.fetch;
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
  maxTokens: 64,
});

const successBody = {
  content: [
    { type: 'thinking', thinking: 'pondering' },
    { type: 'text', text: 'hello ' },
    { type: 'text', text: 'world' },
    { type: 'tool_use', id: 'tu_1', name: 'read_file', input: { path: 'a.ts' } },
  ],
  usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 3, cache_creation_input_tokens: 2 },
  model: 'claude-sonnet-4-6',
  stop_reason: 'tool_use',
};

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('Anthropic provider — raw fetch generate()', () => {
  let spy: ReturnType<typeof installFetchSpy>;

  afterEach(() => {
    spy?.restore();
  });

  it('sends x-api-key / anthropic-version headers and Messages API body', async () => {
    spy = installFetchSpy([() => jsonResponse(successBody)]);
    const provider = createAnthropicProvider({ apiKey: 'sk-ant-test', model: 'claude-sonnet-4-6' });
    expect(provider).not.toBeNull();
    expect(provider?.id).toBe('anthropic/claude-sonnet-4-6');

    await provider?.generate(baseRequest());

    const call = spy.calls[0];
    expect(call?.url).toBe('https://api.anthropic.com/v1/messages');
    expect(call?.headers['x-api-key']).toBe('sk-ant-test');
    expect(call?.headers['anthropic-version']).toBe('2023-06-01');
    expect(call?.body.model).toBe('claude-sonnet-4-6');
    expect(call?.body.max_tokens).toBe(64);
    expect(call?.body.system).toEqual([{ type: 'text', text: 'sys' }]);
    expect(call?.body.messages).toEqual([{ role: 'user', content: 'usr' }]);
    expect(call?.body.stream).toBeUndefined();
  });

  it('maps text / thinking / tool_use blocks and cache usage into LLMResponse', async () => {
    spy = installFetchSpy([() => jsonResponse(successBody)]);
    const provider = createAnthropicProvider({ apiKey: 'sk-ant-test', model: 'claude-sonnet-4-6' });

    const result = await provider?.generate(baseRequest());

    expect(result?.content).toBe('hello world');
    expect(result?.thinking).toBe('pondering');
    expect(result?.toolCalls).toEqual([{ id: 'tu_1', tool: 'read_file', parameters: { path: 'a.ts' } }]);
    expect(result?.tokensUsed).toEqual({ input: 10, output: 5, cacheRead: 3, cacheCreation: 2 });
    expect(result?.model).toBe('claude-sonnet-4-6');
    expect(result?.stopReason).toBe('tool_use');
  });

  it('retries a 429 and succeeds on the next attempt', async () => {
    spy = installFetchSpy([
      () => jsonResponse({ error: { message: 'rate limited' } }, 429),
      () => jsonResponse(successBody),
    ]);
    const provider = createAnthropicProvider({ apiKey: 'sk-ant-test', model: 'claude-sonnet-4-6' });

    const result = await provider?.generate(baseRequest());

    expect(spy.calls).toHaveLength(2);
    expect(result?.content).toBe('hello world');
  }, 10_000);

  it('throws PromptTooLargeError on 413 without retrying', async () => {
    spy = installFetchSpy([() => jsonResponse({ error: { message: 'request too large' } }, 413)]);
    const provider = createAnthropicProvider({ apiKey: 'sk-ant-test', model: 'claude-sonnet-4-6' });

    expect(provider?.generate(baseRequest())).rejects.toBeInstanceOf(PromptTooLargeError);
  });

  it('returns null when no API key is available (not an error)', () => {
    const saved = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      expect(createAnthropicProvider()).toBeNull();
    } finally {
      if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
    }
  });
});

describe('Anthropic provider — raw fetch generateStream()', () => {
  let spy: ReturnType<typeof installFetchSpy>;

  afterEach(() => {
    spy?.restore();
  });

  const sse = (events: Array<Record<string, unknown>>): Response => {
    const text = events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n`).join('\n');
    return new Response(text, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };

  it('accumulates text deltas, tool_use JSON fragments, and message_delta stop/usage', async () => {
    spy = installFetchSpy([
      () =>
        sse([
          {
            type: 'message_start',
            message: {
              model: 'claude-sonnet-4-6',
              usage: { input_tokens: 7, cache_read_input_tokens: 4, cache_creation_input_tokens: 1 },
            },
          },
          { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hel' } },
          { type: 'ping' },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'lo' } },
          { type: 'content_block_stop', index: 0 },
          {
            type: 'content_block_start',
            index: 1,
            content_block: { type: 'tool_use', id: 'tu_9', name: 'write_file' },
          },
          { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"path":' } },
          { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '"b.ts"}' } },
          { type: 'content_block_stop', index: 1 },
          { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 12 } },
          { type: 'message_stop' },
        ]),
    ]);
    const provider = createAnthropicProvider({ apiKey: 'sk-ant-test', model: 'claude-sonnet-4-6' });

    const deltas: string[] = [];
    const result = await provider?.generateStream?.(baseRequest(), (d) => deltas.push(d.text));

    expect(spy.calls[0]?.body.stream).toBe(true);
    expect(deltas).toEqual(['Hel', 'lo']);
    expect(result?.content).toBe('Hello');
    expect(result?.toolCalls).toEqual([{ id: 'tu_9', tool: 'write_file', parameters: { path: 'b.ts' } }]);
    expect(result?.tokensUsed).toEqual({ input: 7, output: 12, cacheRead: 4, cacheCreation: 1 });
    expect(result?.model).toBe('claude-sonnet-4-6');
    expect(result?.stopReason).toBe('tool_use');
  });

  it('joins thinking_delta fragments per block and surfaces them as thinking', async () => {
    spy = installFetchSpy([
      () =>
        sse([
          { type: 'message_start', message: { model: 'claude-sonnet-4-6', usage: { input_tokens: 3 } } },
          { type: 'content_block_start', index: 0, content_block: { type: 'thinking' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'step one, ' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'step two' } },
          { type: 'content_block_stop', index: 0 },
          { type: 'content_block_start', index: 1, content_block: { type: 'text' } },
          { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'done' } },
          { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 4 } },
          { type: 'message_stop' },
        ]),
    ]);
    const provider = createAnthropicProvider({ apiKey: 'sk-ant-test', model: 'claude-sonnet-4-6' });

    const result = await provider?.generateStream?.(baseRequest(), () => {});

    expect(result?.thinking).toBe('step one, step two');
    expect(result?.content).toBe('done');
    expect(result?.stopReason).toBe('end_turn');
  });
});
