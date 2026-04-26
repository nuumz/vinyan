/**
 * registerDiscordAdapter — helper to register the bundled DiscordAdapter
 * with the W2 PluginRegistry as the `vinyan.bundled.discord` plugin.
 *
 * Mirror of `register-telegram.ts`. See that file's doc block for the full
 * rationale on `network: 'open'` and `tools: deny:['*']` — the same
 * bounded-host argument applies: the adapter only needs egress to the
 * Discord REST + Gateway endpoints.
 *
 * Axioms touched:
 *   A3 — registration is rule-based; the manifest is deterministic.
 *   A5 — internal providers get `deterministic` tier (code is host-rooted).
 *   A6 — capability envelope is tight (`tools: deny:['*']`).
 */
import type { PluginManifest } from '../plugin/manifest.ts';
import type { PluginRegistry } from '../plugin/registry.ts';
import type { DiscordAdapter } from './adapters/discord.ts';

// ── Options ────────────────────────────────────────────────────────────

export interface RegisterDiscordAdapterOptions {
  readonly registry: PluginRegistry;
  readonly adapter: DiscordAdapter;
  /** Activate immediately after registration. Default `false`. */
  readonly activate?: boolean;
}

interface RegistryWithInternalIngest {
  ingestInternal?: (manifest: PluginManifest, handle: unknown) => void;
}

// ── Result ─────────────────────────────────────────────────────────────

export interface RegisterDiscordAdapterResult {
  readonly manifest: PluginManifest;
  readonly registered: boolean;
  readonly activated: boolean;
  readonly pending?: string;
}

// ── Helper ─────────────────────────────────────────────────────────────

const PLUGIN_ID = 'vinyan.bundled.discord';
const ZERO_SHA = '0'.repeat(64);

export async function registerDiscordAdapter(
  opts: RegisterDiscordAdapterOptions,
): Promise<RegisterDiscordAdapterResult> {
  const manifest = buildDiscordManifest();

  const registryAny = opts.registry as unknown as RegistryWithInternalIngest;
  if (typeof registryAny.ingestInternal === 'function') {
    registryAny.ingestInternal(manifest, opts.adapter);
    let activated = false;
    if (opts.activate) {
      await opts.registry.activate(PLUGIN_ID);
      activated = true;
    }
    return { manifest, registered: true, activated };
  }

  return {
    manifest,
    registered: false,
    activated: false,
    pending:
      'PluginRegistry.ingestInternal is not available; DiscordAdapter ' +
      'cannot be registered until the registry exposes an internal ingest path.',
  };
}

// ── Internal manifest factory ──────────────────────────────────────────

export function buildDiscordManifest(): PluginManifest {
  return {
    pluginId: PLUGIN_ID,
    version: '1.0.0',
    category: 'messaging-adapter',
    entry: '<in-proc>',
    sha256: ZERO_SHA,
    vinyanApi: '*',
    agentContract: {
      tools: { allow: [], deny: ['*'] },
      fs: { read: [], write: [] },
      // Needed to reach discord.com (REST + Gateway WSS).
      network: 'open',
      capabilities: [],
    },
    provides: ['messaging.discord'],
    consumes: [],
    description: 'Bundled DiscordAdapter for the messaging gateway.',
  };
}
