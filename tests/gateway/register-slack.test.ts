/**
 * registerSlackAdapter — bundled Slack adapter ingestion helper.
 */
import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, it } from 'bun:test';
import { migration007 } from '../../src/db/migrations/007_plugin_audit.ts';
import { MigrationRunner } from '../../src/db/migrations/migration-runner.ts';
import { PluginAuditStore } from '../../src/db/plugin-audit-store.ts';
import { SlackAdapter } from '../../src/gateway/adapters/slack.ts';
import { SlackApi } from '../../src/gateway/adapters/slack-api.ts';
import { buildSlackManifest, registerSlackAdapter } from '../../src/gateway/register-slack.ts';
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
  new MigrationRunner().migrate(db, [migration007]);
  const audit = new PluginAuditStore(db);
  const loader = new InprocLoader({ allowedVinyanApi: '*' });
  const trust: TrustConfig = { publishers: [], permissive: true };
  return new PluginRegistry({ loader, trust, auditStore: audit, profile: 'default' });
}

function fakeSlackAdapter(): SlackAdapter {
  const stubFetch = (async () => new Response('{"ok":true}')) as unknown as typeof fetch;
  const api = new SlackApi({
    appToken: 'xapp-test',
    botToken: 'xoxb-test',
    fetchImpl: stubFetch,
    // wsImpl is supplied as a no-op class; never invoked because we don't start() in this test file.
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
  return new SlackAdapter({ appToken: 'xapp-test', botToken: 'xoxb-test', api });
}

describe('buildSlackManifest', () => {
  it('produces a valid messaging-adapter manifest with network=open', () => {
    const m = buildSlackManifest();
    expect(m.pluginId).toBe('vinyan.bundled.slack');
    expect(m.category).toBe('messaging-adapter');
    expect(m.version).toBe('1.0.0');
    expect(m.vinyanApi).toBe('*');
    expect(m.agentContract.network).toBe('open');
    expect(m.agentContract.tools.deny).toEqual(['*']);
    expect(m.provides).toEqual(['messaging.slack']);
  });
});

describe('registerSlackAdapter', () => {
  it('registers via ingestInternal and activates the slot when asked', async () => {
    const registry = freshRegistry();
    const adapter = fakeSlackAdapter();

    const result = await registerSlackAdapter({ registry, adapter, activate: true });

    expect(result.registered).toBe(true);
    expect(result.activated).toBe(true);
    expect(result.pending).toBeUndefined();

    const active = registry.activeIn('messaging-adapter');
    expect(active).toHaveLength(1);
    expect(active[0]!.manifest.pluginId).toBe('vinyan.bundled.slack');
    expect(active[0]!.state).toBe('active');
  });

  it('with activate=false, leaves the slot in loaded state', async () => {
    const registry = freshRegistry();
    const adapter = fakeSlackAdapter();

    const result = await registerSlackAdapter({ registry, adapter, activate: false });

    expect(result.registered).toBe(true);
    expect(result.activated).toBe(false);
    const slot = registry.get('vinyan.bundled.slack');
    expect(slot?.state).toBe('loaded');
  });

  it('activation is idempotent — re-activating is safe', async () => {
    const registry = freshRegistry();
    const adapter = fakeSlackAdapter();

    await registerSlackAdapter({ registry, adapter, activate: true });
    await registry.activate('vinyan.bundled.slack');

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

    const result = await registerSlackAdapter({
      registry: stub,
      adapter: fakeSlackAdapter(),
      activate: true,
    });

    expect(result.registered).toBe(false);
    expect(result.activated).toBe(false);
    expect(result.pending).toBeDefined();
    expect(result.pending).toContain('ingestInternal');
  });
});
