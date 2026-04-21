/**
 * registerTelegramAdapter — bundled Telegram adapter ingestion helper.
 *
 * Verifies that the helper:
 *   1. Builds a valid manifest (category='messaging-adapter', network='open').
 *   2. Calls `registry.ingestInternal` when the method is present, resulting
 *      in a `loaded` slot.
 *   3. Honors `activate: true` so the slot transitions to `active` and is
 *      returned by `activeIn('messaging-adapter')`.
 *   4. Is idempotent on activation — calling twice does not throw and leaves
 *      the slot in `active` state.
 */
import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, it } from 'bun:test';
import { migration007 } from '../../src/db/migrations/007_plugin_audit.ts';
import { MigrationRunner } from '../../src/db/migrations/migration-runner.ts';
import { PluginAuditStore } from '../../src/db/plugin-audit-store.ts';
import { TelegramAdapter } from '../../src/gateway/adapters/telegram.ts';
import { TelegramApi, type TelegramUpdate } from '../../src/gateway/adapters/telegram-api.ts';
import { buildTelegramManifest, registerTelegramAdapter } from '../../src/gateway/register-telegram.ts';
import { InprocLoader } from '../../src/plugin/loader.ts';
import { PluginRegistry } from '../../src/plugin/registry.ts';
import type { TrustConfig } from '../../src/plugin/signature.ts';

// ── Harness ─────────────────────────────────────────────────────────────

const databases: Database[] = [];

afterEach(() => {
  while (databases.length > 0) {
    const db = databases.pop();
    try {
      db?.close();
    } catch {
      /* best-effort */
    }
  }
});

function freshRegistry(): PluginRegistry {
  const db = new Database(':memory:');
  databases.push(db);
  new MigrationRunner().migrate(db, [migration007]);
  const audit = new PluginAuditStore(db);
  const loader = new InprocLoader({ allowedVinyanApi: '*' });
  const trust: TrustConfig = { publishers: [], permissive: true };
  return new PluginRegistry({ loader, trust, auditStore: audit, profile: 'default' });
}

/**
 * Build a TelegramAdapter wired to a fake TelegramApi — no real network calls.
 * The getUpdates implementation returns an empty list forever, so the poll
 * loop spins harmlessly and start()/stop() behave without hitting the real
 * Telegram servers.
 */
function fakeTelegramAdapter(): TelegramAdapter {
  // The fetchImpl is never called — we override deleteWebhook/getUpdates
  // below. Cast through `unknown` because `typeof fetch` includes static
  // helpers (preconnect) that a stub can't satisfy.
  const stubFetch = (async () => new Response('{"ok":true,"result":true}')) as unknown as typeof fetch;
  const fakeApi = new TelegramApi({
    botToken: 'TEST_TOKEN',
    fetchImpl: stubFetch,
  });
  // Suppress actual network activity by monkey-patching the two methods the
  // poll loop invokes. The adapter's start() awaits deleteWebhook then enters
  // the getUpdates loop. Returning an empty list is fine for the poll loop.
  (fakeApi as unknown as { deleteWebhook: () => Promise<boolean> }).deleteWebhook = async () => true;
  (fakeApi as unknown as { getUpdates: () => Promise<TelegramUpdate[]> }).getUpdates = async () => [];

  return new TelegramAdapter({
    botToken: 'TEST_TOKEN',
    api: fakeApi,
  });
}

// ── Tests ───────────────────────────────────────────────────────────────

describe('buildTelegramManifest', () => {
  it('produces a valid messaging-adapter manifest with network=open', () => {
    const m = buildTelegramManifest();
    expect(m.pluginId).toBe('vinyan.bundled.telegram');
    expect(m.category).toBe('messaging-adapter');
    expect(m.version).toBe('1.0.0');
    expect(m.vinyanApi).toBe('*');
    expect(m.agentContract.network).toBe('open');
    expect(m.agentContract.tools.deny).toEqual(['*']);
    expect(m.provides).toEqual(['messaging.telegram']);
  });
});

describe('registerTelegramAdapter', () => {
  it('registers via ingestInternal and activates the slot when asked', async () => {
    const registry = freshRegistry();
    const adapter = fakeTelegramAdapter();

    const result = await registerTelegramAdapter({
      registry,
      adapter,
      activate: true,
    });

    expect(result.registered).toBe(true);
    expect(result.activated).toBe(true);
    expect(result.pending).toBeUndefined();

    const active = registry.activeIn('messaging-adapter');
    expect(active).toHaveLength(1);
    expect(active[0]!.manifest.pluginId).toBe('vinyan.bundled.telegram');
    expect(active[0]!.state).toBe('active');
  });

  it('with activate=false, leaves the slot in loaded state', async () => {
    const registry = freshRegistry();
    const adapter = fakeTelegramAdapter();

    const result = await registerTelegramAdapter({
      registry,
      adapter,
      activate: false,
    });

    expect(result.registered).toBe(true);
    expect(result.activated).toBe(false);
    const slot = registry.get('vinyan.bundled.telegram');
    expect(slot?.state).toBe('loaded');
  });

  it('activation is idempotent — re-registering + re-activating is safe', async () => {
    const registry = freshRegistry();
    const adapter = fakeTelegramAdapter();

    await registerTelegramAdapter({ registry, adapter, activate: true });
    // `activate` is idempotent at the registry level; calling it again via
    // the helper should also be a no-op.
    await registry.activate('vinyan.bundled.telegram');

    const active = registry.activeIn('messaging-adapter');
    expect(active).toHaveLength(1);
    expect(active[0]!.state).toBe('active');
  });

  it('falls back to pending when registry lacks ingestInternal', async () => {
    // Synthesize a registry-like object without ingestInternal.
    const stub = {
      activate: async () => {
        throw new Error('should not be called');
      },
    } as unknown as PluginRegistry;

    const result = await registerTelegramAdapter({
      registry: stub,
      adapter: fakeTelegramAdapter(),
      activate: true,
    });

    expect(result.registered).toBe(false);
    expect(result.activated).toBe(false);
    expect(result.pending).toBeDefined();
    expect(result.pending).toContain('ingestInternal');
  });
});
