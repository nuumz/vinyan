/**
 * DiscordAdapter — Gateway messaging adapter for Discord (Gateway v10).
 *
 * D21 compliance: the adapter only PUBLISHES inbound envelopes and DELIVERS
 * outbound envelopes. It has no execution privilege; the dispatcher owns
 * the `executeTask` path.
 *
 * Lifecycle:
 *   start(ctx) → open WebSocket → on HELLO(op:10) start heartbeat +
 *                send IDENTIFY(op:2) → on DISPATCH(op:0, t:MESSAGE_CREATE)
 *                build InboundEnvelope and publish.
 *   stop()    → clears heartbeat timer; closes the WebSocket gracefully.
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
  DiscordApi,
  DiscordApiError,
  type DiscordGatewayPayload,
  type DiscordMessageCreateData,
  type DiscordWebSocketCtor,
  type DiscordWebSocketLike,
} from './discord-api.ts';

const DISCORD_MAX_CHARS_PER_SEND = 2000;
const DEFAULT_INTENTS: readonly string[] = [
  'GUILDS',
  'GUILD_MESSAGES',
  'MESSAGE_CONTENT',
  'DIRECT_MESSAGES',
];

export interface DiscordAdapterOptions {
  readonly botToken: string;
  readonly intents?: readonly string[];
  readonly allowedGuilds?: readonly string[];
  readonly fetchImpl?: typeof fetch;
  readonly wsImpl?: DiscordWebSocketCtor;
  readonly gatewayUrl?: string;
  readonly restUrl?: string;
  /** Injectable for tests; placeholder token accepted when provided. */
  readonly api?: DiscordApi;
}

export class DiscordAdapter implements GatewayAdapter {
  readonly platform = 'discord' as const;

  private readonly api: DiscordApi;
  private readonly intents: readonly string[];
  private readonly allowedGuilds: Set<string> | null;
  private running = false;
  private ctx: GatewayAdapterContext | null = null;
  private ws: DiscordWebSocketLike | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private lastSeq: number | null = null;
  private wsConnected = false;
  private lastSuccessfulEventAt: number | undefined;
  private lastError: string | undefined;

  constructor(opts: DiscordAdapterOptions) {
    this.api =
      opts.api ??
      new DiscordApi({
        botToken: opts.botToken,
        restUrl: opts.restUrl,
        gatewayUrl: opts.gatewayUrl,
        fetchImpl: opts.fetchImpl,
        wsImpl: opts.wsImpl,
      });
    this.intents = opts.intents ?? DEFAULT_INTENTS;
    this.allowedGuilds =
      opts.allowedGuilds && opts.allowedGuilds.length > 0
        ? new Set(opts.allowedGuilds)
        : null;
  }

  async start(ctx: GatewayAdapterContext): Promise<void> {
    if (this.running) return;
    this.ctx = ctx;
    this.running = true;
    try {
      this.connectGateway(ctx);
    } catch (err) {
      const msg =
        err instanceof DiscordApiError
          ? `${err.kind}: ${err.message}`
          : err instanceof Error
            ? err.message
            : String(err);
      this.lastError = msg;
      this.running = false;
      ctx.log('error', 'gateway.discord.connect_failed', { error: msg });
      throw err;
    }
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
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
    const chunks = splitForDiscord(envelope.text, DISCORD_MAX_CHARS_PER_SEND);
    const deliveredAt = Date.now();
    let firstId: string | undefined;
    let replyToMessageId = envelope.replyTo;

    try {
      for (const chunk of chunks) {
        const res = await this.api.createMessage(envelope.chatId, chunk, {
          replyToMessageId,
        });
        if (firstId === undefined) firstId = res.id;
        // Subsequent chunks reference the previous so the thread is readable.
        replyToMessageId = res.id;
      }
      return {
        ok: true,
        platformMessageId: firstId,
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

  private connectGateway(ctx: GatewayAdapterContext): void {
    const WsCtor = this.api.wsImpl;
    if (typeof WsCtor !== 'function') {
      throw new Error('DiscordAdapter: no WebSocket constructor available');
    }
    const ws = new WsCtor(this.api.gatewayUrl);
    this.ws = ws;

    ws.onopen = () => {
      ctx.log('info', 'gateway.discord.ws_open');
    };

    ws.onmessage = (ev: { data: unknown }) => {
      this.handleRawMessage(ctx, ev.data).catch((err) => {
        ctx.log('error', 'gateway.discord.handle_message_failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    };

    ws.onerror = (err: unknown) => {
      this.lastError = err instanceof Error ? err.message : 'websocket error';
      ctx.log('warn', 'gateway.discord.ws_error', { error: this.lastError });
    };

    ws.onclose = (ev: { code?: number; reason?: string }) => {
      this.wsConnected = false;
      if (this.heartbeatTimer) {
        clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = null;
      }
      ctx.log('info', 'gateway.discord.ws_closed', { code: ev.code, reason: ev.reason });
    };
  }

  private async handleRawMessage(ctx: GatewayAdapterContext, raw: unknown): Promise<void> {
    const text = typeof raw === 'string' ? raw : raw instanceof Uint8Array ? new TextDecoder().decode(raw) : null;
    if (text === null) return;

    let payload: DiscordGatewayPayload;
    try {
      payload = JSON.parse(text) as DiscordGatewayPayload;
    } catch {
      return;
    }

    if (typeof payload.s === 'number') this.lastSeq = payload.s;

    switch (payload.op) {
      case 10: {
        // HELLO — start heartbeat + send IDENTIFY.
        const d = (payload.d ?? {}) as { heartbeat_interval?: number };
        const interval = typeof d.heartbeat_interval === 'number' ? d.heartbeat_interval : 45_000;
        this.startHeartbeat(interval);
        this.sendPayload(this.api.buildIdentifyPayload(this.intents));
        return;
      }
      case 11:
        // HEARTBEAT_ACK — we treat receipt as "connection healthy".
        this.wsConnected = true;
        this.lastSuccessfulEventAt = Date.now();
        return;
      case 0: {
        // DISPATCH.
        if (payload.t === 'READY') {
          this.wsConnected = true;
          this.lastSuccessfulEventAt = Date.now();
          return;
        }
        if (payload.t === 'MESSAGE_CREATE') {
          await this.handleMessageCreate(ctx, payload.d as DiscordMessageCreateData);
        }
        return;
      }
      default:
        return;
    }
  }

  private async handleMessageCreate(
    ctx: GatewayAdapterContext,
    data: DiscordMessageCreateData | undefined,
  ): Promise<void> {
    if (!data) return;
    if (!data.content || !data.channel_id || !data.author) return;
    if (data.author.bot) return;

    if (this.allowedGuilds && (!data.guild_id || !this.allowedGuilds.has(data.guild_id))) {
      ctx.log('info', 'gateway.discord.guild_blocked', { guildId: data.guild_id });
      return;
    }

    const kind: 'dm' | 'group' | 'channel' = data.guild_id ? 'channel' : 'dm';

    const inbound = await buildInboundEnvelope({
      platform: 'discord',
      profile: ctx.profile,
      chat: { id: data.channel_id, kind },
      sender: {
        platformUserId: data.author.id,
        displayName: data.author.username,
        trustTier: 'unknown',
      },
      text: data.content,
    });

    this.lastSuccessfulEventAt = Date.now();
    ctx.publishInbound(toMinimalInbound(inbound));
  }

  private startHeartbeat(intervalMs: number): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    const tick = (): void => {
      this.sendPayload(this.api.buildHeartbeatPayload(this.lastSeq));
    };
    const handle = setInterval(tick, intervalMs);
    // Don't keep the event loop alive purely for heartbeat.
    if (typeof (handle as unknown as { unref?: () => void }).unref === 'function') {
      (handle as unknown as { unref: () => void }).unref();
    }
    this.heartbeatTimer = handle;
  }

  private sendPayload(payload: DiscordGatewayPayload): void {
    if (!this.ws) return;
    try {
      this.ws.send(JSON.stringify(payload));
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
    }
  }
}

/**
 * Split a long text into Discord-sized chunks on a newline/word boundary
 * when possible. Pure — exported for independent testing.
 */
export function splitForDiscord(text: string, maxChars: number): string[] {
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
