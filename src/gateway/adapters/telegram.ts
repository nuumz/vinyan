/**
 * TelegramAdapter — Gateway messaging adapter for Telegram (long-polling).
 *
 * D21 compliance: the adapter only PUBLISHES inbound envelopes and DELIVERS
 * outbound envelopes. It has no execution privilege; the dispatcher owns
 * the `executeTask` path.
 *
 * Lifecycle:
 *   start(ctx) → deleteWebhook (best-effort) → poll loop.
 *   stop()    → sets running=false; current long-poll times out naturally
 *               (pollTimeoutSec) so no request hangs forever.
 */
import type {
  GatewayAdapter,
  GatewayAdapterContext,
  GatewayAdapterHealth,
  GatewayDeliveryReceipt,
  GatewayOutboundEnvelope,
} from '../types.ts';
import { buildInboundEnvelope, toMinimalInbound } from '../envelope.ts';
import {
  TelegramApi,
  TelegramApiError,
  type TelegramUpdate,
  type TelegramChat,
} from './telegram-api.ts';

/** Safety margin under Telegram's 4096-char hard limit. */
const TELEGRAM_MAX_CHARS_PER_SEND = 4000;

export interface TelegramAdapterOptions {
  readonly botToken: string;
  readonly allowedChats?: readonly string[];
  readonly fetchImpl?: typeof fetch;
  readonly pollTimeoutSec?: number;
  readonly baseUrl?: string;
  /**
   * Injectable API instance — primarily for tests so they can avoid
   * supplying a bot token. When provided, `botToken` may be any non-empty
   * placeholder.
   */
  readonly api?: TelegramApi;
}

export class TelegramAdapter implements GatewayAdapter {
  readonly platform = 'telegram' as const;

  private readonly api: TelegramApi;
  private readonly allowedChats: Set<string> | null;
  private running = false;
  private ctx: GatewayAdapterContext | null = null;
  private pollTask: Promise<void> | null = null;
  private nextOffset: number | undefined = undefined;
  private lastSuccessfulPollAt: number | undefined;
  private lastError: string | undefined;

  constructor(opts: TelegramAdapterOptions) {
    this.api =
      opts.api ??
      new TelegramApi({
        botToken: opts.botToken,
        baseUrl: opts.baseUrl,
        fetchImpl: opts.fetchImpl,
        pollTimeoutSec: opts.pollTimeoutSec,
      });
    this.allowedChats =
      opts.allowedChats && opts.allowedChats.length > 0
        ? new Set(opts.allowedChats)
        : null;
  }

  async start(ctx: GatewayAdapterContext): Promise<void> {
    if (this.running) return;
    this.ctx = ctx;
    this.running = true;
    await this.api.deleteWebhook();
    this.pollTask = this.runPollLoop(ctx).catch((err) => {
      ctx.log('error', 'gateway.telegram.poll_loop_failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    const task = this.pollTask;
    this.pollTask = null;
    if (task) {
      // The current getUpdates call times out naturally (pollTimeoutSec).
      try {
        await task;
      } catch {
        // Already logged inside the loop.
      }
    }
    this.ctx = null;
  }

  async deliver(envelope: GatewayOutboundEnvelope): Promise<GatewayDeliveryReceipt> {
    const chunks = splitForTelegram(envelope.text, TELEGRAM_MAX_CHARS_PER_SEND);
    let replyToMessageId: number | undefined;
    let firstMessageId: number | undefined;
    const deliveredAt = Date.now();

    try {
      for (const chunk of chunks) {
        const { messageId } = await this.api.sendMessage(envelope.chatId, chunk, {
          replyToMessageId,
        });
        if (firstMessageId === undefined) firstMessageId = messageId;
        // Subsequent chunks thread off the previous one for readability.
        replyToMessageId = messageId;
      }
      return {
        ok: true,
        platformMessageId: firstMessageId !== undefined ? String(firstMessageId) : undefined,
        deliveredAt,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.lastError = msg;
      return { ok: false, error: msg };
    }
  }

  async healthcheck(): Promise<GatewayAdapterHealth> {
    if (this.lastError !== undefined && this.lastSuccessfulPollAt === undefined) {
      return { ok: false, lastError: this.lastError };
    }
    return {
      ok: true,
      lastSuccessfulPollAt: this.lastSuccessfulPollAt,
      lastError: this.lastError,
    };
  }

  // ── internals ────────────────────────────────────────────────────

  private async runPollLoop(ctx: GatewayAdapterContext): Promise<void> {
    while (this.running) {
      try {
        const updates = await this.api.getUpdates(this.nextOffset);
        this.lastSuccessfulPollAt = Date.now();
        for (const update of updates) {
          try {
            await this.handleUpdate(ctx, update);
          } catch (err) {
            ctx.log('error', 'gateway.telegram.handle_update_failed', {
              updateId: update.update_id,
              error: err instanceof Error ? err.message : String(err),
            });
          } finally {
            // Always advance offset — otherwise the same poisoned update
            // would be re-fetched indefinitely.
            this.nextOffset = update.update_id + 1;
          }
        }
      } catch (err) {
        const msg =
          err instanceof TelegramApiError
            ? `${err.kind}: ${err.message}`
            : err instanceof Error
              ? err.message
              : String(err);
        this.lastError = msg;
        ctx.log('warn', 'gateway.telegram.poll_failed', { error: msg });
        // Short back-off before retrying so we don't hot-loop on a hard
        // failure (e.g. bad token, network down). Stay responsive to stop().
        await this.sleep(1000);
      }
    }
  }

  private async handleUpdate(ctx: GatewayAdapterContext, update: TelegramUpdate): Promise<void> {
    const msg = update.message;
    if (!msg || !msg.text) return;
    if (!msg.from) return;

    const chatId = String(msg.chat.id);
    if (this.allowedChats && !this.allowedChats.has(chatId)) {
      ctx.log('info', 'gateway.telegram.chat_blocked', { chatId });
      return;
    }

    const envelope = await buildInboundEnvelope({
      platform: 'telegram',
      profile: ctx.profile,
      chat: { id: chatId, kind: mapChatKind(msg.chat.type) },
      sender: {
        platformUserId: String(msg.from.id),
        displayName: displayNameFor(msg.from),
        trustTier: 'unknown',
      },
      text: msg.text,
    });

    ctx.publishInbound(toMinimalInbound(envelope));
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(resolve, ms);
      // Don't keep the event loop alive purely for sleep.
      if (typeof (t as unknown as { unref?: () => void }).unref === 'function') {
        (t as unknown as { unref: () => void }).unref();
      }
    });
  }
}

// ── helpers ───────────────────────────────────────────────────────────

function mapChatKind(type: TelegramChat['type']): 'dm' | 'group' | 'channel' {
  switch (type) {
    case 'private':
      return 'dm';
    case 'group':
    case 'supergroup':
      return 'group';
    case 'channel':
      return 'channel';
    default:
      return 'dm';
  }
}

function displayNameFor(user: { username?: string; first_name?: string; last_name?: string }): string | undefined {
  if (user.username) return user.username;
  const pieces = [user.first_name, user.last_name].filter((p): p is string => !!p);
  return pieces.length > 0 ? pieces.join(' ') : undefined;
}

/**
 * Split a long text into Telegram-sized chunks on a word boundary when
 * possible. Pure function — exported via closure for the adapter, but also
 * independently testable below.
 */
export function splitForTelegram(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) return [text];

  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > maxChars) {
    let cut = maxChars;
    // Prefer cutting at a newline, falling back to space, else hard cut.
    const nl = remaining.lastIndexOf('\n', maxChars);
    if (nl > maxChars / 2) cut = nl + 1;
    else {
      const sp = remaining.lastIndexOf(' ', maxChars);
      if (sp > maxChars / 2) cut = sp + 1;
    }
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut);
  }
  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}
