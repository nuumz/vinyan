/**
 * SlackAdapter — Gateway messaging adapter for Slack (Socket Mode).
 *
 * D21 compliance: the adapter only PUBLISHES inbound envelopes and DELIVERS
 * outbound envelopes. It has no execution privilege; the dispatcher owns
 * the `executeTask` path.
 *
 * Lifecycle:
 *   start(ctx) → apps.connections.open → connect WebSocket → on events,
 *                publish InboundEnvelopes to ctx.
 *   stop()    → sets running=false; acknowledges any pending envelope ids;
 *               closes the WebSocket (no-op if already closed).
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
  SlackApi,
  SlackApiError,
  mapSlackChannelKind,
  type SlackSocketEnvelope,
  type SlackWebSocketCtor,
  type SlackWebSocketLike,
} from './slack-api.ts';

/**
 * Slack has a 40 000-char hard limit on `chat.postMessage`; we stay safely
 * under that for readability + to guarantee chunks never collide with the
 * Gateway-level `MAX_ENVELOPE_TEXT_LEN`.
 */
const SLACK_MAX_CHARS_PER_SEND = 3800;

export interface SlackAdapterOptions {
  readonly appToken: string;
  readonly botToken: string;
  readonly allowedChannels?: readonly string[];
  readonly fetchImpl?: typeof fetch;
  readonly wsImpl?: SlackWebSocketCtor;
  readonly baseUrl?: string;
  /**
   * Injectable API instance — primarily for tests so they can avoid
   * supplying real Slack tokens. When provided, `appToken`/`botToken` may
   * be any non-empty placeholder.
   */
  readonly api?: SlackApi;
}

export class SlackAdapter implements GatewayAdapter {
  readonly platform = 'slack' as const;

  private readonly api: SlackApi;
  private readonly allowedChannels: Set<string> | null;
  private running = false;
  private ctx: GatewayAdapterContext | null = null;
  private ws: SlackWebSocketLike | null = null;
  private lastSuccessfulEventAt: number | undefined;
  private lastError: string | undefined;
  private wsConnected = false;

  constructor(opts: SlackAdapterOptions) {
    this.api =
      opts.api ??
      new SlackApi({
        appToken: opts.appToken,
        botToken: opts.botToken,
        baseUrl: opts.baseUrl,
        fetchImpl: opts.fetchImpl,
        wsImpl: opts.wsImpl,
      });
    this.allowedChannels =
      opts.allowedChannels && opts.allowedChannels.length > 0
        ? new Set(opts.allowedChannels)
        : null;
  }

  async start(ctx: GatewayAdapterContext): Promise<void> {
    if (this.running) return;
    this.ctx = ctx;
    this.running = true;

    try {
      const { url } = await this.api.openConnection();
      this.connectSocket(ctx, url);
    } catch (err) {
      const msg =
        err instanceof SlackApiError
          ? `${err.kind}: ${err.message}`
          : err instanceof Error
            ? err.message
            : String(err);
      this.lastError = msg;
      this.running = false;
      ctx.log('error', 'gateway.slack.open_failed', { error: msg });
      throw err;
    }
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      try {
        ws.close(1000, 'adapter-stop');
      } catch {
        // Already closed — no-op.
      }
    }
    this.wsConnected = false;
    this.ctx = null;
  }

  async deliver(envelope: GatewayOutboundEnvelope): Promise<GatewayDeliveryReceipt> {
    const chunks = splitForSlack(envelope.text, SLACK_MAX_CHARS_PER_SEND);
    const threadTs = envelope.replyTo;
    const deliveredAt = Date.now();
    let firstTs: string | undefined;

    try {
      for (const chunk of chunks) {
        const res = await this.api.postMessage(envelope.chatId, chunk, { threadTs });
        if (firstTs === undefined) firstTs = res.ts;
      }
      return {
        ok: true,
        platformMessageId: firstTs,
        deliveredAt,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.lastError = msg;
      return { ok: false, error: msg };
    }
  }

  async healthcheck(): Promise<GatewayAdapterHealth> {
    if (!this.wsConnected && this.lastError !== undefined) {
      return { ok: false, lastError: this.lastError };
    }
    return {
      ok: this.wsConnected,
      lastSuccessfulPollAt: this.lastSuccessfulEventAt,
      lastError: this.lastError,
    };
  }

  // ── internals ────────────────────────────────────────────────────

  private connectSocket(ctx: GatewayAdapterContext, url: string): void {
    const WsCtor = this.api.wsImpl;
    if (typeof WsCtor !== 'function') {
      throw new Error('SlackAdapter: no WebSocket constructor available');
    }
    const ws = new WsCtor(url);
    this.ws = ws;

    ws.onopen = () => {
      this.wsConnected = true;
      ctx.log('info', 'gateway.slack.connected');
    };

    ws.onmessage = (ev: { data: unknown }) => {
      this.handleRawMessage(ctx, ev.data).catch((err) => {
        ctx.log('error', 'gateway.slack.handle_message_failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    };

    ws.onerror = (err: unknown) => {
      this.lastError = err instanceof Error ? err.message : 'websocket error';
      ctx.log('warn', 'gateway.slack.ws_error', { error: this.lastError });
    };

    ws.onclose = (ev: { code?: number; reason?: string }) => {
      this.wsConnected = false;
      ctx.log('info', 'gateway.slack.ws_closed', { code: ev.code, reason: ev.reason });
    };
  }

  private async handleRawMessage(ctx: GatewayAdapterContext, raw: unknown): Promise<void> {
    const text = typeof raw === 'string' ? raw : raw instanceof Uint8Array ? new TextDecoder().decode(raw) : null;
    if (text === null) return;

    let envelope: SlackSocketEnvelope;
    try {
      envelope = JSON.parse(text) as SlackSocketEnvelope;
    } catch {
      return;
    }

    // Acknowledge envelope IDs so Slack does not redeliver (required for
    // `events_api`, `interactive`, and `slash_commands` envelope types).
    if (envelope.envelope_id && this.ws) {
      try {
        this.ws.send(JSON.stringify({ envelope_id: envelope.envelope_id }));
      } catch {
        /* best-effort ack */
      }
    }

    if (envelope.type === 'hello') {
      this.wsConnected = true;
      this.lastSuccessfulEventAt = Date.now();
      return;
    }
    if (envelope.type === 'disconnect') {
      this.wsConnected = false;
      return;
    }
    if (envelope.type !== 'events_api') return;

    const event = envelope.payload?.event;
    if (!event || event.type !== 'message') return;
    // Drop bot echoes + edit/delete subtypes (MVP is plain user messages).
    if (event.bot_id) return;
    if (event.subtype && event.subtype !== '') return;
    if (!event.text || !event.channel || !event.user) return;

    const chatId = event.channel;
    if (this.allowedChannels && !this.allowedChannels.has(chatId)) {
      ctx.log('info', 'gateway.slack.channel_blocked', { chatId });
      return;
    }

    const inbound = await buildInboundEnvelope({
      platform: 'slack',
      profile: ctx.profile,
      chat: { id: chatId, kind: mapSlackChannelKind(event.channel_type) },
      sender: {
        platformUserId: event.user,
        trustTier: 'unknown',
      },
      text: event.text,
      threadKey: event.thread_ts ?? event.ts,
    });

    this.lastSuccessfulEventAt = Date.now();
    ctx.publishInbound(toMinimalInbound(inbound));
  }
}

/**
 * Split a long text into Slack-sized chunks on a paragraph/word boundary when
 * possible. Pure function — exported for independent testing.
 */
export function splitForSlack(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) return [text];

  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > maxChars) {
    let cut = maxChars;
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
