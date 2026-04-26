/**
 * PluginRegistry — FSM + category cardinality enforcement (W2).
 *
 * The Registry is a **rule-based** component (A3). No LLM participates in
 * any decision here. Given the same sequence of `ingest` / `activate` /
 * `deactivate` calls against the same inputs, it yields the same state and
 * audit trail.
 *
 * Cardinality rules mirror `docs/spec/w1-contracts.md` §5:
 *
 *   | Category             | Cardinality                         |
 *   |----------------------|-------------------------------------|
 *   | memory               | single (active) + fallback chain    |
 *   | context              | single                              |
 *   | skill-registry       | single (active)                     |
 *   | oracle               | multi                               |
 *   | backend              | multi                               |
 *   | messaging-adapter    | multi                               |
 *
 * Single-category activation:
 *   Activating a new plugin when another in the same category is already
 *   active deactivates the incumbent FIRST (emits `deactivated` audit),
 *   then activates the new one. The incumbent moves to `deactivated`; it
 *   is NOT rejected and can be re-activated later.
 *
 * Multi-category activation:
 *   Multiple plugins stay active simultaneously. Each activation writes
 *   an independent audit event.
 *
 * `rejected` slots:
 *   Integrity failure, untrusted signature in strict mode, API-version
 *   mismatch, or import failure moves the slot to `rejected`. The slot is
 *   kept in `list()` for observability; `activate()` on it throws
 *   `PluginActivationError`.
 *
 * Fallback chain (memory only):
 *   `fallbackChain('memory')` returns the primary (active) slot first,
 *   followed by other `loaded` memory slots in ingest order. Consumers
 *   can walk the list when the primary errors (A5: tiered fallback).
 */
import type { ConfidenceTier } from '../core/confidence-tier.ts';
import type { PluginAuditStore } from '../db/plugin-audit-store.ts';
import type { InprocLoader, LoadOutcome } from './loader.ts';
import { isSingleCategory, type PluginCategory, type PluginManifest, PluginManifestSchema } from './manifest.ts';
import type { TrustConfig } from './signature.ts';
import {
  type DiscoveredPlugin,
  PluginActivationError,
  type PluginAuditEvent,
  type PluginAuditRecord,
  type PluginSlot,
  type PluginState,
} from './types.ts';

export interface RegistryDeps {
  loader: InprocLoader;
  trust: TrustConfig;
  auditStore: PluginAuditStore;
  profile: string;
}

export class PluginRegistry {
  private readonly loader: InprocLoader;
  private readonly trust: TrustConfig;
  private readonly auditStore: PluginAuditStore;
  private readonly profile: string;
  /** Plugin slots keyed by pluginId. Insertion order = ingest order. */
  private readonly slots = new Map<string, PluginSlot>();

  constructor(deps: RegistryDeps) {
    this.loader = deps.loader;
    this.trust = deps.trust;
    this.auditStore = deps.auditStore;
    this.profile = deps.profile;
  }

  /**
   * Discover → verify → load each plugin. Does NOT activate. Failures during
   * integrity / signature / import move a slot to `rejected` with a
   * `PluginLoadError`-derived detail, but do not throw up out of this call —
   * callers want to see the full post-ingest state.
   */
  async ingest(discovered: DiscoveredPlugin[]): Promise<void> {
    for (const d of discovered) {
      const { manifest } = d;
      const pluginId = manifest.pluginId;

      // Idempotent re-ingest: drop any prior slot so we re-run the pipeline.
      // (Active incumbents are a separate concern — in practice the caller
      // should deactivate first; we don't silently preempt.)
      if (this.slots.has(pluginId)) {
        const prior = this.slots.get(pluginId);
        if (prior && prior.state === 'active') {
          // Preserve invariant: never overwrite an active slot via ingest.
          continue;
        }
        await this.loader.unload(pluginId);
        this.slots.delete(pluginId);
      }

      const slot: PluginSlot = { manifest, state: 'discovered' };
      this.slots.set(pluginId, slot);
      this.writeAudit(slot, 'discovered', undefined, 'discovered', {
        source: d.source,
        manifestPath: d.manifestPath,
      });

      // Transition: discovered → verifying (implicit — we call the loader).
      this.transition(slot, 'verifying');

      let outcome: LoadOutcome;
      try {
        outcome = await this.loader.load(d, this.trust);
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        // Decide which audit event best describes the failure stage.
        const stage = (err as { stage?: string }).stage;
        if (stage === 'integrity') {
          this.writeAudit(slot, 'integrity_fail', slot.state, 'rejected', { detail });
        } else if (stage === 'signature') {
          this.writeAudit(slot, 'signature_fail', slot.state, 'rejected', { detail });
        } else {
          this.writeAudit(slot, 'rejected', slot.state, 'rejected', { detail, stage });
        }
        slot.rejection = { reason: stage ?? 'load-failure', detail };
        this.transition(slot, 'rejected', { skipAudit: true });
        continue;
      }

      // Success path: record integrity + (possibly) signature, then loaded.
      this.writeAudit(slot, 'integrity_ok', undefined, undefined, {
        sha256: outcome.integritySha256,
      });
      if (outcome.signature.ok) {
        this.writeAudit(slot, 'signature_ok', undefined, undefined, {
          publisherId: outcome.signature.publisher.id,
        });
      } else {
        // Unsigned-but-permissive is a tracked non-failure (tier demotes to
        // speculative). We log it for observability but do not move the
        // slot to rejected.
        this.writeAudit(slot, 'signature_fail', undefined, undefined, {
          reason: outcome.signature.reason,
          permissive: this.trust.permissive,
        });
      }

      slot.loaded = outcome.loaded;
      this.transition(slot, 'loaded');
      this.writeAudit(slot, 'loaded', 'verifying', 'loaded', {
        tier: outcome.loaded.tier,
      });
    }
  }

  /**
   * Register a bundled, in-process provider without going through the
   * discovery / integrity / signature pipeline. Intended for host-rooted
   * components that ship with Vinyan itself (e.g. `DefaultMemoryProvider`),
   * where the `entry` file does not exist on disk and the SHA-256 check
   * would have nothing to verify.
   *
   * See w1-contracts §9.A2. Skipping integrity + signature is safe ONLY for
   * code that the host compiled and loaded itself — never use this path for
   * anything read from disk, network, or another process.
   *
   * Cardinality rules still apply at activation time. This call only places
   * the slot in `loaded` state with a pre-built `LoadedPlugin` handle.
   */
  ingestInternal(
    manifest: PluginManifest,
    handle: unknown,
    opts?: { tier?: ConfidenceTier },
  ): PluginSlot {
    // Validate shape even for internal callers — a bad manifest here is a
    // host-code bug, not a trust-boundary failure, but we'd rather throw
    // immediately than let a malformed slot corrupt the registry state.
    PluginManifestSchema.parse(manifest);

    const pluginId = manifest.pluginId;
    if (this.slots.has(pluginId)) {
      const prior = this.slots.get(pluginId);
      if (prior && prior.state === 'active') {
        throw new PluginActivationError(
          pluginId,
          'ingestInternal cannot overwrite an active slot; deactivate first',
        );
      }
    }

    const tier: ConfidenceTier = opts?.tier ?? 'deterministic';
    const slot: PluginSlot = {
      manifest,
      state: 'loaded',
      loaded: { manifest, handle, tier, loadedAt: Date.now() },
    };
    this.slots.set(pluginId, slot);
    this.writeAudit(slot, 'loaded', undefined, 'loaded', { internal: true, tier });
    return slot;
  }

  /** Activate a plugin. Throws `PluginActivationError` if not loaded or rejected. */
  async activate(pluginId: string): Promise<void> {
    const slot = this.slots.get(pluginId);
    if (!slot) {
      throw new PluginActivationError(pluginId, 'plugin not found');
    }
    if (slot.state === 'rejected') {
      throw new PluginActivationError(pluginId, `plugin is rejected: ${slot.rejection?.detail ?? 'unknown reason'}`);
    }
    if (!slot.loaded) {
      throw new PluginActivationError(pluginId, `plugin not loaded (state=${slot.state})`);
    }
    if (slot.state === 'active') {
      // Idempotent.
      return;
    }

    const category = slot.manifest.category;

    // Single-category preemption: deactivate any existing active slot first.
    if (isSingleCategory(category)) {
      const incumbent = this.findActiveIn(category);
      if (incumbent && incumbent.manifest.pluginId !== pluginId) {
        await this.deactivate(incumbent.manifest.pluginId);
      }
    }

    const from = slot.state;
    slot.state = 'active';
    slot.activatedAt = Date.now();
    this.writeAudit(slot, 'activated', from, 'active');
  }

  async deactivate(pluginId: string): Promise<void> {
    const slot = this.slots.get(pluginId);
    if (!slot) return;
    if (slot.state !== 'active') return;

    const from = slot.state;
    slot.state = 'deactivated';
    slot.deactivatedAt = Date.now();
    this.writeAudit(slot, 'deactivated', from, 'deactivated');
  }

  /**
   * Active plugins in a category. For single-cardinality categories this is
   * `[0..1]`. For multi-cardinality it's every plugin currently in `active`
   * state in that category, in ingest order.
   */
  activeIn(category: PluginCategory): readonly PluginSlot[] {
    const out: PluginSlot[] = [];
    for (const slot of this.slots.values()) {
      if (slot.manifest.category === category && slot.state === 'active') {
        out.push(slot);
      }
    }
    return out;
  }

  /**
   * Memory fallback chain: active slot first (if any), followed by other
   * `loaded` memory slots in ingest order. Rejected / deactivated slots are
   * excluded — they can't serve traffic.
   */
  fallbackChain(category: 'memory'): readonly PluginSlot[] {
    const chain: PluginSlot[] = [];
    let primary: PluginSlot | null = null;
    const backups: PluginSlot[] = [];
    for (const slot of this.slots.values()) {
      if (slot.manifest.category !== category) continue;
      if (slot.state === 'active') primary = slot;
      else if (slot.state === 'loaded' || slot.state === 'deactivated') backups.push(slot);
    }
    if (primary) chain.push(primary);
    chain.push(...backups);
    return chain;
  }

  /** All slots in ingest order. Includes `rejected` + `deactivated`. */
  list(): readonly PluginSlot[] {
    return [...this.slots.values()];
  }

  /** Look up a specific slot (any state). */
  get(pluginId: string): PluginSlot | undefined {
    return this.slots.get(pluginId);
  }

  // ── Internals ──────────────────────────────────────────────────────────

  private findActiveIn(category: PluginCategory): PluginSlot | null {
    for (const slot of this.slots.values()) {
      if (slot.manifest.category === category && slot.state === 'active') return slot;
    }
    return null;
  }

  private transition(slot: PluginSlot, to: PluginState, opts?: { skipAudit?: boolean }): void {
    slot.state = to;
    if (opts?.skipAudit) return;
    // Most transitions are already paired with explicit audit writes at the
    // call sites (with richer detail); this helper is a fallback for the
    // terminal-state paths that still need a canonical log line.
  }

  private writeAudit(
    slot: PluginSlot,
    event: PluginAuditEvent,
    fromState: PluginState | undefined,
    toState: PluginState | undefined,
    detail?: Record<string, unknown>,
  ): void {
    const record: PluginAuditRecord = {
      profile: this.profile,
      pluginId: slot.manifest.pluginId,
      pluginVersion: slot.manifest.version,
      category: slot.manifest.category,
      event,
      tier: slot.loaded?.tier,
      fromState,
      toState,
      detail,
      createdAt: Date.now(),
    };
    this.auditStore.record(record);
  }
}
