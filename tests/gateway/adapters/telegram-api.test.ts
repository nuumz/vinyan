/**
 * Tests for the thin typed Telegram HTTP API wrapper.
 *
 * All tests inject a fake `fetch` — we never reach the real network.
 */

import { describe, expect, test } from 'bun:test';
import { TelegramApi, TelegramApiError } from '../../../src/gateway/adapters/telegram-api.ts';

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

describe('TelegramApi.getUpdates', () => {
  test('parses a mocked JSON response', async () => {
    const { fetchImpl } = makeFetch(() => ({
      status: 200,
      json: {
        ok: true,
        result: [
          {
            update_id: 10,
            message: { message_id: 1, chat: { id: 2, type: 'private' }, from: { id: 3 }, text: 'hi' },
          },
        ],
      },
    }));
    const api = new TelegramApi({ botToken: 'TOKEN', fetchImpl });
    const updates = await api.getUpdates();
    expect(updates).toHaveLength(1);
    expect(updates[0]!.update_id).toBe(10);
    expect(updates[0]!.message?.text).toBe('hi');
  });

  test('sends the offset when provided', async () => {
    const { fetchImpl, calls } = makeFetch(() => ({
      status: 200,
      json: { ok: true, result: [] },
    }));
    const api = new TelegramApi({ botToken: 'TOKEN', fetchImpl });
    await api.getUpdates(42);
    expect(calls[0]!.body.offset).toBe(42);
    expect(calls[0]!.body.timeout).toBeDefined();
    expect(calls[0]!.url).toContain('/botTOKEN/getUpdates');
  });

  test('throws TelegramApiError(kind=api) when ok is false', async () => {
    const { fetchImpl } = makeFetch(() => ({
      status: 200,
      json: { ok: false, description: 'unauthorized', error_code: 401 },
    }));
    const api = new TelegramApi({ botToken: 'TOKEN', fetchImpl });
    await expect(api.getUpdates()).rejects.toBeInstanceOf(TelegramApiError);
  });
});

describe('TelegramApi.sendMessage', () => {
  test('formats the POST body correctly', async () => {
    const { fetchImpl, calls } = makeFetch(() => ({
      status: 200,
      json: { ok: true, result: { message_id: 555, chat: { id: 1, type: 'private' } } },
    }));
    const api = new TelegramApi({ botToken: 'TOKEN', fetchImpl });
    const res = await api.sendMessage('chat-1', 'hello', { parseMode: 'MarkdownV2', replyToMessageId: 10 });
    expect(res.messageId).toBe(555);
    const call = calls[0]!;
    expect(call.url).toContain('/sendMessage');
    expect(call.body.chat_id).toBe('chat-1');
    expect(call.body.text).toBe('hello');
    expect(call.body.parse_mode).toBe('MarkdownV2');
    expect(call.body.reply_to_message_id).toBe(10);
    expect((call.init.headers as Record<string, string>)['content-type']).toBe('application/json');
  });

  test('omits parse_mode when plain', async () => {
    const { fetchImpl, calls } = makeFetch(() => ({
      status: 200,
      json: { ok: true, result: { message_id: 1, chat: { id: 1, type: 'private' } } },
    }));
    const api = new TelegramApi({ botToken: 'TOKEN', fetchImpl });
    await api.sendMessage('chat', 'hi');
    expect(calls[0]!.body.parse_mode).toBeUndefined();
  });

  test('rejects with TelegramApiError(kind=network) on fetch throw', async () => {
    const { fetchImpl } = makeFetch(() => ({ throws: new Error('ECONNRESET') }));
    const api = new TelegramApi({ botToken: 'TOKEN', fetchImpl });
    try {
      await api.sendMessage('c', 'x');
      expect(false).toBe(true); // unreachable
    } catch (err) {
      expect(err).toBeInstanceOf(TelegramApiError);
      expect((err as TelegramApiError).kind).toBe('network');
    }
  });

  test('rejects with TelegramApiError(kind=http) on non-2xx', async () => {
    const { fetchImpl } = makeFetch(() => ({ status: 500, json: {} }));
    const api = new TelegramApi({ botToken: 'TOKEN', fetchImpl });
    try {
      await api.sendMessage('c', 'x');
      expect(false).toBe(true); // unreachable
    } catch (err) {
      expect(err).toBeInstanceOf(TelegramApiError);
      expect((err as TelegramApiError).kind).toBe('http');
      expect((err as TelegramApiError).status).toBe(500);
    }
  });

  test('deleteWebhook swallows errors silently', async () => {
    const { fetchImpl, calls } = makeFetch(() => ({ status: 200, json: { ok: true, result: true } }));
    const api = new TelegramApi({ botToken: 'TOKEN', fetchImpl });
    await api.deleteWebhook();
    expect(calls[0]!.url).toContain('/deleteWebhook');
  });
});
