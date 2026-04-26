/**
 * Tests for the thin typed Slack API wrapper.
 *
 * All tests inject a fake `fetch` and fake `WebSocket` ctor — we never reach
 * the real network.
 */

import { describe, expect, test } from 'bun:test';
import {
  SlackApi,
  SlackApiError,
  mapSlackChannelKind,
  type SlackWebSocketCtor,
  type SlackWebSocketLike,
} from '../../../src/gateway/adapters/slack-api.ts';

interface FetchCall {
  url: string;
  body: Record<string, unknown>;
  init: RequestInit;
}

function makeFetch(
  responder: (call: FetchCall) => { status?: number; json?: unknown; throws?: Error },
): { fetchImpl: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
    let body: Record<string, unknown> = {};
    if (init?.body) {
      try {
        body = JSON.parse(init.body as string) as Record<string, unknown>;
      } catch {
        body = {};
      }
    }
    const call: FetchCall = { url, body, init: init ?? {} };
    calls.push(call);
    const res = responder(call);
    if (res.throws) throw res.throws;
    const status = res.status ?? 200;
    const json = res.json;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => json,
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

/**
 * Stub WebSocket. We don't actually use it in api-level tests, but the
 * SlackApi constructor accepts one for later use by the adapter layer.
 */
class StubWs implements SlackWebSocketLike {
  static lastUrl: string | null = null;
  send(_: string): void {}
  close(): void {}
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onclose: ((ev: { code?: number; reason?: string }) => void) | null = null;
  readyState = 1;
  constructor(url: string) {
    StubWs.lastUrl = url;
  }
}

const StubWsCtor = StubWs as unknown as SlackWebSocketCtor;

describe('SlackApi.openConnection', () => {
  test('POSTs to apps.connections.open with the app token', async () => {
    const { fetchImpl, calls } = makeFetch(() => ({
      status: 200,
      json: { ok: true, url: 'wss://wss-primary.slack.com/link/?ticket=abc' },
    }));
    const api = new SlackApi({
      appToken: 'xapp-1-APP',
      botToken: 'xoxb-BOT',
      fetchImpl,
      wsImpl: StubWsCtor,
    });
    const { url } = await api.openConnection();
    expect(url).toContain('wss://');
    expect(calls[0]!.url).toContain('/apps.connections.open');
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe('Bearer xapp-1-APP');
  });

  test('throws SlackApiError on ok=false', async () => {
    const { fetchImpl } = makeFetch(() => ({
      status: 200,
      json: { ok: false, error: 'invalid_auth' },
    }));
    const api = new SlackApi({
      appToken: 'xapp-1',
      botToken: 'xoxb-1',
      fetchImpl,
      wsImpl: StubWsCtor,
    });
    await expect(api.openConnection()).rejects.toBeInstanceOf(SlackApiError);
  });
});

describe('SlackApi.postMessage', () => {
  test('formats the POST body and uses the bot token', async () => {
    const { fetchImpl, calls } = makeFetch(() => ({
      status: 200,
      json: { ok: true, channel: 'C123', ts: '1700000000.000100' },
    }));
    const api = new SlackApi({
      appToken: 'xapp-1',
      botToken: 'xoxb-BOT',
      fetchImpl,
      wsImpl: StubWsCtor,
    });
    const res = await api.postMessage('C123', 'hi', { threadTs: '1700000000.000000' });
    expect(res.ts).toBe('1700000000.000100');
    expect(res.channel).toBe('C123');
    const call = calls[0]!;
    expect(call.url).toContain('/chat.postMessage');
    expect(call.body.channel).toBe('C123');
    expect(call.body.text).toBe('hi');
    expect(call.body.thread_ts).toBe('1700000000.000000');
    expect((call.init.headers as Record<string, string>).authorization).toBe('Bearer xoxb-BOT');
  });

  test('omits thread_ts when not provided', async () => {
    const { fetchImpl, calls } = makeFetch(() => ({
      status: 200,
      json: { ok: true, channel: 'C1', ts: '1.2' },
    }));
    const api = new SlackApi({
      appToken: 'xapp-1',
      botToken: 'xoxb-1',
      fetchImpl,
      wsImpl: StubWsCtor,
    });
    await api.postMessage('C1', 'hi');
    expect(calls[0]!.body.thread_ts).toBeUndefined();
  });

  test('rejects with SlackApiError(kind=network) on fetch throw', async () => {
    const { fetchImpl } = makeFetch(() => ({ throws: new Error('ECONNRESET') }));
    const api = new SlackApi({
      appToken: 'xapp-1',
      botToken: 'xoxb-1',
      fetchImpl,
      wsImpl: StubWsCtor,
    });
    try {
      await api.postMessage('C1', 'x');
      expect(false).toBe(true);
    } catch (err) {
      expect(err).toBeInstanceOf(SlackApiError);
      expect((err as SlackApiError).kind).toBe('network');
    }
  });

  test('rejects with SlackApiError(kind=http) on non-2xx', async () => {
    const { fetchImpl } = makeFetch(() => ({ status: 503, json: {} }));
    const api = new SlackApi({
      appToken: 'xapp-1',
      botToken: 'xoxb-1',
      fetchImpl,
      wsImpl: StubWsCtor,
    });
    try {
      await api.postMessage('C1', 'x');
      expect(false).toBe(true);
    } catch (err) {
      expect(err).toBeInstanceOf(SlackApiError);
      expect((err as SlackApiError).kind).toBe('http');
      expect((err as SlackApiError).status).toBe(503);
    }
  });
});

describe('mapSlackChannelKind', () => {
  test('maps Slack channel types to InboundEnvelope kinds', () => {
    expect(mapSlackChannelKind('im')).toBe('dm');
    expect(mapSlackChannelKind('mpim')).toBe('group');
    expect(mapSlackChannelKind('group')).toBe('group');
    expect(mapSlackChannelKind('channel')).toBe('channel');
    expect(mapSlackChannelKind(undefined)).toBe('channel');
  });
});
