/**
 * MessagingAdapterLifecycleManager — start/stop/health + idempotency +
 * fault-isolation semantics.
 *
 * Uses `ingestInternal` to place fake GatewayAdapter plugins into a real
 * PluginRegistry against an in-memory SQLite so the cardinality + audit
 * path stays on the critical path.
 */
import { Database } from 'bun:sqlite';
import { migration001 } from '../../src/db/migrations/001_initial_schema.ts';
import { afterEach, describe, expect, it } from 'bun:test';
import { MigrationRunner } from '../../src/db/migrations/migration-runner.ts';
import { PluginAuditStore } from '../../src/db/plugin-audit-store.ts';
import { type MessagingAdapterLifecycleDeps, MessagingAdapterLifecycleManager } from '../../src/gateway/lifecycle.ts';
import type {
  GatewayAdapter,
  GatewayAdapterContext,
  GatewayAdapterHealth,
  GatewayDeliveryReceipt,
  GatewayInboundEnvelopeMinimal,
  GatewayOutboundEnvelope,
} from '../../src/gateway/types.ts';
import { InprocLoader, type TrustConfig } from '../../src/plugin/index.ts';
import { type PluginManifest, PluginManifestSchema } from '../../src/plugin/manifest.ts';
import { PluginRegistry } from '../../src/plugin/registry.ts';

// ── Fake adapter ────────────────────────────────────────────────────────

function fakeAdapterManifest(pluginId: string): PluginManifest {
  return PluginManifestSchema.parse({
    pluginId,
    version: '1.0.0',
    category: 'messaging-adapter',
    entry: '<in-proc>',
    sha256: '0'.repeat(64),
    vinyanApi: '*',
    agentContract: {
      tools: { allow: [], deny: ['*'] },
      fs: { read: [], write: [] },
      network: 'deny-all',
      capabilities: [],
    },
  });
}

interface FakeAdapterOpts {
  platform?: GatewayAdapter['platform'];
  throwOnStart?: boolean;
  health?: GatewayAdapterHealth;
}

interface FakeAdapter extends GatewayAdapter {
  startCalls: number;
  stopCalls: number;
  ctxs: GatewayAdapterContext[];
}

function makeFakeAdapter(opts: FakeAdapterOpts = {}): FakeAdapter {
  const adapter: FakeAdapter = {
    platform: opts.platform ?? 'telegram',
    startCalls: 0,
    stopCalls: 0,
    ctxs: [],
    async start(ctx: GatewayAdapterContext): Promise<void> {
      adapter.startCalls++;
      adapter.ctxs.push(ctx);
      if (opts.throwOnStart) throw new Error('boom in start');
    },
    async stop(): Promise<void> {
      adapter.stopCalls++;
    },
    async deliver(_: GatewayOutboundEnvelope): Promise<GatewayDeliveryReceipt> {
      return { ok: true, platformMessageId: 'm-1', deliveredAt: Date.now() };
    },
    async healthcheck(): Promise<GatewayAdapterHealth> {
      return opts.health ?? { ok: true, lastSuccessfulPollAt: Date.now() };
    },
  };
  return adapter;
}

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
  new MigrationRunner().migrate(db, [migration001]);
  const audit = new PluginAuditStore(db);
  const loader = new InprocLoader({ allowedVinyanApi: '*' });
  const trust: TrustConfig = { publishers: [], permissive: true };
  return new PluginRegistry({ loader, trust, auditStore: audit, profile: 'default' });
}

interface HarnessResult {
  lifecycle: MessagingAdapterLifecycleManager;
  logs: Array<{ level: string; msg: string; meta?: Record<string, unknown> }>;
  inbounds: GatewayInboundEnvelopeMinimal[];
}

function makeLifecycle(registry: PluginRegistry): HarnessResult {
  const logs: HarnessResult['logs'] = [];
  const inbounds: GatewayInboundEnvelopeMinimal[] = [];
  const deps: MessagingAdapterLifecycleDeps = {
    registry,
    profile: 'default',
    log: (level, msg, meta) => logs.push({ level, msg, meta }),
    onInbound: (env) => inbounds.push(env),
  };
  return { lifecycle: new MessagingAdapterLifecycleManager(deps), logs, inbounds };
}

// ── Tests ───────────────────────────────────────────────────────────────

describe('MessagingAdapterLifecycleManager', () => {
  it('startAll starts every active messaging-adapter exactly once (idempotent)', async () => {
    const registry = freshRegistry();
    const adapter = makeFakeAdapter();
    registry.ingestInternal(fakeAdapterManifest('test.telegram'), adapter);
    await registry.activate('test.telegram');

    const { lifecycle } = makeLifecycle(registry);

    const r1 = await lifecycle.startAll();
    expect(r1.started).toEqual(['test.telegram']);
    expect(r1.failed).toEqual([]);
    expect(adapter.startCalls).toBe(1);

    // Second call should be a no-op.
    const r2 = await lifecycle.startAll();
    expect(r2.started).toEqual([]);
    expect(adapter.startCalls).toBe(1);

    expect(lifecycle.running().map((e) => e.pluginId)).toEqual(['test.telegram']);
  });

  it('stopAll stops running adapters; further startAll re-starts them', async () => {
    const registry = freshRegistry();
    const adapter = makeFakeAdapter();
    registry.ingestInternal(fakeAdapterManifest('test.slack'), adapter);
    await registry.activate('test.slack');

    const { lifecycle } = makeLifecycle(registry);
    await lifecycle.startAll();
    expect(adapter.startCalls).toBe(1);

    const stop = await lifecycle.stopAll();
    expect(stop.stopped).toEqual(['test.slack']);
    expect(stop.failed).toEqual([]);
    expect(adapter.stopCalls).toBe(1);
    expect(lifecycle.running()).toEqual([]);

    // After stop, a fresh startAll should start the adapter again.
    await lifecycle.startAll();
    expect(adapter.startCalls).toBe(2);
  });

  it('start failure in one adapter is reported; other adapters still start', async () => {
    const registry = freshRegistry();
    const good = makeFakeAdapter({ platform: 'telegram' });
    const bad = makeFakeAdapter({ platform: 'slack', throwOnStart: true });
    registry.ingestInternal(fakeAdapterManifest('good.one'), good);
    registry.ingestInternal(fakeAdapterManifest('bad.one'), bad);
    await registry.activate('good.one');
    await registry.activate('bad.one');

    const { lifecycle, logs } = makeLifecycle(registry);

    const report = await lifecycle.startAll();
    expect(report.started).toEqual(['good.one']);
    expect(report.failed).toHaveLength(1);
    expect(report.failed[0]!.pluginId).toBe('bad.one');
    expect(report.failed[0]!.error).toContain('boom');

    // Good adapter should be running; bad adapter should NOT be in runningMap.
    expect(lifecycle.running().map((e) => e.pluginId)).toEqual(['good.one']);

    const badErrLogs = logs.filter((l) => l.level === 'error' && l.msg.includes('start failed'));
    expect(badErrLogs.length).toBeGreaterThan(0);
  });

  it('non-GatewayAdapter handle is logged and skipped, not thrown', async () => {
    const registry = freshRegistry();
    // Register a handle that does not satisfy isGatewayAdapter.
    registry.ingestInternal(fakeAdapterManifest('bogus.one'), {
      platform: 'telegram',
      // Missing start/stop/deliver/healthcheck — guard should reject.
    } as unknown);
    await registry.activate('bogus.one');

    const { lifecycle, logs } = makeLifecycle(registry);
    const report = await lifecycle.startAll();
    expect(report.started).toEqual([]);
    expect(report.failed).toHaveLength(1);
    expect(report.failed[0]!.pluginId).toBe('bogus.one');

    const warned = logs.some((l) => l.level === 'warn' && l.msg.includes('not a GatewayAdapter'));
    expect(warned).toBe(true);
  });

  it('healthAll returns per-adapter healthchecks', async () => {
    const registry = freshRegistry();
    const adapter = makeFakeAdapter({
      health: { ok: true, lastSuccessfulPollAt: 111 },
    });
    registry.ingestInternal(fakeAdapterManifest('h.one'), adapter);
    await registry.activate('h.one');

    const { lifecycle } = makeLifecycle(registry);
    await lifecycle.startAll();

    const reports = await lifecycle.healthAll();
    expect(reports).toHaveLength(1);
    expect(reports[0]!.pluginId).toBe('h.one');
    expect(reports[0]!.health.ok).toBe(true);
    expect(reports[0]!.health.lastSuccessfulPollAt).toBe(111);
  });

  it('adapter publishInbound routes through onInbound callback', async () => {
    const registry = freshRegistry();
    const adapter = makeFakeAdapter();
    registry.ingestInternal(fakeAdapterManifest('pi.one'), adapter);
    await registry.activate('pi.one');

    const { lifecycle, inbounds } = makeLifecycle(registry);
    await lifecycle.startAll();
    const ctx = adapter.ctxs[0]!;

    const envelope: GatewayInboundEnvelopeMinimal = {
      envelopeId: 'e-1',
      platform: 'telegram',
      profile: 'default',
      receivedAt: 12345,
      text: 'hello',
    };
    ctx.publishInbound(envelope);

    expect(inbounds).toHaveLength(1);
    expect(inbounds[0]).toEqual(envelope);
    // Lifecycle itself has a reference to keep TS happy.
    expect(lifecycle.running()).toHaveLength(1);
  });

  it('deliver routes to the running adapter matching envelope.platform', async () => {
    const registry = freshRegistry();
    const tg = makeFakeAdapter({ platform: 'telegram' });
    const slack = makeFakeAdapter({ platform: 'slack' });
    registry.ingestInternal(fakeAdapterManifest('d.tg'), tg);
    registry.ingestInternal(fakeAdapterManifest('d.slack'), slack);
    await registry.activate('d.tg');
    await registry.activate('d.slack');

    const { lifecycle } = makeLifecycle(registry);
    await lifecycle.startAll();

    const deliverCalls: GatewayOutboundEnvelope[] = [];
    tg.deliver = async (env: GatewayOutboundEnvelope): Promise<GatewayDeliveryReceipt> => {
      deliverCalls.push(env);
      return { ok: true, platformMessageId: 'tg-1', deliveredAt: 999 };
    };

    const envelope: GatewayOutboundEnvelope = {
      envelopeId: 'o-1',
      platform: 'telegram',
      chatId: 'c-1',
      text: 'hi',
    };
    const receipt = await lifecycle.deliver(envelope);

    expect(receipt.ok).toBe(true);
    expect(receipt.platformMessageId).toBe('tg-1');
    expect(deliverCalls).toHaveLength(1);
    expect(deliverCalls[0]!.chatId).toBe('c-1');
  });

  it('deliver returns ok:false when no running adapter matches the platform', async () => {
    const registry = freshRegistry();
    const tg = makeFakeAdapter({ platform: 'telegram' });
    registry.ingestInternal(fakeAdapterManifest('d.onlytg'), tg);
    await registry.activate('d.onlytg');

    const { lifecycle } = makeLifecycle(registry);
    await lifecycle.startAll();

    const receipt = await lifecycle.deliver({
      envelopeId: 'o-2',
      platform: 'slack',
      chatId: 'c',
      text: 't',
    });

    expect(receipt.ok).toBe(false);
    expect(receipt.error).toContain('no running adapter for platform slack');
  });

  it('deliver captures adapter errors as ok:false, does not throw', async () => {
    const registry = freshRegistry();
    const tg = makeFakeAdapter({ platform: 'telegram' });
    registry.ingestInternal(fakeAdapterManifest('d.throws'), tg);
    await registry.activate('d.throws');

    const { lifecycle, logs } = makeLifecycle(registry);
    await lifecycle.startAll();

    tg.deliver = async () => {
      throw new Error('adapter boom');
    };

    const receipt = await lifecycle.deliver({
      envelopeId: 'o-3',
      platform: 'telegram',
      chatId: 'c',
      text: 't',
    });

    expect(receipt.ok).toBe(false);
    expect(receipt.error).toContain('adapter boom');
    // Error should be logged (observability) but NOT re-thrown.
    expect(logs.some((l) => l.level === 'error' && l.msg.includes('deliver threw'))).toBe(true);
  });

  it('getAdapterByPlatform returns the running adapter or undefined', async () => {
    const registry = freshRegistry();
    const tg = makeFakeAdapter({ platform: 'telegram' });
    registry.ingestInternal(fakeAdapterManifest('d.get'), tg);
    await registry.activate('d.get');

    const { lifecycle } = makeLifecycle(registry);
    await lifecycle.startAll();

    expect(lifecycle.getAdapterByPlatform('telegram')).toBe(tg);
    expect(lifecycle.getAdapterByPlatform('slack')).toBeUndefined();
  });

  it('onInbound callback throwing does not propagate to the adapter', async () => {
    const registry = freshRegistry();
    const adapter = makeFakeAdapter();
    registry.ingestInternal(fakeAdapterManifest('pi.throw'), adapter);
    await registry.activate('pi.throw');

    const thrown: unknown[] = [];
    const logs: Array<{ level: string; msg: string }> = [];
    const lifecycle = new MessagingAdapterLifecycleManager({
      registry,
      profile: 'default',
      log: (level, msg) => logs.push({ level, msg }),
      onInbound: () => {
        thrown.push('bang');
        throw new Error('bang');
      },
    });
    await lifecycle.startAll();
    const ctx = adapter.ctxs[0]!;

    // Adapter's view: publishInbound must not throw back into adapter code.
    expect(() =>
      ctx.publishInbound({
        envelopeId: 'e',
        platform: 'telegram',
        profile: 'default',
        receivedAt: 0,
        text: '',
      }),
    ).not.toThrow();
    expect(thrown).toHaveLength(1);
    expect(logs.some((l) => l.level === 'error' && l.msg.includes('onInbound'))).toBe(true);
  });
});
