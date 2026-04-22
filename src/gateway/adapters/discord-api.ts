/**
 * DiscordApi — thin typed wrapper over the Discord REST + Gateway API.
 *
 * Kept separate from `DiscordAdapter` so tests can mock the network and
 * WebSocket layers by injecting a `fetch` stub and a `WebSocket` class
 * constructor.
 *
 * Gateway v10 flow:
 *   1. GET /gateway/bot → wssUrl (with ?v=10&encoding=json).
 *   2. new WebSocket(wssUrl) → receive HELLO (op:10), start heartbeat.
 *   3. IDENTIFY (op:2) with token + intents.
 *   4. Receive MESSAGE_CREATE dispatches (op:0, t:'MESSAGE_CREATE').
 *
 * Contract: REST methods resolve with the decoded JSON body on 2xx, and
 * reject with a `DiscordApiError` on non-2xx.
 */

const DEFAULT_REST_URL = 'https://discord.com/api/v10';
const DEFAULT_GATEWAY_URL = 'wss://gateway.discord.gg/?v=10&encoding=json';

/** Minimal structural surface the adapter needs from a WebSocket instance. */
export interface DiscordWebSocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onclose: ((ev: { code?: number; reason?: string }) => void) | null;
  readyState: number;
}

export type DiscordWebSocketCtor = new (url: string) => DiscordWebSocketLike;

/** Discord Gateway intent bit flags. Names match the official docs. */
export const DISCORD_INTENT_BITS: Record<string, number> = {
  GUILDS: 1 << 0,
  GUILD_MEMBERS: 1 << 1,
  GUILD_MODERATION: 1 << 2,
  GUILD_EMOJIS_AND_STICKERS: 1 << 3,
  GUILD_INTEGRATIONS: 1 << 4,
  GUILD_WEBHOOKS: 1 << 5,
  GUILD_INVITES: 1 << 6,
  GUILD_VOICE_STATES: 1 << 7,
  GUILD_PRESENCES: 1 << 8,
  GUILD_MESSAGES: 1 << 9,
  GUILD_MESSAGE_REACTIONS: 1 << 10,
  GUILD_MESSAGE_TYPING: 1 << 11,
  DIRECT_MESSAGES: 1 << 12,
  DIRECT_MESSAGE_REACTIONS: 1 << 13,
  DIRECT_MESSAGE_TYPING: 1 << 14,
  MESSAGE_CONTENT: 1 << 15,
  GUILD_SCHEDULED_EVENTS: 1 << 16,
  AUTO_MODERATION_CONFIGURATION: 1 << 20,
  AUTO_MODERATION_EXECUTION: 1 << 21,
};

/** Compute the intent bit mask from a list of intent names. Unknown names are ignored. */
export function computeIntents(intents: readonly string[]): number {
  let mask = 0;
  for (const name of intents) {
    const bit = DISCORD_INTENT_BITS[name];
    if (bit !== undefined) mask |= bit;
  }
  return mask;
}

export interface DiscordApiOptions {
  readonly botToken: string;
  readonly restUrl?: string;
  readonly gatewayUrl?: string;
  readonly fetchImpl?: typeof fetch;
  readonly wsImpl?: DiscordWebSocketCtor;
}

export class DiscordApiError extends Error {
  constructor(
    message: string,
    readonly kind: 'http' | 'network' | 'parse',
    readonly status?: number,
    readonly code?: number,
  ) {
    super(message);
    this.name = 'DiscordApiError';
  }
}

export interface DiscordMessageResult {
  readonly id: string;
  readonly channelId: string;
}

export interface DiscordGatewayPayload {
  readonly op: number;
  readonly d?: unknown;
  readonly s?: number | null;
  readonly t?: string | null;
}

export interface DiscordMessageCreateData {
  readonly id: string;
  readonly channel_id: string;
  readonly guild_id?: string;
  readonly author?: { id: string; username?: string; bot?: boolean };
  readonly content?: string;
  readonly message_reference?: { message_id?: string; channel_id?: string };
  readonly type?: number;
}

export class DiscordApi {
  private readonly botToken: string;
  private readonly restUrl: string;
  readonly gatewayUrl: string;
  private readonly fetchImpl: typeof fetch;
  readonly wsImpl: DiscordWebSocketCtor;

  constructor(opts: DiscordApiOptions) {
    if (!opts.botToken) throw new Error('DiscordApi: botToken is required');
    this.botToken = opts.botToken;
    this.restUrl = opts.restUrl ?? DEFAULT_REST_URL;
    this.gatewayUrl = opts.gatewayUrl ?? DEFAULT_GATEWAY_URL;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.wsImpl =
      opts.wsImpl ??
      ((globalThis as unknown as Record<string, unknown>).WebSocket as DiscordWebSocketCtor);
  }

  /**
   * Build the IDENTIFY (op:2) payload. Pure — callers send it over the
   * gateway socket once HELLO is received.
   */
  buildIdentifyPayload(intents: readonly string[]): DiscordGatewayPayload {
    return {
      op: 2,
      d: {
        token: this.botToken,
        intents: computeIntents(intents),
        properties: {
          os: 'linux',
          browser: 'vinyan',
          device: 'vinyan',
        },
      },
    };
  }

  /** Build a heartbeat (op:1) payload using the last known sequence number. */
  buildHeartbeatPayload(seq: number | null): DiscordGatewayPayload {
    return { op: 1, d: seq };
  }

  /** POST a message to a channel. Optionally a reply to another message. */
  async createMessage(
    channelId: string,
    content: string,
    opts?: { replyToMessageId?: string },
  ): Promise<DiscordMessageResult> {
    const body: Record<string, unknown> = { content };
    if (opts?.replyToMessageId) {
      body.message_reference = {
        message_id: opts.replyToMessageId,
        channel_id: channelId,
        fail_if_not_exists: false,
      };
    }
    const parsed = await this.rest<{ id: string; channel_id: string }>(
      'POST',
      `/channels/${channelId}/messages`,
      body,
    );
    if (!parsed.id || !parsed.channel_id) {
      throw new DiscordApiError('createMessage returned no id', 'parse');
    }
    return { id: parsed.id, channelId: parsed.channel_id };
  }

  // ── internal ──────────────────────────────────────────────────────

  private async rest<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: Record<string, unknown>,
  ): Promise<T> {
    const url = `${this.restUrl}${path}`;
    let resp: Response;
    try {
      resp = await this.fetchImpl(url, {
        method,
        headers: {
          'content-type': 'application/json',
          authorization: `Bot ${this.botToken}`,
          'user-agent': 'DiscordBot (https://vinyan.local, 1.0)',
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new DiscordApiError(`discord network error: ${msg}`, 'network');
    }

    if (!resp.ok) {
      let code: number | undefined;
      try {
        const err = (await resp.json()) as { code?: number; message?: string };
        code = err.code;
      } catch {
        /* ignore */
      }
      throw new DiscordApiError(`discord HTTP ${resp.status}`, 'http', resp.status, code);
    }

    try {
      return (await resp.json()) as T;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new DiscordApiError(`discord response parse error: ${msg}`, 'parse');
    }
  }
}
