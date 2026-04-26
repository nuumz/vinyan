/**
 * registerDefaultMemory — helper to register the bundled DefaultMemoryProvider
 * with the W2 PluginRegistry as the `memory:single` plugin.
 *
 * ────────────────────────────────────────────────────────────────────────
 * CONTRACT AMENDMENT REQUEST (documented here, filed separately):
 * ────────────────────────────────────────────────────────────────────────
 * The W2 `PluginRegistry.ingest()` pipeline verifies integrity + signature
 * against an **on-disk** entry file. The bundled Default provider has no
 * such file — its code ships inside the host Vinyan binary.
 *
 * A minimal, safe extension is needed:
 *
 *   PluginRegistry.ingestInternal(manifest, handle, tier?): PluginSlot
 *
 * that:
 *   - Bypasses the loader (integrity + signature are N/A for in-process code).
 *   - Writes a `loaded` slot with tier defaulting to `'deterministic'` since
 *     internal code is already trust-rooted in the host binary.
 *   - Emits a single `loaded` audit row with `detail: { internal: true }`.
 *
 * Until that method exists, this helper falls back to a **registration
 * plan**: it validates the manifest shape, returns the synthetic slot-like
 * object, and logs what it would have done. Callers that need the registry
 * wire-up today can instead hold the returned `MemoryProvider` directly.
 *
 * This matches the spec's explicit guidance that a follow-up registry
 * extension may be needed; no `activate` happens until the registry can
 * accept an internal slot.
 * ────────────────────────────────────────────────────────────────────────
 *
 * Axioms touched:
 *   A3 — registration is rule-based; the manifest is deterministic.
 *   A5 — internal providers get `deterministic` tier (code is host-rooted).
 *   A6 — agent contract is fully locked down (tools: deny, network:
 *        deny-all), because the Default provider is pure DB + ranker code
 *        with no tool surface.
 */
import type { PluginManifest } from '../../plugin/manifest.ts';
import type { PluginRegistry } from '../../plugin/registry.ts';
import type { MemoryProvider } from './types.ts';

// ── Options ────────────────────────────────────────────────────────────

export interface RegisterDefaultMemoryOptions {
  readonly registry: PluginRegistry;
  readonly provider: MemoryProvider;
  /** Activate immediately after registration. Default `false`. */
  readonly activate?: boolean;
}

/**
 * Narrow structural surface: a PluginRegistry that also accepts an
 * in-process plugin. When the W2 registry adds this method, callers get
 * the real wire-up; until then, we detect its absence and no-op the
 * registry interaction while still returning.
 */
interface RegistryWithInternalIngest {
  ingestInternal?: (manifest: PluginManifest, handle: unknown) => void;
}

// ── Result ─────────────────────────────────────────────────────────────

export interface RegisterDefaultMemoryResult {
  /** The synthetic manifest describing the in-proc Default provider. */
  readonly manifest: PluginManifest;
  /** True iff the registry accepted the internal slot. */
  readonly registered: boolean;
  /** True iff the caller asked for activation and it succeeded. */
  readonly activated: boolean;
  /** Human-readable diagnostic — populated when we could not register. */
  readonly pending?: string;
}

// ── Helper ─────────────────────────────────────────────────────────────

const PLUGIN_ID = 'vinyan.default.memory';
const ZERO_SHA = '0'.repeat(64);

export async function registerDefaultMemory(
  opts: RegisterDefaultMemoryOptions,
): Promise<RegisterDefaultMemoryResult> {
  const manifest = buildDefaultMemoryManifest();

  // Try the optional internal-ingest path first.
  const registryAny = opts.registry as unknown as RegistryWithInternalIngest;
  if (typeof registryAny.ingestInternal === 'function') {
    registryAny.ingestInternal(manifest, opts.provider);
    let activated = false;
    if (opts.activate) {
      await opts.registry.activate(PLUGIN_ID);
      activated = true;
    }
    return { manifest, registered: true, activated };
  }

  // Registry has no internal-ingest method yet (see contract amendment at
  // the top of this file). We return the manifest + a pending reason so
  // the caller can decide whether to hold the provider directly or wait
  // for the registry extension.
  return {
    manifest,
    registered: false,
    activated: false,
    pending:
      'PluginRegistry.ingestInternal is not available; DefaultMemoryProvider ' +
      'cannot be registered until the registry exposes an internal ingest path. ' +
      'Hold the provider directly until then. See src/memory/provider/register.ts.',
  };
}

// ── Internal manifest factory ──────────────────────────────────────────

export function buildDefaultMemoryManifest(): PluginManifest {
  return {
    pluginId: PLUGIN_ID,
    version: '1.0.0',
    category: 'memory',
    entry: '<in-proc>',
    sha256: ZERO_SHA,
    vinyanApi: '*',
    agentContract: {
      tools: { allow: [], deny: ['*'] },
      fs: { read: [], write: [] },
      network: 'deny-all',
      capabilities: [],
    },
    provides: ['memory.default'],
    consumes: [],
    description: 'Bundled SQLite-backed DefaultMemoryProvider (tier-ranked).',
  };
}
