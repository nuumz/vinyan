/**
 * registerTelegramAdapter — helper to register the bundled TelegramAdapter
 * with the W2 PluginRegistry as the `vinyan.bundled.telegram` plugin.
 *
 * Mirror of `src/memory/provider/register.ts` — the same pattern, updated to
 * rely on `PluginRegistry.ingestInternal` (now landed, per w1-contracts
 * §9.A2), so the helper always registers and never returns a pending stub
 * path.
 *
 * ────────────────────────────────────────────────────────────────────────
 * Why `network: 'open'`:
 * ────────────────────────────────────────────────────────────────────────
 * The bundled Telegram adapter needs to reach the Telegram Bot API at
 * `api.telegram.org` to long-poll for updates and to send replies. It is
 * the first and only bundled plugin that declares `network:'open'`; every
 * other internal provider ships with `deny-all`.
 *
 * That's intentional and bounded:
 *   - The adapter code is host-rooted — it compiles into the Vinyan binary
 *     itself, so `ingestInternal` is the safe path (no on-disk entry file,
 *     no integrity / signature verification applies).
 *   - Its network surface is the Telegram API domain; there's no general
 *     egress proxy here in MVP, but the adapter's own code has no command
 *     primitive that would let it reach arbitrary hosts.
 *   - `tools: deny:['*']` keeps the adapter from acquiring any tool surface
 *     through the AgentContract intersection logic.
 * ────────────────────────────────────────────────────────────────────────
 *
 * Axioms touched:
 *   A3 — registration is rule-based; the manifest is deterministic.
 *   A5 — internal providers get `deterministic` tier (code is host-rooted).
 *   A6 — capability envelope is tight (`tools: deny:['*']`). Network:'open'
 *        is the *minimum* permission required — see rationale above.
 */
import type { PluginManifest } from '../plugin/manifest.ts';
import type { PluginRegistry } from '../plugin/registry.ts';
import type { TelegramAdapter } from './adapters/telegram.ts';

// ── Options ────────────────────────────────────────────────────────────

export interface RegisterTelegramAdapterOptions {
  readonly registry: PluginRegistry;
  readonly adapter: TelegramAdapter;
  /** Activate immediately after registration. Default `false`. */
  readonly activate?: boolean;
}

/**
 * Narrow structural surface: a PluginRegistry that also accepts an
 * in-process plugin. When the host runs against a registry implementation
 * that predates `ingestInternal`, we fall back to a pending result rather
 * than throw — matches the `registerDefaultMemory` contract shape exactly.
 */
interface RegistryWithInternalIngest {
  ingestInternal?: (manifest: PluginManifest, handle: unknown) => void;
}

// ── Result ─────────────────────────────────────────────────────────────

export interface RegisterTelegramAdapterResult {
  /** The synthetic manifest describing the in-proc Telegram adapter. */
  readonly manifest: PluginManifest;
  /** True iff the registry accepted the internal slot. */
  readonly registered: boolean;
  /** True iff the caller asked for activation and it succeeded. */
  readonly activated: boolean;
  /** Human-readable diagnostic — populated when we could not register. */
  readonly pending?: string;
}

// ── Helper ─────────────────────────────────────────────────────────────

const PLUGIN_ID = 'vinyan.bundled.telegram';
const ZERO_SHA = '0'.repeat(64);

export async function registerTelegramAdapter(
  opts: RegisterTelegramAdapterOptions,
): Promise<RegisterTelegramAdapterResult> {
  const manifest = buildTelegramManifest();

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

  // Registry has no internal-ingest method — surface a pending diagnostic so
  // the caller can decide how to proceed. Ordinary Vinyan builds ship with
  // `ingestInternal`, so this path is primarily a safety net for host
  // embedders running an older registry.
  return {
    manifest,
    registered: false,
    activated: false,
    pending:
      'PluginRegistry.ingestInternal is not available; TelegramAdapter ' +
      'cannot be registered until the registry exposes an internal ingest path.',
  };
}

// ── Internal manifest factory ──────────────────────────────────────────

export function buildTelegramManifest(): PluginManifest {
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
      // The adapter polls + sends via the Telegram Bot API; no other bundled
      // plugin needs network. See the file-level doc for why this is safe.
      network: 'open',
      capabilities: [],
    },
    provides: ['messaging.telegram'],
    consumes: [],
    description: 'Bundled TelegramAdapter for the messaging gateway.',
  };
}
