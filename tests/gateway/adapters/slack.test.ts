/**
 * Tests for SlackAdapter — lifecycle, inbound routing, delivery, filtering.
 *
 * We drive the adapter with a fake `SlackApi` and a fake `WebSocket` class
 * so nothing touches the real network.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { SlackAdapter, splitForSlack } from '../../../src/gateway/adapters/slack.ts';
import {
  SlackApi,
  type SlackWebSocketCtor,
  type SlackWebSocketLike,
} from '../../../src/gateway/adapters/slack-api.ts';
import {
  isGatewayAdapter,
  type GatewayAdapterContext,
  type GatewayInboundEnvelopeMinimal,
} from '../../../src/gateway/types.ts';

/**
 * Controllable WebSocket fake. Tests grab the most recent instance via the
 * static `last` pointer and simulate `open`, `message`, and `close` events.
 */
class FakeWs implements SlackWebSocketLike {
  static last: FakeWs | null = null;
  readonly url: string;
  readyState = 0;
  sent: string[] = [];
  closed = false;
  closeCode?: number;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onclose: ((ev: { code?: number; reason?: string }) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeWs.last = this;
    this.readyState = 0;
    // Microtask: mark "open" so tests can await a tick and then emit events.
    queueMicrotask(() => {
      this.readyState = 1;
      this.onopen?.({});
    });
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number, _reason?: string): void {
    if (this.closed) return;
    this.closed = true;
    this.closeCode = code;
    this.readyState = 3;
    this.onclose?.({ code, reason: _reason });
  }

  emit(data: string): void {
    this.onmessage?.({ data });
  }
}

const FakeWsCtor = FakeWs as unknown as SlackWebSocketCtor;

function makeCtx(
  published: GatewayInboundEnvelopeMinimal[],
  logs: Array<{ level: string; msg: string }> = [],
): GatewayAdapterContext {
  return {
    profile: 'default',
    publishInbound: (env) => {
      published.push(env);
    },
    log: (level, msg) => {
      logs.push({ level, msg });
    },
  };
}

/**
 * Build a SlackApi with a stubbed `openConnection()` so start() doesn't
 * block on a real HTTP call. Uses FakeWs for socket creation.
 */
function fakeSlackApi(): SlackApi {
  const stubFetch = (async () =>
    new Response(JSON.stringify({ ok: true, url: 'wss://example.invalid/ws' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch;
  const api = new SlackApi({
    appToken: 'xapp-1',
    botToken: 'xoxb-1',
    fetchImpl: stubFetch,
    wsImpl: FakeWsCtor,
  });
  // Override openConnection to avoid dealing with the mock fetch Response
  // mechanics — we just need the WSS URL.
  (api as unknown as { openConnection: () => Promise<{ url: string }> }).openConnection = async () => ({
    url: 'wss://example.invalid/ws',
  });
  return api;
}

// ── Lifecycle ─────────────────────────────────────────────────────────

describe('SlackAdapter lifecycle', () => {
  let adapter: SlackAdapter | null = null;
  afterEach(async () => {
    if (adapter) {
      await adapter.stop();
      adapter = null;
    }
    FakeWs.last = null;
  });

  test('implements the GatewayAdapter contract', () => {
    adapter = new SlackAdapter({
      appToken: 'x',
      botToken: 'y',
      api: fakeSlackApi(),
    });
    expect(isGatewayAdapter(adapter)).toBe(true);
    expect(adapter.platform).toBe('slack');
  });

  test('start() opens the WebSocket; stop() closes it', async () => {
    adapter = new SlackAdapter({
      appToken: 'x',
      botToken: 'y',
      api: fakeSlackApi(),
    });
    const published: GatewayInboundEnvelopeMinimal[] = [];
    await adapter.start(makeCtx(published));
    await new Promise((r) => setTimeout(r, 5));
    expect(FakeWs.last).not.toBeNull();
    const ws = FakeWs.last!;
    expect(ws.url).toContain('wss://');
    await adapter.stop();
    expect(ws.closed).toBe(true);
    adapter = null;
  });

  test('stop() is idempotent', async () => {
    adapter = new SlackAdapter({
      appToken: 'x',
      botToken: 'y',
      api: fakeSlackApi(),
    });
    const published: GatewayInboundEnvelopeMinimal[] = [];
    await adapter.start(makeCtx(published));
    await adapter.stop();
    await adapter.stop();
    adapter = null;
  });

  test('start() is idempotent; double-start does not spawn a second socket', async () => {
    adapter = new SlackAdapter({
      appToken: 'x',
      botToken: 'y',
      api: fakeSlackApi(),
    });
    const published: GatewayInboundEnvelopeMinimal[] = [];
    await adapter.start(makeCtx(published));
    const first = FakeWs.last;
    await adapter.start(makeCtx(published));
    expect(FakeWs.last).toBe(first!);
  });
});

// ── Inbound routing ───────────────────────────────────────────────────

describe('SlackAdapter inbound routing', () => {
  let adapter: SlackAdapter | null = null;
  afterEach(async () => {
    if (adapter) {
      await adapter.stop();
      adapter = null;
    }
    FakeWs.last = null;
  });

  test('publishes a well-formed envelope for a user message', async () => {
    adapter = new SlackAdapter({
      appToken: 'x',
      botToken: 'y',
      api: fakeSlackApi(),
    });
    const published: GatewayInboundEnvelopeMinimal[] = [];
    await adapter.start(makeCtx(published));
    await new Promise((r) => setTimeout(r, 5));
    FakeWs.last!.emit(
      JSON.stringify({
        envelope_id: 'env-1',
        type: 'events_api',
        payload: {
          event: {
            type: 'message',
            user: 'U1',
            channel: 'C1',
            channel_type: 'channel',
            text: 'hello',
            ts: '1700000000.000001',
          },
        },
      }),
    );
    for (let i = 0; i < 20 && published.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(published).toHaveLength(1);
    expect(published[0]!.platform).toBe('slack');
    expect(published[0]!.text).toBe('hello');
    // Envelope ack was sent.
    expect(FakeWs.last!.sent.some((s) => s.includes('env-1'))).toBe(true);
  });

  test('allowedChannels filter drops disallowed channels', async () => {
    adapter = new SlackAdapter({
      appToken: 'x',
      botToken: 'y',
      api: fakeSlackApi(),
      allowedChannels: ['C1'],
    });
    const published: GatewayInboundEnvelopeMinimal[] = [];
    await adapter.start(makeCtx(published));
    await new Promise((r) => setTimeout(r, 5));
    FakeWs.last!.emit(
      JSON.stringify({
        envelope_id: 'env-ok',
        type: 'events_api',
        payload: {
          event: {
            type: 'message',
            user: 'U1',
            channel: 'C1',
            channel_type: 'channel',
            text: 'allowed',
          },
        },
      }),
    );
    FakeWs.last!.emit(
      JSON.stringify({
        envelope_id: 'env-blocked',
        type: 'events_api',
        payload: {
          event: {
            type: 'message',
            user: 'U2',
            channel: 'C2',
            channel_type: 'channel',
            text: 'blocked',
          },
        },
      }),
    );
    for (let i = 0; i < 20 && published.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(published.map((p) => p.text)).toEqual(['allowed']);
  });

  test('ignores bot echoes and subtyped messages', async () => {
    adapter = new SlackAdapter({
      appToken: 'x',
      botToken: 'y',
      api: fakeSlackApi(),
    });
    const published: GatewayInboundEnvelopeMinimal[] = [];
    await adapter.start(makeCtx(published));
    await new Promise((r) => setTimeout(r, 5));
    FakeWs.last!.emit(
      JSON.stringify({
        envelope_id: 'env-bot',
        type: 'events_api',
        payload: {
          event: {
            type: 'message',
            user: 'U1',
            channel: 'C1',
            channel_type: 'channel',
            text: 'echoed',
            bot_id: 'B123',
          },
        },
      }),
    );
    FakeWs.last!.emit(
      JSON.stringify({
        envelope_id: 'env-edit',
        type: 'events_api',
        payload: {
          event: {
            type: 'message',
            user: 'U1',
            channel: 'C1',
            channel_type: 'channel',
            text: 'edited',
            subtype: 'message_changed',
          },
        },
      }),
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(published).toHaveLength(0);
  });

  test('silently drops malformed JSON frames', async () => {
    adapter = new SlackAdapter({
      appToken: 'x',
      botToken: 'y',
      api: fakeSlackApi(),
    });
    const published: GatewayInboundEnvelopeMinimal[] = [];
    await adapter.start(makeCtx(published));
    await new Promise((r) => setTimeout(r, 5));
    FakeWs.last!.emit('{not json');
    await new Promise((r) => setTimeout(r, 10));
    expect(published).toHaveLength(0);
  });
});

// ── Delivery ──────────────────────────────────────────────────────────

describe('SlackAdapter.deliver', () => {
  test('single-shot delivery calls postMessage once', async () => {
    const api = fakeSlackApi();
    const sends: Array<{ channel: string; text: string }> = [];
    (api as unknown as { postMessage: (c: string, t: string) => Promise<{ channel: string; ts: string }> }).postMessage =
      async (channel, text) => {
        sends.push({ channel, text });
        return { channel, ts: `ts-${sends.length}` };
      };
    const adapter = new SlackAdapter({ appToken: 'x', botToken: 'y', api });
    const receipt = await adapter.deliver({
      envelopeId: crypto.randomUUID(),
      platform: 'slack',
      chatId: 'C1',
      text: 'hi',
    });
    expect(receipt.ok).toBe(true);
    expect(receipt.platformMessageId).toBe('ts-1');
    expect(sends).toHaveLength(1);
  });

  test('chunks long messages into multiple postMessage calls', async () => {
    const api = fakeSlackApi();
    const sends: Array<{ channel: string; text: string }> = [];
    (api as unknown as { postMessage: (c: string, t: string) => Promise<{ channel: string; ts: string }> }).postMessage =
      async (channel, text) => {
        sends.push({ channel, text });
        return { channel, ts: `ts-${sends.length}` };
      };
    const adapter = new SlackAdapter({ appToken: 'x', botToken: 'y', api });
    const longText = 'x'.repeat(8000);
    const receipt = await adapter.deliver({
      envelopeId: crypto.randomUUID(),
      platform: 'slack',
      chatId: 'C1',
      text: longText,
    });
    expect(receipt.ok).toBe(true);
    expect(sends.length).toBeGreaterThanOrEqual(2);
  });

  test('returns {ok:false,error} when postMessage throws', async () => {
    const api = fakeSlackApi();
    (api as unknown as { postMessage: () => Promise<never> }).postMessage = async () => {
      throw new Error('api offline');
    };
    const adapter = new SlackAdapter({ appToken: 'x', botToken: 'y', api });
    const receipt = await adapter.deliver({
      envelopeId: crypto.randomUUID(),
      platform: 'slack',
      chatId: 'C1',
      text: 'x',
    });
    expect(receipt.ok).toBe(false);
    expect(receipt.error).toContain('api offline');
  });
});

// ── Helpers ───────────────────────────────────────────────────────────

describe('splitForSlack', () => {
  test('returns a single chunk for short text', () => {
    expect(splitForSlack('abc', 3800)).toEqual(['abc']);
  });

  test('splits on newline when possible', () => {
    const text = `${'x'.repeat(3000)}\n${'y'.repeat(2000)}`;
    const parts = splitForSlack(text, 3800);
    expect(parts.length).toBeGreaterThanOrEqual(2);
    expect(parts.join('')).toBe(text);
  });
});
