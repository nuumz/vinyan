/**
 * Plugin Registry — shared type surface (W2).
 *
 * This module is types-only (+ one error class). Concrete behavior lives in:
 *   - `manifest.ts`    — Zod manifest schema + parser
 *   - `discovery.ts`   — 3-source discovery (project / user-home / package.json)
 *   - `signature.ts`   — integrity (SHA-256) + signature verification (stubbed)
 *   - `loader.ts`      — in-proc plugin loader
 *   - `registry.ts`    — FSM + category cardinality enforcement
 *
 * Contract anchors (docs/spec/w1-contracts.md):
 *   §1  ConfidenceTier — import from `src/core/confidence-tier.ts`.
 *   §3  Profile column — `plugin_audit` carries `profile TEXT NOT NULL DEFAULT 'default'`.
 *   §5  Category cardinality — authoritative table below mirrored in code.
 *
 * Axioms anchored:
 *   A3  Deterministic Governance — discovery order, cardinality enforcement,
 *        tier derivation, and FSM transitions are all rule-based. No LLM is
 *        in the registry's decision path.
 *   A5  Tiered Trust — effective trust tier derives from (integrity, signature,
 *        permissive-mode) triple. See `signature.effectiveTrustTier`.
 *   A6  Zero-Trust Execution — manifest declares an `agentContract` envelope
 *        (allow/deny, network stance, capabilities). Enforcement at call sites
 *        is a follow-up; this module freezes the declaration surface.
 */
import type { ConfidenceTier } from '../core/confidence-tier.ts';
import type { PluginCategory, PluginManifest } from './manifest.ts';

// ── Core runtime shapes ──────────────────────────────────────────────────

/** FSM states a plugin slot can occupy. Transitions are rule-based (A3). */
export type PluginState = 'discovered' | 'verifying' | 'loaded' | 'active' | 'deactivated' | 'rejected';

/** A plugin found on disk — pre-load discovery output. */
export interface DiscoveredPlugin {
  readonly manifest: PluginManifest;
  /** Which of the three discovery sources surfaced this plugin. */
  readonly source: 'project' | 'user-home' | 'package-json';
  /** Absolute path to the `manifest.json` that described the plugin. */
  readonly manifestPath: string;
  /** Absolute path to the plugin root directory (manifest's parent). */
  readonly rootDir: string;
}

/** A plugin that has passed integrity + signature + API-version checks and been imported. */
export interface LoadedPlugin {
  readonly manifest: PluginManifest;
  /** Whatever the plugin's default export is. Consumers cast per category. */
  readonly handle: unknown;
  /** Effective trust tier per `signature.effectiveTrustTier`. */
  readonly tier: ConfidenceTier;
  readonly loadedAt: number;
}

/** One row in the registry. Mutates state + load/tier as FSM advances. */
export interface PluginSlot {
  readonly manifest: PluginManifest;
  state: PluginState;
  loaded?: LoadedPlugin;
  activatedAt?: number;
  deactivatedAt?: number;
  rejection?: { reason: string; detail: string };
}

// ── Audit record shapes ──────────────────────────────────────────────────

/** Every state transition + verification decision writes one of these. */
export type PluginAuditEvent =
  | 'discovered'
  | 'integrity_ok'
  | 'integrity_fail'
  | 'signature_ok'
  | 'signature_fail'
  | 'loaded'
  | 'activated'
  | 'deactivated'
  | 'rejected'
  | 'unloaded';

/** Row shape for `plugin_audit` (migration 007). */
export interface PluginAuditRecord {
  /** Profile scope (w1-contracts §3). */
  profile: string;
  pluginId: string;
  pluginVersion: string;
  category: PluginCategory;
  event: PluginAuditEvent;
  /** Tier at time of event; may be null for non-tier-bearing events. */
  tier?: ConfidenceTier;
  fromState?: PluginState;
  toState?: PluginState;
  /** JSON-serializable blob of event-specific context. */
  detail?: Record<string, unknown>;
  createdAt: number;
}

// ── Errors ───────────────────────────────────────────────────────────────

/**
 * Thrown by PluginRegistry.activate() when the caller asks to activate a
 * plugin in a state that forbids activation (`rejected` or unknown id).
 */
export class PluginActivationError extends Error {
  readonly pluginId: string;
  readonly reason: string;
  constructor(pluginId: string, reason: string) {
    super(`Cannot activate plugin '${pluginId}': ${reason}`);
    this.name = 'PluginActivationError';
    this.pluginId = pluginId;
    this.reason = reason;
  }
}

/**
 * Thrown by the loader when integrity fails or the manifest API version is
 * incompatible with the running Vinyan version. The registry maps this to
 * a `rejected` slot + audit record; callers outside the registry rarely
 * need to catch it directly.
 */
export class PluginLoadError extends Error {
  readonly pluginId: string;
  readonly stage: 'integrity' | 'signature' | 'api-version' | 'import';
  readonly detail: string;
  constructor(pluginId: string, stage: PluginLoadError['stage'], detail: string) {
    super(`Plugin '${pluginId}' load failed at ${stage}: ${detail}`);
    this.name = 'PluginLoadError';
    this.pluginId = pluginId;
    this.stage = stage;
    this.detail = detail;
  }
}
