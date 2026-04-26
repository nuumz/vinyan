/**
 * TelegramApi — thin typed wrapper over the Telegram Bot HTTP API.
 *
 * Kept separate from `TelegramAdapter` so tests can mock the network
 * layer by injecting a `fetch` stub. No side effects at construction
 * time; every method is an explicit HTTP call.
 *
 * Contract: methods resolve with the decoded `result` field on success,
 * and reject with a `TelegramApiError` on HTTP non-2xx or `ok === false`.
 */

const DEFAULT_BASE_URL = 'https://api.telegram.org';
const DEFAULT_POLL_TIMEOUT_SEC = 30;

export interface TelegramApiOptions {
  readonly botToken: string;
  readonly baseUrl?: string;
  readonly fetchImpl?: typeof fetch;
  readonly pollTimeoutSec?: number;
}

export interface TelegramChat {
  readonly id: number;
  readonly type: 'private' | 'group' | 'supergroup' | 'channel';
  readonly title?: string;
  readonly username?: string;
}

export interface TelegramUser {
  readonly id: number;
  readonly is_bot?: boolean;
  readonly username?: string;
  readonly first_name?: string;
  readonly last_name?: string;
}

export interface TelegramMessage {
  readonly message_id: number;
  readonly chat: TelegramChat;
  readonly from?: TelegramUser;
  readonly text?: string;
  readonly date?: number;
}

export interface TelegramUpdate {
  readonly update_id: number;
  readonly message?: TelegramMessage;
}

export interface SendMessageOptions {
  readonly parseMode?: 'MarkdownV2' | 'HTML' | 'plain';
  readonly replyToMessageId?: number;
}

export class TelegramApiError extends Error {
  constructor(
    message: string,
    readonly kind: 'http' | 'api' | 'network' | 'parse',
    readonly status?: number,
    readonly errorCode?: number,
  ) {
    super(message);
    this.name = 'TelegramApiError';
  }
}

interface TelegramApiResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
}

export class TelegramApi {
  private readonly botToken: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly pollTimeoutSec: number;

  constructor(opts: TelegramApiOptions) {
    if (!opts.botToken) {
      throw new Error('TelegramApi: botToken is required');
    }
    this.botToken = opts.botToken;
    this.baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.pollTimeoutSec = opts.pollTimeoutSec ?? DEFAULT_POLL_TIMEOUT_SEC;
  }

  /** Long-poll `getUpdates`. Returns an array (possibly empty). */
  async getUpdates(offset?: number): Promise<TelegramUpdate[]> {
    const body: Record<string, unknown> = {
      timeout: this.pollTimeoutSec,
      allowed_updates: ['message'],
    };
    if (offset !== undefined) body.offset = offset;

    const result = await this.call<TelegramUpdate[]>('getUpdates', body);
    return result ?? [];
  }

  /** Send a text message. Returns the platform message id. */
  async sendMessage(
    chatId: string,
    text: string,
    opts?: SendMessageOptions,
  ): Promise<{ messageId: number }> {
    const body: Record<string, unknown> = {
      chat_id: chatId,
      text,
    };
    if (opts?.parseMode && opts.parseMode !== 'plain') {
      body.parse_mode = opts.parseMode;
    }
    if (opts?.replyToMessageId !== undefined) {
      body.reply_to_message_id = opts.replyToMessageId;
    }

    const result = await this.call<TelegramMessage>('sendMessage', body);
    if (!result || typeof result.message_id !== 'number') {
      throw new TelegramApiError('sendMessage returned no message_id', 'parse');
    }
    return { messageId: result.message_id };
  }

  /** Best-effort webhook delete — required before long-polling. */
  async deleteWebhook(): Promise<void> {
    try {
      await this.call<boolean>('deleteWebhook', { drop_pending_updates: false });
    } catch {
      // Swallow — deleteWebhook is best-effort on startup.
    }
  }

  // ── internal ──────────────────────────────────────────────────────

  private async call<T>(method: string, body: Record<string, unknown>): Promise<T | undefined> {
    const url = `${this.baseUrl}/bot${this.botToken}/${method}`;
    let resp: Response;
    try {
      resp = await this.fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new TelegramApiError(`telegram network error: ${msg}`, 'network');
    }

    if (!resp.ok) {
      throw new TelegramApiError(`telegram HTTP ${resp.status}`, 'http', resp.status);
    }

    let parsed: TelegramApiResponse<T>;
    try {
      parsed = (await resp.json()) as TelegramApiResponse<T>;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new TelegramApiError(`telegram response parse error: ${msg}`, 'parse');
    }

    if (!parsed.ok) {
      throw new TelegramApiError(
        parsed.description ?? 'telegram api returned ok=false',
        'api',
        resp.status,
        parsed.error_code,
      );
    }

    return parsed.result;
  }
}
