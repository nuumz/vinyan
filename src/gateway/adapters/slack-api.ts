/**
 * SlackApi — thin typed wrapper over the Slack Web API + Socket Mode.
 *
 * Kept separate from `SlackAdapter` so tests can mock the network and
 * WebSocket layers by injecting a `fetch` stub and a `WebSocket` class
 * constructor. No side effects at construction time.
 *
 * Socket Mode flow:
 *   1. `apps.connections.open` (uses appToken `xapp-…`)           → wssUrl
 *   2. `new WebSocket(wssUrl)`                                    → live events
 *   3. `chat.postMessage` (uses botToken `xoxb-…`)                → send replies
 *
 * Contract: methods resolve with Slack's `result` payload on `{ok:true}`
 * and reject with a `SlackApiError` on non-2xx or `ok === false`.
 */

const DEFAULT_BASE_URL = 'https://slack.com/api';

/** Minimal structural surface the adapter needs from a WebSocket instance. */
export interface SlackWebSocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onclose: ((ev: { code?: number; reason?: string }) => void) | null;
  readyState: number;
}

/**
 * Constructor-compatible surface for a WebSocket class. The native
 * `WebSocket` class satisfies this — tests inject a fake that captures
 * the URL and exposes controls to simulate open/message/close events.
 */
export type SlackWebSocketCtor = new (url: string) => SlackWebSocketLike;

export interface SlackApiOptions {
  readonly appToken: string;
  readonly botToken: string;
  readonly baseUrl?: string;
  readonly fetchImpl?: typeof fetch;
  readonly wsImpl?: SlackWebSocketCtor;
}

export class SlackApiError extends Error {
  constructor(
    message: string,
    readonly kind: 'http' | 'api' | 'network' | 'parse',
    readonly status?: number,
    readonly slackError?: string,
  ) {
    super(message);
    this.name = 'SlackApiError';
  }
}

interface SlackResponse {
  ok: boolean;
  error?: string;
  [key: string]: unknown;
}

export interface SlackConnectionsOpenResult {
  readonly url: string;
}

export interface SlackPostMessageResult {
  readonly channel: string;
  readonly ts: string;
}

/**
 * Minimum structural surface of the Slack `events_api` envelope we care
 * about. Full schemas live in Slack's docs; we only parse the subset the
 * adapter needs to build an InboundEnvelope.
 */
export interface SlackSocketEnvelope {
  readonly type: string;
  readonly envelope_id?: string;
  readonly payload?: {
    readonly event?: SlackEvent;
    readonly team_id?: string;
  };
}

export interface SlackEvent {
  readonly type: string;
  readonly user?: string;
  readonly text?: string;
  readonly channel?: string;
  readonly channel_type?: 'im' | 'mpim' | 'group' | 'channel';
  readonly ts?: string;
  readonly thread_ts?: string;
  readonly bot_id?: string;
  readonly subtype?: string;
}

export class SlackApi {
  private readonly appToken: string;
  private readonly botToken: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  readonly wsImpl: SlackWebSocketCtor;

  constructor(opts: SlackApiOptions) {
    if (!opts.appToken) throw new Error('SlackApi: appToken is required');
    if (!opts.botToken) throw new Error('SlackApi: botToken is required');
    this.appToken = opts.appToken;
    this.botToken = opts.botToken;
    this.baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.wsImpl =
      opts.wsImpl ??
      ((globalThis as unknown as Record<string, unknown>).WebSocket as SlackWebSocketCtor);
  }

  /** Request a Socket Mode WebSocket URL. */
  async openConnection(): Promise<SlackConnectionsOpenResult> {
    const parsed = await this.call<{ url: string }>('apps.connections.open', this.appToken, {});
    if (!parsed.url || typeof parsed.url !== 'string') {
      throw new SlackApiError('apps.connections.open returned no url', 'parse');
    }
    return { url: parsed.url };
  }

  /** Send a text message to a channel (or DM). */
  async postMessage(
    channel: string,
    text: string,
    opts?: { threadTs?: string },
  ): Promise<SlackPostMessageResult> {
    const body: Record<string, unknown> = { channel, text };
    if (opts?.threadTs) body.thread_ts = opts.threadTs;
    const parsed = await this.call<{ channel: string; ts: string }>(
      'chat.postMessage',
      this.botToken,
      body,
    );
    if (typeof parsed.ts !== 'string' || typeof parsed.channel !== 'string') {
      throw new SlackApiError('chat.postMessage returned no ts/channel', 'parse');
    }
    return { channel: parsed.channel, ts: parsed.ts };
  }

  // ── internal ──────────────────────────────────────────────────────

  private async call<T>(
    method: string,
    bearerToken: string,
    body: Record<string, unknown>,
  ): Promise<T & { ok: true }> {
    const url = `${this.baseUrl}/${method}`;
    let resp: Response;
    try {
      resp = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json; charset=utf-8',
          authorization: `Bearer ${bearerToken}`,
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new SlackApiError(`slack network error: ${msg}`, 'network');
    }

    if (!resp.ok) {
      throw new SlackApiError(`slack HTTP ${resp.status}`, 'http', resp.status);
    }

    let parsed: SlackResponse;
    try {
      parsed = (await resp.json()) as SlackResponse;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new SlackApiError(`slack response parse error: ${msg}`, 'parse');
    }

    if (!parsed.ok) {
      throw new SlackApiError(
        parsed.error ?? 'slack api returned ok=false',
        'api',
        resp.status,
        parsed.error,
      );
    }

    return parsed as unknown as T & { ok: true };
  }
}

/**
 * Map a Slack channel-type string to the ChatKind used by the InboundEnvelope
 * schema. Slack `im` = DM, `mpim`/`group` = group, `channel` = channel. Falls
 * back to `channel` when unknown (safer than guessing `dm`).
 */
export function mapSlackChannelKind(
  channelType: string | undefined,
): 'dm' | 'group' | 'channel' {
  switch (channelType) {
    case 'im':
      return 'dm';
    case 'mpim':
    case 'group':
      return 'group';
    case 'channel':
      return 'channel';
    default:
      return 'channel';
  }
}
