/**
 * Tests for the thin typed Discord API wrapper.
 *
 * All tests inject a fake `fetch` — we never reach the real network.
 */

import { describe, expect, test } from 'bun:test';
import {
  DiscordApi,
  DiscordApiError,
  DISCORD_INTENT_BITS,
  computeIntents,
  type DiscordWebSocketCtor,
  type DiscordWebSocketLike,
} from '../../../src/gateway/adapters/discord-api.ts';

interface FetchCall {
  url: string;
  body: Record<string, unknown> | null;
  init: RequestInit;
}

function makeFetch(
  responder: (call: FetchCall) => { status?: number; json?: unknown; throws?: Error },
): { fetchImpl: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
    let body: Record<string, unknown> | null = null;
    if (init?.body) {
      try {
        body = JSON.parse(init.body as string) as Record<string, unknown>;
      } catch {
        body = null;
      }
    }
    const call: FetchCall = { url, body, init: init ?? {} };
    calls.push(call);
    const res = responder(call);
    if (res.throws) throw res.throws;
    const status = res.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => res.json,
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

class StubWs implements DiscordWebSocketLike {
  send(): void {}
  close(): void {}
  onopen = null;
  onmessage = null;
  onerror = null;
  onclose = null;
  readyState = 1;
}
const StubWsCtor = StubWs as unknown as DiscordWebSocketCtor;

describe('computeIntents', () => {
  test('ORs named intents into a bitmask', () => {
    const mask = computeIntents(['GUILDS', 'GUILD_MESSAGES']);
    const expected = (DISCORD_INTENT_BITS.GUILDS ?? 0) | (DISCORD_INTENT_BITS.GUILD_MESSAGES ?? 0);
    expect(mask).toBe(expected);
    expect(mask).toBeGreaterThan(0);
  });

  test('ignores unknown intent names', () => {
    const mask = computeIntents(['GUILDS', 'NOT_AN_INTENT']);
    expect(mask).toBe(DISCORD_INTENT_BITS.GUILDS ?? 0);
  });
});

describe('DiscordApi.buildIdentifyPayload', () => {
  test('includes op:2, token, and intent bitmask', () => {
    const api = new DiscordApi({
      botToken: 'TOKEN',
      fetchImpl: makeFetch(() => ({ status: 200, json: {} })).fetchImpl,
      wsImpl: StubWsCtor,
    });
    const payload = api.buildIdentifyPayload(['GUILDS', 'MESSAGE_CONTENT']);
    expect(payload.op).toBe(2);
    const d = payload.d as { token: string; intents: number; properties: Record<string, string> };
    expect(d.token).toBe('TOKEN');
    const expectedIntents = (DISCORD_INTENT_BITS.GUILDS ?? 0) | (DISCORD_INTENT_BITS.MESSAGE_CONTENT ?? 0);
    expect(d.intents).toBe(expectedIntents);
    expect(d.properties.browser).toBe('vinyan');
  });
});

describe('DiscordApi.createMessage', () => {
  test('POSTs to /channels/{id}/messages with the content body', async () => {
    const { fetchImpl, calls } = makeFetch(() => ({
      status: 200,
      json: { id: '9', channel_id: 'C1' },
    }));
    const api = new DiscordApi({ botToken: 'TOKEN', fetchImpl, wsImpl: StubWsCtor });
    const res = await api.createMessage('C1', 'hi');
    expect(res.id).toBe('9');
    expect(res.channelId).toBe('C1');
    const call = calls[0]!;
    expect(call.url).toContain('/channels/C1/messages');
    expect(call.body?.content).toBe('hi');
    expect((call.init.headers as Record<string, string>).authorization).toBe('Bot TOKEN');
  });

  test('includes message_reference when replyToMessageId provided', async () => {
    const { fetchImpl, calls } = makeFetch(() => ({
      status: 200,
      json: { id: '10', channel_id: 'C1' },
    }));
    const api = new DiscordApi({ botToken: 'TOKEN', fetchImpl, wsImpl: StubWsCtor });
    await api.createMessage('C1', 'reply', { replyToMessageId: 'M1' });
    const body = calls[0]!.body as { message_reference?: { message_id?: string } };
    expect(body.message_reference?.message_id).toBe('M1');
  });

  test('rejects with DiscordApiError(kind=http) on non-2xx', async () => {
    const { fetchImpl } = makeFetch(() => ({ status: 429, json: { code: 10008, message: 'rate limited' } }));
    const api = new DiscordApi({ botToken: 'TOKEN', fetchImpl, wsImpl: StubWsCtor });
    try {
      await api.createMessage('C1', 'x');
      expect(false).toBe(true);
    } catch (err) {
      expect(err).toBeInstanceOf(DiscordApiError);
      expect((err as DiscordApiError).kind).toBe('http');
      expect((err as DiscordApiError).status).toBe(429);
    }
  });
});
