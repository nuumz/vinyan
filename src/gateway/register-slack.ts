/**
 * registerSlackAdapter — helper to register the bundled SlackAdapter with
 * the W2 PluginRegistry as the `vinyan.bundled.slack` plugin.
 *
 * Mirror of `register-telegram.ts`. See that file's doc block for the full
 * rationale on `network: 'open'` and `tools: deny:['*']` — the same
 * bounded-host argument applies: the adapter only needs egress to the
 * Slack Web API + Socket Mode WebSocket.
 *
 * Axioms touched:
 *   A3 — registration is rule-based; the manifest is deterministic.
 *   A5 — internal providers get `deterministic` tier (code is host-rooted).
 *   A6 — capability envelope is tight (`tools: deny:['*']`).
 */
import type { PluginManifest } from '../plugin/manifest.ts';
import type { PluginRegistry } from '../plugin/registry.ts';
import type { SlackAdapter } from './adapters/slack.ts';

// ── Options ────────────────────────────────────────────────────────────

export interface RegisterSlackAdapterOptions {
  readonly registry: PluginRegistry;
  readonly adapter: SlackAdapter;
  /** Activate immediately after registration. Default `false`. */
  readonly activate?: boolean;
}

interface RegistryWithInternalIngest {
  ingestInternal?: (manifest: PluginManifest, handle: unknown) => void;
}

// ── Result ─────────────────────────────────────────────────────────────

export interface RegisterSlackAdapterResult {
  readonly manifest: PluginManifest;
  readonly registered: boolean;
  readonly activated: boolean;
  readonly pending?: string;
}

// ── Helper ─────────────────────────────────────────────────────────────

const PLUGIN_ID = 'vinyan.bundled.slack';
const ZERO_SHA = '0'.repeat(64);

export async function registerSlackAdapter(
  opts: RegisterSlackAdapterOptions,
): Promise<RegisterSlackAdapterResult> {
  const manifest = buildSlackManifest();

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
      'PluginRegistry.ingestInternal is not available; SlackAdapter ' +
      'cannot be registered until the registry exposes an internal ingest path.',
  };
}

// ── Internal manifest factory ──────────────────────────────────────────

export function buildSlackManifest(): PluginManifest {
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
      // Needed to reach slack.com (Web API + Socket Mode WSS).
      network: 'open',
      capabilities: [],
    },
    provides: ['messaging.slack'],
    consumes: [],
    description: 'Bundled SlackAdapter for the messaging gateway.',
  };
}
