/**
 * GatewayDispatcher — single code path from a messaging adapter to the
 * orchestrator's `executeTask`.
 *
 * Design contract (D21, A6):
 *   - Adapters publish inbound envelopes onto the bus and have ZERO
 *     execution privilege.
 *   - The dispatcher is the ONLY subscriber of `gateway:inbound` and the
 *     ONLY code path that invokes `executeTask` on the gateway's behalf.
 *   - Every decision the dispatcher makes (rate-limit, pairing, drop,
 *     dispatch) is rule-based and reproducible (A3).
 *
 * Bus coupling: we intentionally type the bus parameter structurally
 * (`StructuralBus`) rather than importing `VinyanBus`. The event name
 * `gateway:inbound` is owned by the factory-integration sibling track; by
 * using a structural type here we let that PR land the event name in
 * `src/core/bus.ts` without this file fighting for the same diff.
 */
import type { TaskInput, TaskResult } from '../orchestrator/types.ts';
import type { GatewayIdentityStore } from '../db/gateway-identity-store.ts';
import type { GatewayRateLimiter } from './security/rate-limiter.ts';
import {
  type InboundEnvelope,
  InboundEnvelopeSchema,
  type OutboundEnvelope,
  OutboundEnvelopeSchema,
  MAX_ENVELOPE_TEXT_LEN,
} from './envelope.ts';

// ── Structural bus surface ────────────────────────────────────────────
//
// The dispatcher only needs two operations: subscribe to and unsubscribe
// from the `gateway:inbound` event. We encode that as a structural type so
// this file does not compile-depend on the concrete `VinyanBus` event map.

type InboundHandler = (payload: { envelope: InboundEnvelope }) => void;

export interface StructuralBus {
  on(event: 'gateway:inbound', handler: InboundHandler): () => void;
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface GatewayDispatcherDeps {
  readonly bus: StructuralBus;
  readonly executeTask: (input: TaskInput) => Promise<TaskResult>;
  readonly identityStore: GatewayIdentityStore;
  readonly rateLimiter: GatewayRateLimiter;
  readonly log: (level: LogLevel, msg: string, meta?: Record<string, unknown>) => void;
  readonly deliverReply: (envelope: OutboundEnvelope) => Promise<void>;
  readonly now?: () => number;
}

/** Short, user-friendly pairing instruction rendered to unknown senders. */
const PAIRING_INSTRUCTIONS =
  'You are not paired yet. Ask the operator for a pairing token, then send: `/pair <token>`.';

export class GatewayDispatcher {
  private unsubscribe: (() => void) | null = null;
  private readonly now: () => number;

  constructor(private readonly deps: GatewayDispatcherDeps) {
    this.now = deps.now ?? Date.now;
  }

  /** Subscribe to `gateway:inbound`. Idempotent. */
  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.deps.bus.on('gateway:inbound', (payload) => {
      // Fire-and-forget: the bus handler is synchronous; we bridge to the
      // async handler but never let its rejection escape (D21 — nothing
      // inside the dispatcher throws back up to the bus).
      void this.handle(payload.envelope).catch((err) => {
        this.deps.log('error', 'gateway.dispatcher.unhandled', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    });
  }

  /** Unsubscribe from `gateway:inbound`. Idempotent. */
  stop(): void {
    if (!this.unsubscribe) return;
    this.unsubscribe();
    this.unsubscribe = null;
  }

  /**
   * Handle a single inbound envelope. Exposed for direct test invocation —
   * does NOT round-trip through the bus. Never throws.
   */
  async handle(envelope: InboundEnvelope): Promise<void> {
    // 1. Schema validation first — if the envelope is malformed, log + drop.
    const parsed = InboundEnvelopeSchema.safeParse(envelope);
    if (!parsed.success) {
      this.deps.log('warn', 'gateway.dispatcher.envelope_invalid', {
        issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
      return;
    }
    const env = parsed.data;

    // 2. Rate-limit check.
    if (!this.deps.rateLimiter.check(env.sender.platformUserId, env.sender.trustTier)) {
      this.deps.log('warn', 'gateway.dispatcher.rate_limited', {
        platform: env.platform,
        platformUserId: env.sender.platformUserId,
        trustTier: env.sender.trustTier,
      });
      return;
    }

    // 3. Unknown / pairing trust tier → pairing flow (never dispatches).
    if (env.sender.trustTier === 'unknown' || env.sender.trustTier === 'pairing') {
      await this.handlePairingFlow(env);
      return;
    }

    // 4. Paired (or admin) → build TaskInput and dispatch.
    try {
      const input = this.buildTaskInput(env);
      const result = await this.deps.executeTask(input);
      const replyText = this.extractReplyText(result);
      const outbound = await this.buildOutbound(env, replyText);
      await this.deps.deliverReply(outbound);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.deps.log('error', 'gateway.dispatcher.execute_failed', {
        envelopeId: env.envelopeId,
        error: message,
      });
      // Best-effort apology — swallow any failure here too.
      try {
        const outbound = await this.buildOutbound(
          env,
          'Sorry, I hit an internal error handling that request.',
        );
        await this.deps.deliverReply(outbound);
      } catch (deliveryErr) {
        this.deps.log('error', 'gateway.dispatcher.error_reply_failed', {
          envelopeId: env.envelopeId,
          error: deliveryErr instanceof Error ? deliveryErr.message : String(deliveryErr),
        });
      }
    }
  }

  // ── Internals ─────────────────────────────────────────────────────

  private async handlePairingFlow(env: InboundEnvelope): Promise<void> {
    const text = env.message.text.trim();
    const pairMatch = text.match(/^\/pair\s+(\S+)\s*$/);

    if (!pairMatch) {
      // Any other message from an unpaired sender → instructions, no dispatch.
      await this.safeReply(env, PAIRING_INSTRUCTIONS);
      return;
    }

    const token = pairMatch[1]!;
    const now = this.now();

    // Make sure we have an identity row to promote.
    const { gatewayUserId } = this.deps.identityStore.upsertIdentity({
      profile: env.profile,
      platform: env.platform,
      platformUserId: env.sender.platformUserId,
      displayName: env.sender.displayName,
      trustTier: env.sender.trustTier,
      lastSeenMs: now,
    });

    const consumed = this.deps.identityStore.consumePairingToken({
      token,
      consumedBy: gatewayUserId,
      nowMs: now,
    });

    if (!consumed.ok) {
      const reason =
        consumed.reason === 'not-found'
          ? 'That pairing token is not recognized.'
          : consumed.reason === 'expired'
            ? 'That pairing token has expired. Ask the operator for a new one.'
            : 'That pairing token has already been used.';
      this.deps.log('info', 'gateway.dispatcher.pair_rejected', {
        envelopeId: env.envelopeId,
        reason: consumed.reason,
      });
      await this.safeReply(env, reason);
      return;
    }

    this.deps.identityStore.promoteToPaired(gatewayUserId, now);
    this.deps.log('info', 'gateway.dispatcher.pair_success', {
      envelopeId: env.envelopeId,
      gatewayUserId,
    });
    await this.safeReply(
      env,
      'Paired successfully. You can now send tasks; reply with plain text.',
    );
  }

  private buildTaskInput(env: InboundEnvelope): TaskInput {
    return {
      id: env.envelopeId,
      source: `gateway-${env.platform}` as TaskInput['source'],
      goal: env.message.text,
      taskType: 'reasoning',
      profile: env.profile,
      sessionId: `gateway-${env.platform}-${env.chat.id}`,
      originEnvelope: env,
      budget: {
        maxTokens: 0,
        maxDurationMs: 0,
        maxRetries: 0,
      },
    };
  }

  private extractReplyText(result: TaskResult): string {
    // The orchestrator's TaskResult doesn't carry a single "user text"
    // field in a stable way, so we fall back through the most common
    // observable shapes. This keeps the gateway resilient even when the
    // core loop reshapes its output envelope.
    const r = result as unknown as Record<string, unknown>;
    const candidates = [
      r.response,
      r.output,
      r.message,
      (r.summary as Record<string, unknown> | undefined)?.text,
    ];
    for (const cand of candidates) {
      if (typeof cand === 'string' && cand.trim().length > 0) return cand;
    }
    if (result.status === 'completed') {
      return 'Done.';
    }
    return `Task status: ${result.status}`;
  }

  private async buildOutbound(env: InboundEnvelope, text: string): Promise<OutboundEnvelope> {
    const truncated =
      text.length > MAX_ENVELOPE_TEXT_LEN
        ? `${text.slice(0, MAX_ENVELOPE_TEXT_LEN - 1)}…`
        : text;
    return OutboundEnvelopeSchema.parse({
      envelopeId: crypto.randomUUID(),
      platform: env.platform,
      chatId: env.chat.id,
      text: truncated,
      parseMode: 'plain',
      replyTo: env.envelopeId,
    });
  }

  private async safeReply(env: InboundEnvelope, text: string): Promise<void> {
    try {
      const outbound = await this.buildOutbound(env, text);
      await this.deps.deliverReply(outbound);
    } catch (err) {
      this.deps.log('error', 'gateway.dispatcher.reply_failed', {
        envelopeId: env.envelopeId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
