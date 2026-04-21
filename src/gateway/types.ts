/**
 * Gateway — shared contract surface.
 *
 * This file is the minimum interface both the Gateway implementation and
 * the orchestrator factory need to know about. It is deliberately tiny so
 * two tracks (factory wiring + adapter implementation) can ship in parallel
 * without stepping on each other.
 *
 * Decision reference: [D21](../../docs/architecture/decisions.md#decision-21)
 * — messaging adapters are adapter-only, zero execution privilege; they
 * publish to the EventBus and the dispatcher calls `executeTask`.
 *
 * w1-contracts §4 is authoritative for `TaskInput.source`; adapters set
 * `source: 'gateway-telegram' | 'gateway-slack' | …` when constructing the
 * envelope.
 */

export type GatewayPlatform =
  | 'telegram'
  | 'slack'
  | 'discord'
  | 'whatsapp'
  | 'signal'
  | 'email';

/**
 * Minimum shape every messaging adapter must expose. Registered with the
 * `PluginRegistry` as a `messaging-adapter:multi` plugin. The
 * `MessagingAdapterLifecycleManager` iterates `registry.activeIn(
 * 'messaging-adapter')` and calls these four methods.
 *
 * Adapters never call `executeTask` directly. They publish an
 * `InboundEnvelope` onto the bus; the dispatcher owns the core-loop entry.
 */
export interface GatewayAdapter {
  readonly platform: GatewayPlatform;
  start(ctx: GatewayAdapterContext): Promise<void>;
  stop(): Promise<void>;
  deliver(envelope: GatewayOutboundEnvelope): Promise<GatewayDeliveryReceipt>;
  healthcheck(): Promise<GatewayAdapterHealth>;
}

/**
 * Context passed to an adapter at `start()`. The full shape is declared in
 * `src/gateway/dispatcher/context.ts` by the adapter-implementation track;
 * this structural surface is the minimum factory wiring needs to see.
 */
export interface GatewayAdapterContext {
  /** Publish an inbound envelope. Exact bus type owned by the gateway track. */
  publishInbound(envelope: GatewayInboundEnvelopeMinimal): void;
  /** Profile the adapter runs in (from factory). */
  readonly profile: string;
  /** Structured log sink. */
  log(level: 'debug' | 'info' | 'warn' | 'error', msg: string, meta?: Record<string, unknown>): void;
}

/**
 * Structural minimum for an inbound envelope — full Zod schema lives in
 * `src/gateway/envelope.ts` (gateway-implementation track).
 */
export interface GatewayInboundEnvelopeMinimal {
  readonly envelopeId: string;
  readonly platform: GatewayPlatform;
  readonly profile: string;
  readonly receivedAt: number;
  readonly text: string;
}

/** Structural minimum for an outbound envelope. */
export interface GatewayOutboundEnvelope {
  readonly envelopeId: string;
  readonly platform: GatewayPlatform;
  readonly chatId: string;
  readonly text: string;
  readonly replyTo?: string;
}

export interface GatewayDeliveryReceipt {
  readonly ok: boolean;
  readonly platformMessageId?: string;
  readonly deliveredAt?: number;
  readonly error?: string;
}

export interface GatewayAdapterHealth {
  readonly ok: boolean;
  readonly lastSuccessfulPollAt?: number;
  readonly lastError?: string;
}

/**
 * Type guard for a loaded plugin handle in the `messaging-adapter` category.
 * The plugin registry stores handles as `unknown`; consumers cast through
 * this guard to stay honest.
 */
export function isGatewayAdapter(value: unknown): value is GatewayAdapter {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.platform === 'string' &&
    typeof v.start === 'function' &&
    typeof v.stop === 'function' &&
    typeof v.deliver === 'function' &&
    typeof v.healthcheck === 'function'
  );
}
