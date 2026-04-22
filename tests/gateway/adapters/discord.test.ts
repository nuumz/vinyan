/**
 * Tests for DiscordAdapter — lifecycle, inbound routing, delivery, filtering.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { DiscordAdapter, splitForDiscord } from '../../../src/gateway/adapters/discord.ts';
import {
  DiscordApi,
  type DiscordWebSocketCtor,
  type DiscordWebSocketLike,
} from '../../../src/gateway/adapters/discord-api.ts';
import {
  isGatewayAdapter,
  type GatewayAdapterContext,
  type GatewayInboundEnvelopeMinimal,
} from '../../../src/gateway/types.ts';

class FakeWs implements DiscordWebSocketLike {
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
    queueMicrotask(() => {
      this.readyState = 1;
      this.onopen?.({});
    });
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    if (this.closed) return;
    this.closed = true;
    this.closeCode = code;
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }

  emit(data: string): void {
    this.onmessage?.({ data });
  }
}

const FakeWsCtor = FakeWs as unknown as DiscordWebSocketCtor;

function makeCtx(published: GatewayInboundEnvelopeMinimal[]): GatewayAdapterContext {
  return {
    profile: 'default',
    publishInbound: (env) => {
      published.push(env);
    },
    log: () => {},
  };
}

function fakeDiscordApi(): DiscordApi {
  const stubFetch = (async () => new Response('{}', { status: 200 })) as unknown as typeof fetch;
  return new DiscordApi({
    botToken: 'TOKEN',
    fetchImpl: stubFetch,
    wsImpl: FakeWsCtor,
    gatewayUrl: 'wss://example.invalid/gateway',
  });
}

// ── Lifecycle ─────────────────────────────────────────────────────────

describe('DiscordAdapter lifecycle', () => {
  let adapter: DiscordAdapter | null = null;
  afterEach(async () => {
    if (adapter) {
      await adapter.stop();
      adapter = null;
    }
    FakeWs.last = null;
  });

  test('implements the GatewayAdapter contract', () => {
    adapter = new DiscordAdapter({ botToken: 'x', api: fakeDiscordApi() });
    expect(isGatewayAdapter(adapter)).toBe(true);
    expect(adapter.platform).toBe('discord');
  });

  test('start() opens the WebSocket; stop() closes it', async () => {
    adapter = new DiscordAdapter({ botToken: 'x', api: fakeDiscordApi() });
    const published: GatewayInboundEnvelopeMinimal[] = [];
    await adapter.start(makeCtx(published));
    await new Promise((r) => setTimeout(r, 5));
    expect(FakeWs.last).not.toBeNull();
    const ws = FakeWs.last!;
    await adapter.stop();
    expect(ws.closed).toBe(true);
    adapter = null;
  });

  test('stop() is idempotent', async () => {
    adapter = new DiscordAdapter({ botToken: 'x', api: fakeDiscordApi() });
    const published: GatewayInboundEnvelopeMinimal[] = [];
    await adapter.start(makeCtx(published));
    await adapter.stop();
    await adapter.stop();
    adapter = null;
  });

  test('on HELLO, sends IDENTIFY payload', async () => {
    adapter = new DiscordAdapter({ botToken: 'x', api: fakeDiscordApi() });
    const published: GatewayInboundEnvelopeMinimal[] = [];
    await adapter.start(makeCtx(published));
    await new Promise((r) => setTimeout(r, 5));
    FakeWs.last!.emit(JSON.stringify({ op: 10, d: { heartbeat_interval: 45000 } }));
    // Next microtask-flush
    await new Promise((r) => setTimeout(r, 5));
    const identify = FakeWs.last!.sent.find((s) => s.includes('"op":2'));
    expect(identify).toBeDefined();
    const parsed = JSON.parse(identify!) as { op: number; d: { token: string; intents: number } };
    expect(parsed.op).toBe(2);
    expect(parsed.d.token).toBe('TOKEN');
    expect(parsed.d.intents).toBeGreaterThan(0);
  });
});

// ── Inbound routing ───────────────────────────────────────────────────

describe('DiscordAdapter inbound routing', () => {
  let adapter: DiscordAdapter | null = null;
  afterEach(async () => {
    if (adapter) {
      await adapter.stop();
      adapter = null;
    }
    FakeWs.last = null;
  });

  test('publishes a well-formed envelope for MESSAGE_CREATE', async () => {
    adapter = new DiscordAdapter({ botToken: 'x', api: fakeDiscordApi() });
    const published: GatewayInboundEnvelopeMinimal[] = [];
    await adapter.start(makeCtx(published));
    await new Promise((r) => setTimeout(r, 5));
    FakeWs.last!.emit(
      JSON.stringify({
        op: 0,
        t: 'MESSAGE_CREATE',
        s: 1,
        d: {
          id: 'M1',
          channel_id: 'C1',
          guild_id: 'G1',
          author: { id: 'U1', username: 'alice', bot: false },
          content: 'hello',
        },
      }),
    );
    for (let i = 0; i < 20 && published.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(published).toHaveLength(1);
    expect(published[0]!.platform).toBe('discord');
    expect(published[0]!.text).toBe('hello');
  });

  test('ignores bot authors', async () => {
    adapter = new DiscordAdapter({ botToken: 'x', api: fakeDiscordApi() });
    const published: GatewayInboundEnvelopeMinimal[] = [];
    await adapter.start(makeCtx(published));
    await new Promise((r) => setTimeout(r, 5));
    FakeWs.last!.emit(
      JSON.stringify({
        op: 0,
        t: 'MESSAGE_CREATE',
        s: 1,
        d: {
          id: 'M1',
          channel_id: 'C1',
          guild_id: 'G1',
          author: { id: 'B1', username: 'botty', bot: true },
          content: 'echo',
        },
      }),
    );
    await new Promise((r) => setTimeout(r, 15));
    expect(published).toHaveLength(0);
  });

  test('allowedGuilds filter drops messages from other guilds', async () => {
    adapter = new DiscordAdapter({
      botToken: 'x',
      api: fakeDiscordApi(),
      allowedGuilds: ['G1'],
    });
    const published: GatewayInboundEnvelopeMinimal[] = [];
    await adapter.start(makeCtx(published));
    await new Promise((r) => setTimeout(r, 5));
    FakeWs.last!.emit(
      JSON.stringify({
        op: 0,
        t: 'MESSAGE_CREATE',
        s: 1,
        d: {
          id: 'M1',
          channel_id: 'C1',
          guild_id: 'G1',
          author: { id: 'U1', username: 'a', bot: false },
          content: 'allowed',
        },
      }),
    );
    FakeWs.last!.emit(
      JSON.stringify({
        op: 0,
        t: 'MESSAGE_CREATE',
        s: 2,
        d: {
          id: 'M2',
          channel_id: 'C2',
          guild_id: 'G2',
          author: { id: 'U2', username: 'b', bot: false },
          content: 'blocked',
        },
      }),
    );
    for (let i = 0; i < 20 && published.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(published.map((p) => p.text)).toEqual(['allowed']);
  });

  test('silently drops malformed JSON frames', async () => {
    adapter = new DiscordAdapter({ botToken: 'x', api: fakeDiscordApi() });
    const published: GatewayInboundEnvelopeMinimal[] = [];
    await adapter.start(makeCtx(published));
    await new Promise((r) => setTimeout(r, 5));
    FakeWs.last!.emit('<< not json');
    await new Promise((r) => setTimeout(r, 10));
    expect(published).toHaveLength(0);
  });
});

// ── Delivery ──────────────────────────────────────────────────────────

describe('DiscordAdapter.deliver', () => {
  test('single-shot delivery calls createMessage once', async () => {
    const api = fakeDiscordApi();
    const sends: Array<{ channelId: string; content: string }> = [];
    (
      api as unknown as {
        createMessage: (c: string, t: string) => Promise<{ id: string; channelId: string }>;
      }
    ).createMessage = async (channelId, content) => {
      sends.push({ channelId, content });
      return { id: `M${sends.length}`, channelId };
    };
    const adapter = new DiscordAdapter({ botToken: 'x', api });
    const receipt = await adapter.deliver({
      envelopeId: crypto.randomUUID(),
      platform: 'discord',
      chatId: 'C1',
      text: 'hi',
    });
    expect(receipt.ok).toBe(true);
    expect(sends).toHaveLength(1);
  });

  test('chunks >2000-char message into multiple sends, threading replies', async () => {
    const api = fakeDiscordApi();
    const sends: Array<{ content: string; replyToMessageId?: string }> = [];
    (
      api as unknown as {
        createMessage: (
          c: string,
          t: string,
          opts?: { replyToMessageId?: string },
        ) => Promise<{ id: string; channelId: string }>;
      }
    ).createMessage = async (channelId, content, opts) => {
      sends.push({ content, replyToMessageId: opts?.replyToMessageId });
      return { id: `M${sends.length}`, channelId };
    };
    const adapter = new DiscordAdapter({ botToken: 'x', api });
    const receipt = await adapter.deliver({
      envelopeId: crypto.randomUUID(),
      platform: 'discord',
      chatId: 'C1',
      text: 'x'.repeat(4500),
    });
    expect(receipt.ok).toBe(true);
    expect(sends.length).toBeGreaterThanOrEqual(3);
    // Chunks after the first reference the previous message id.
    expect(sends[1]!.replyToMessageId).toBe('M1');
  });

  test('returns {ok:false,error} when createMessage throws', async () => {
    const api = fakeDiscordApi();
    (api as unknown as { createMessage: () => Promise<never> }).createMessage = async () => {
      throw new Error('discord offline');
    };
    const adapter = new DiscordAdapter({ botToken: 'x', api });
    const receipt = await adapter.deliver({
      envelopeId: crypto.randomUUID(),
      platform: 'discord',
      chatId: 'C1',
      text: 'x',
    });
    expect(receipt.ok).toBe(false);
    expect(receipt.error).toContain('discord offline');
  });
});

// ── Helpers ───────────────────────────────────────────────────────────

describe('splitForDiscord', () => {
  test('returns a single chunk for short text', () => {
    expect(splitForDiscord('abc', 2000)).toEqual(['abc']);
  });

  test('splits on newline when possible', () => {
    const text = `${'x'.repeat(1200)}\n${'y'.repeat(1200)}`;
    const parts = splitForDiscord(text, 2000);
    expect(parts.length).toBeGreaterThanOrEqual(2);
    expect(parts.join('')).toBe(text);
  });
});
