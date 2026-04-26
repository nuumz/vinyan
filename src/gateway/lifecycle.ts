/**
 * MessagingAdapterLifecycleManager — start/stop/health every active
 * `messaging-adapter` plugin in the registry.
 *
 * Decision anchor: [D21](../../docs/architecture/decisions.md#decision-21) —
 * adapters are adapter-only, zero execution privilege. The lifecycle manager
 * owns their start/stop lifecycle; the dispatcher (separate track) consumes
 * the inbound envelopes they publish via `GatewayAdapterContext.publishInbound`.
 *
 * Axioms:
 *   A3 — deterministic: `startAll` / `stopAll` iterate `registry.activeIn(
 *        'messaging-adapter')` in ingest order. A repeat call is a no-op for
 *        already-running adapters (tracked by `running` Map).
 *   A6 — a single misbehaving plugin (throws in `start`, handle fails
 *        `isGatewayAdapter`) is LOGGED and SKIPPED — it cannot DoS the host.
 *
 * This module is the minimum surface the factory-wiring track needs to keep
 * the orchestrator bootable even before the Gateway dispatcher is wired. The
 * dispatcher track can subscribe to `gateway:inbound` on the bus and act as
 * the other half.
 */
import type { PluginRegistry } from '../plugin/registry.ts';
import {
  type GatewayAdapter,
  type GatewayAdapterContext,
  type GatewayAdapterHealth,
  type GatewayDeliveryReceipt,
  type GatewayInboundEnvelopeMinimal,
  type GatewayOutboundEnvelope,
  type GatewayPlatform,
  isGatewayAdapter,
} from './types.ts';

// ── Deps ─────────────────────────────────────────────────────────────────

export interface MessagingAdapterLifecycleDeps {
  readonly registry: PluginRegistry;
  readonly profile: string;
  /** Structured log sink. */
  readonly log: (level: 'debug' | 'info' | 'warn' | 'error', msg: string, meta?: Record<string, unknown>) => void;
  /**
   * Bridge callback — invoked by an adapter via
   * `GatewayAdapterContext.publishInbound`. Implementation typically emits
   * `bus.emit('gateway:inbound', { envelope })` so the gateway dispatcher
   * can pick it up. Wrapped in try/catch so a bug in the consumer cannot
   * propagate through the adapter.
   */
  readonly onInbound: (envelope: GatewayInboundEnvelopeMinimal) => void;
}

// ── Reports ──────────────────────────────────────────────────────────────

export interface StartReport {
  started: string[];
  failed: Array<{ pluginId: string; error: string }>;
}

export interface StopReport {
  stopped: string[];
  failed: Array<{ pluginId: string; error: string }>;
}

export interface HealthReport {
  pluginId: string;
  health: GatewayAdapterHealth;
}

// ── Running-state snapshot ───────────────────────────────────────────────

interface RunningEntry {
  readonly pluginId: string;
  readonly platform: string;
  readonly adapter: GatewayAdapter;
}

// ── Manager ──────────────────────────────────────────────────────────────

export class MessagingAdapterLifecycleManager {
  private readonly registry: PluginRegistry;
  private readonly profile: string;
  private readonly log: MessagingAdapterLifecycleDeps['log'];
  private readonly onInbound: MessagingAdapterLifecycleDeps['onInbound'];
  /** Adapters currently running, keyed by pluginId. Used to keep `startAll`
   * idempotent and to drive `stopAll`. */
  private readonly runningMap = new Map<string, RunningEntry>();

  constructor(deps: MessagingAdapterLifecycleDeps) {
    this.registry = deps.registry;
    this.profile = deps.profile;
    this.log = deps.log;
    this.onInbound = deps.onInbound;
  }

  /**
   * Start every currently active `messaging-adapter` plugin. Idempotent —
   * adapters already in `runningMap` are left alone and not counted in
   * `report.started`.
   *
   * A misbehaving adapter (throws on `start`, or whose handle fails the
   * `isGatewayAdapter` guard) is isolated: logged + captured into
   * `report.failed`, with subsequent adapters still attempted. Host
   * remains bootable (A6).
   */
  async startAll(): Promise<StartReport> {
    const started: string[] = [];
    const failed: Array<{ pluginId: string; error: string }> = [];

    for (const slot of this.registry.activeIn('messaging-adapter')) {
      const pluginId = slot.manifest.pluginId;
      if (this.runningMap.has(pluginId)) {
        // Idempotent — already started.
        continue;
      }
      const handle = slot.loaded?.handle;
      if (!isGatewayAdapter(handle)) {
        this.log('warn', 'messaging adapter plugin handle is not a GatewayAdapter — skipping', {
          pluginId,
        });
        failed.push({ pluginId, error: 'plugin handle does not implement GatewayAdapter' });
        continue;
      }
      const adapter = handle;
      const ctx: GatewayAdapterContext = {
        publishInbound: (envelope: GatewayInboundEnvelopeMinimal) => {
          try {
            this.onInbound(envelope);
          } catch (err) {
            this.log('error', 'onInbound callback threw — envelope dropped', {
              pluginId,
              envelopeId: envelope.envelopeId,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        },
        profile: this.profile,
        log: (level, msg, meta) => this.log(level, `[adapter:${pluginId}] ${msg}`, meta),
      };
      try {
        await adapter.start(ctx);
        this.runningMap.set(pluginId, { pluginId, platform: adapter.platform, adapter });
        started.push(pluginId);
        this.log('info', 'messaging adapter started', {
          pluginId,
          platform: adapter.platform,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.log('error', 'messaging adapter start failed', { pluginId, error: msg });
        failed.push({ pluginId, error: msg });
      }
    }

    return { started, failed };
  }

  /**
   * Stop every currently running adapter. Safe to call when nothing is
   * running. After this resolves, `startAll` can safely re-start adapters
   * still active in the registry.
   */
  async stopAll(): Promise<StopReport> {
    const stopped: string[] = [];
    const failed: Array<{ pluginId: string; error: string }> = [];

    // Snapshot keys — we mutate runningMap during iteration.
    const entries = [...this.runningMap.values()];
    for (const entry of entries) {
      try {
        await entry.adapter.stop();
        stopped.push(entry.pluginId);
        this.log('info', 'messaging adapter stopped', {
          pluginId: entry.pluginId,
          platform: entry.platform,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.log('error', 'messaging adapter stop failed', { pluginId: entry.pluginId, error: msg });
        failed.push({ pluginId: entry.pluginId, error: msg });
      } finally {
        this.runningMap.delete(entry.pluginId);
      }
    }

    return { stopped, failed };
  }

  /**
   * Invoke `healthcheck` on each running adapter. A misbehaving healthcheck
   * (throws) surfaces as an `ok: false` report rather than propagating.
   */
  async healthAll(): Promise<HealthReport[]> {
    const out: HealthReport[] = [];
    for (const entry of this.runningMap.values()) {
      try {
        const health = await entry.adapter.healthcheck();
        out.push({ pluginId: entry.pluginId, health });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.log('warn', 'messaging adapter healthcheck failed', {
          pluginId: entry.pluginId,
          error: msg,
        });
        out.push({
          pluginId: entry.pluginId,
          health: { ok: false, lastError: msg },
        });
      }
    }
    return out;
  }

  /** Observability: list of adapters currently running. */
  running(): readonly { pluginId: string; platform: string }[] {
    return [...this.runningMap.values()].map((e) => ({
      pluginId: e.pluginId,
      platform: e.platform,
    }));
  }

  /**
   * Look up the running adapter whose `platform` matches. Returns `undefined`
   * when no adapter for that platform is running.
   *
   * Helper for the dispatcher's reply path: `deliverReply` resolves the right
   * adapter from the outbound envelope's `platform` and forwards the call.
   * Note — multiple adapters could in theory share a platform (e.g. two
   * Telegram bots); this returns the first match in ingest order, which is
   * deterministic (A3) per the underlying `runningMap` iteration order.
   */
  getAdapterByPlatform(platform: GatewayPlatform): GatewayAdapter | undefined {
    for (const entry of this.runningMap.values()) {
      if (entry.platform === platform) return entry.adapter;
    }
    return undefined;
  }

  /**
   * Deliver an outbound envelope by looking up the running adapter for
   * `envelope.platform` and calling its `deliver`. A broken adapter (throws
   * synchronously or asynchronously) is wrapped into a failing receipt —
   * nothing bubbles out to the dispatcher.
   *
   * Returns a structural {@link GatewayDeliveryReceipt}:
   *   - `{ ok: false, error: 'no running adapter for platform <p>' }`
   *     when no adapter is registered / started for that platform.
   *   - `{ ok: false, error: <msg> }` when the adapter's `deliver` throws.
   *   - the adapter's own receipt otherwise.
   */
  async deliver(envelope: GatewayOutboundEnvelope): Promise<GatewayDeliveryReceipt> {
    const adapter = this.getAdapterByPlatform(envelope.platform);
    if (!adapter) {
      return { ok: false, error: `no running adapter for platform ${envelope.platform}` };
    }
    try {
      return await adapter.deliver(envelope);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log('error', 'messaging adapter deliver threw', {
        platform: envelope.platform,
        error: msg,
      });
      return { ok: false, error: msg };
    }
  }
}
