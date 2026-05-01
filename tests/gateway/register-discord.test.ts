/**
 * registerDiscordAdapter — bundled Discord adapter ingestion helper.
 */
import { Database } from 'bun:sqlite';
import { migration001 } from '../../src/db/migrations/001_initial_schema.ts';
import { afterEach, describe, expect, it } from 'bun:test';
import { MigrationRunner } from '../../src/db/migrations/migration-runner.ts';
import { PluginAuditStore } from '../../src/db/plugin-audit-store.ts';
import { DiscordAdapter } from '../../src/gateway/adapters/discord.ts';
import { DiscordApi } from '../../src/gateway/adapters/discord-api.ts';
import { buildDiscordManifest, registerDiscordAdapter } from '../../src/gateway/register-discord.ts';
import { InprocLoader } from '../../src/plugin/loader.ts';
import { PluginRegistry } from '../../src/plugin/registry.ts';
import type { TrustConfig } from '../../src/plugin/signature.ts';

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
  new MigrationRunner().migrate(db, [migration001]);
  const audit = new PluginAuditStore(db);
  const loader = new InprocLoader({ allowedVinyanApi: '*' });
  const trust: TrustConfig = { publishers: [], permissive: true };
  return new PluginRegistry({ loader, trust, auditStore: audit, profile: 'default' });
}

function fakeDiscordAdapter(): DiscordAdapter {
  const stubFetch = (async () => new Response('{}')) as unknown as typeof fetch;
  const api = new DiscordApi({
    botToken: 'TEST',
    fetchImpl: stubFetch,
    wsImpl: class {
      send(): void {}
      close(): void {}
      onopen = null;
      onmessage = null;
      onerror = null;
      onclose = null;
      readyState = 1;
      constructor(_: string) {}
    } as unknown as new (url: string) => never,
  });
  return new DiscordAdapter({ botToken: 'TEST', api });
}

describe('buildDiscordManifest', () => {
  it('produces a valid messaging-adapter manifest with network=open', () => {
    const m = buildDiscordManifest();
    expect(m.pluginId).toBe('vinyan.bundled.discord');
    expect(m.category).toBe('messaging-adapter');
    expect(m.version).toBe('1.0.0');
    expect(m.vinyanApi).toBe('*');
    expect(m.agentContract.network).toBe('open');
    expect(m.agentContract.tools.deny).toEqual(['*']);
    expect(m.provides).toEqual(['messaging.discord']);
  });
});

describe('registerDiscordAdapter', () => {
  it('registers via ingestInternal and activates the slot when asked', async () => {
    const registry = freshRegistry();
    const adapter = fakeDiscordAdapter();

    const result = await registerDiscordAdapter({ registry, adapter, activate: true });

    expect(result.registered).toBe(true);
    expect(result.activated).toBe(true);
    expect(result.pending).toBeUndefined();

    const active = registry.activeIn('messaging-adapter');
    expect(active).toHaveLength(1);
    expect(active[0]!.manifest.pluginId).toBe('vinyan.bundled.discord');
    expect(active[0]!.state).toBe('active');
  });

  it('with activate=false, leaves the slot in loaded state', async () => {
    const registry = freshRegistry();
    const adapter = fakeDiscordAdapter();

    const result = await registerDiscordAdapter({ registry, adapter, activate: false });

    expect(result.registered).toBe(true);
    expect(result.activated).toBe(false);
    const slot = registry.get('vinyan.bundled.discord');
    expect(slot?.state).toBe('loaded');
  });

  it('activation is idempotent — re-activating is safe', async () => {
    const registry = freshRegistry();
    const adapter = fakeDiscordAdapter();

    await registerDiscordAdapter({ registry, adapter, activate: true });
    await registry.activate('vinyan.bundled.discord');

    const active = registry.activeIn('messaging-adapter');
    expect(active).toHaveLength(1);
    expect(active[0]!.state).toBe('active');
  });

  it('falls back to pending when registry lacks ingestInternal', async () => {
    const stub = {
      activate: async () => {
        throw new Error('should not be called');
      },
    } as unknown as PluginRegistry;

    const result = await registerDiscordAdapter({
      registry: stub,
      adapter: fakeDiscordAdapter(),
      activate: true,
    });

    expect(result.registered).toBe(false);
    expect(result.activated).toBe(false);
    expect(result.pending).toBeDefined();
    expect(result.pending).toContain('ingestInternal');
  });
});
