/**
 * Tests for TelegramAdapter — lifecycle, routing, delivery, filtering.
 *
 * We drive the adapter with a fake `TelegramApi` (built around mockable
 * `fetch`) so nothing touches the real network.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { TelegramAdapter, splitForTelegram } from '../../../src/gateway/adapters/telegram.ts';
import type { TelegramApi, TelegramUpdate } from '../../../src/gateway/adapters/telegram-api.ts';
import {
  isGatewayAdapter,
  type GatewayAdapterContext,
  type GatewayInboundEnvelopeMinimal,
} from '../../../src/gateway/types.ts';

interface FakeApi {
  api: TelegramApi;
  updateBatches: TelegramUpdate[][];
  sentMessages: Array<{ chatId: string; text: string; replyToMessageId?: number }>;
  deleteWebhookCalls: number;
  getUpdatesCalls: number;
  stopAfterBatches?: number;
  sendShouldThrow?: Error;
}

function makeFakeApi(updateBatches: TelegramUpdate[][] = []): FakeApi {
  const fake: FakeApi = {
    api: null as unknown as TelegramApi,
    updateBatches,
    sentMessages: [],
    deleteWebhookCalls: 0,
    getUpdatesCalls: 0,
  };

  // Stub the methods we actually use. The TelegramApi interface is
  // structural enough that a cast satisfies the adapter's contract.
  fake.api = {
    async getUpdates(_offset?: number): Promise<TelegramUpdate[]> {
      fake.getUpdatesCalls++;
      if (fake.updateBatches.length > 0) return fake.updateBatches.shift()!;
      // Mimic long-poll timeout: return empty array after a short await to
      // let the loop yield.
      await new Promise((r) => setTimeout(r, 5));
      return [];
    },
    async sendMessage(chatId: string, text: string, opts?: { replyToMessageId?: number }) {
      if (fake.sendShouldThrow) throw fake.sendShouldThrow;
      fake.sentMessages.push({ chatId, text, replyToMessageId: opts?.replyToMessageId });
      return { messageId: fake.sentMessages.length };
    },
    async deleteWebhook(): Promise<void> {
      fake.deleteWebhookCalls++;
    },
  } as unknown as TelegramApi;

  return fake;
}

function makeCtx(published: GatewayInboundEnvelopeMinimal[]): GatewayAdapterContext {
  return {
    profile: 'default',
    publishInbound: (env) => {
      published.push(env);
    },
    log: () => {},
  };
}

// ── Lifecycle ─────────────────────────────────────────────────────────

describe('TelegramAdapter lifecycle', () => {
  let activeAdapter: TelegramAdapter | null = null;
  afterEach(async () => {
    if (activeAdapter) {
      await activeAdapter.stop();
      activeAdapter = null;
    }
  });

  test('implements the GatewayAdapter contract', () => {
    const fake = makeFakeApi();
    const adapter = new TelegramAdapter({ botToken: 'x', api: fake.api });
    expect(isGatewayAdapter(adapter)).toBe(true);
    expect(adapter.platform).toBe('telegram');
  });

  test('start() calls deleteWebhook then begins polling; stop() halts the loop', async () => {
    const fake = makeFakeApi();
    const adapter = new TelegramAdapter({ botToken: 'x', api: fake.api });
    activeAdapter = adapter;
    const published: GatewayInboundEnvelopeMinimal[] = [];
    await adapter.start(makeCtx(published));
    // Let the loop run at least one iteration.
    await new Promise((r) => setTimeout(r, 20));
    await adapter.stop();
    activeAdapter = null;

    expect(fake.deleteWebhookCalls).toBe(1);
    expect(fake.getUpdatesCalls).toBeGreaterThanOrEqual(1);
  });

  test('start() is idempotent; double-start does not spawn a second loop', async () => {
    const fake = makeFakeApi();
    const adapter = new TelegramAdapter({ botToken: 'x', api: fake.api });
    activeAdapter = adapter;
    const published: GatewayInboundEnvelopeMinimal[] = [];
    await adapter.start(makeCtx(published));
    await adapter.start(makeCtx(published));
    await new Promise((r) => setTimeout(r, 20));
    await adapter.stop();
    activeAdapter = null;
    expect(fake.deleteWebhookCalls).toBe(1);
  });
});

// ── Inbound routing ───────────────────────────────────────────────────

describe('TelegramAdapter inbound routing', () => {
  test('publishes a well-formed envelope for a text message', async () => {
    const fake = makeFakeApi([
      [
        {
          update_id: 100,
          message: {
            message_id: 1,
            chat: { id: 42, type: 'private' },
            from: { id: 7, username: 'alice' },
            text: 'hello',
          },
        },
      ],
    ]);
    const adapter = new TelegramAdapter({ botToken: 'x', api: fake.api });
    const published: GatewayInboundEnvelopeMinimal[] = [];
    await adapter.start(makeCtx(published));
    // Allow the first poll to dispatch.
    for (let i = 0; i < 20 && published.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    await adapter.stop();

    expect(published).toHaveLength(1);
    expect(published[0]!.platform).toBe('telegram');
    expect(published[0]!.profile).toBe('default');
    expect(published[0]!.text).toBe('hello');
  });

  test('ignores non-text updates (e.g. sticker with no text field)', async () => {
    const fake = makeFakeApi([
      [
        {
          update_id: 200,
          message: {
            message_id: 1,
            chat: { id: 42, type: 'private' },
            from: { id: 7 },
          },
        },
      ],
    ]);
    const adapter = new TelegramAdapter({ botToken: 'x', api: fake.api });
    const published: GatewayInboundEnvelopeMinimal[] = [];
    await adapter.start(makeCtx(published));
    await new Promise((r) => setTimeout(r, 30));
    await adapter.stop();
    expect(published).toHaveLength(0);
  });

  test('allowedChats filter drops disallowed chats', async () => {
    const fake = makeFakeApi([
      [
        {
          update_id: 1,
          message: {
            message_id: 1,
            chat: { id: 42, type: 'private' },
            from: { id: 7 },
            text: 'allowed',
          },
        },
        {
          update_id: 2,
          message: {
            message_id: 2,
            chat: { id: 99, type: 'private' },
            from: { id: 8 },
            text: 'blocked',
          },
        },
      ],
    ]);
    const adapter = new TelegramAdapter({
      botToken: 'x',
      api: fake.api,
      allowedChats: ['42'],
    });
    const published: GatewayInboundEnvelopeMinimal[] = [];
    await adapter.start(makeCtx(published));
    for (let i = 0; i < 20 && published.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    await adapter.stop();
    expect(published.map((e) => e.text)).toEqual(['allowed']);
  });
});

// ── Delivery ──────────────────────────────────────────────────────────

describe('TelegramAdapter.deliver', () => {
  test('single-shot delivery calls sendMessage once', async () => {
    const fake = makeFakeApi();
    const adapter = new TelegramAdapter({ botToken: 'x', api: fake.api });
    const receipt = await adapter.deliver({
      envelopeId: crypto.randomUUID(),
      platform: 'telegram',
      chatId: 'chat-1',
      text: 'short reply',
    });
    expect(receipt.ok).toBe(true);
    expect(fake.sentMessages).toHaveLength(1);
    expect(fake.sentMessages[0]!.text).toBe('short reply');
  });

  test('chunks an 8000-char message into two sends threaded by replyToMessageId', async () => {
    const fake = makeFakeApi();
    const adapter = new TelegramAdapter({ botToken: 'x', api: fake.api });
    const longText = 'x'.repeat(8000);
    const receipt = await adapter.deliver({
      envelopeId: crypto.randomUUID(),
      platform: 'telegram',
      chatId: 'chat-1',
      text: longText,
    });
    expect(receipt.ok).toBe(true);
    expect(fake.sentMessages.length).toBeGreaterThanOrEqual(2);
    expect(fake.sentMessages[0]!.replyToMessageId).toBeUndefined();
    expect(fake.sentMessages[1]!.replyToMessageId).toBe(1);
  });

  test('returns {ok:false,error} when sendMessage throws', async () => {
    const fake = makeFakeApi();
    fake.sendShouldThrow = new Error('api offline');
    const adapter = new TelegramAdapter({ botToken: 'x', api: fake.api });
    const receipt = await adapter.deliver({
      envelopeId: crypto.randomUUID(),
      platform: 'telegram',
      chatId: 'chat-1',
      text: 'x',
    });
    expect(receipt.ok).toBe(false);
    expect(receipt.error).toContain('api offline');
  });
});

// ── Helpers ───────────────────────────────────────────────────────────

describe('splitForTelegram', () => {
  test('returns a single-element array for short text', () => {
    expect(splitForTelegram('abc', 4000)).toEqual(['abc']);
  });

  test('splits on a newline when available', () => {
    const text = `${'x'.repeat(3000)}\n${'y'.repeat(2000)}`;
    const parts = splitForTelegram(text, 4000);
    expect(parts.length).toBeGreaterThanOrEqual(2);
    expect(parts.join('')).toBe(text);
  });
});
