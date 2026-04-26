/**
 * plugin-init — Gateway integration smoke.
 *
 * Closes the ivory-tower gap end-to-end:
 *   1. `config.gateway.enabled = true` + a Telegram bot token causes
 *      `initializePlugins` to register the bundled TelegramAdapter AND
 *      construct the GatewayDispatcher.
 *   2. The dispatcher is subscribed to the bus — publishing a
 *      `gateway:inbound` event triggers `executeTask` with a TaskInput
 *      sourced `gateway-telegram`.
 *   3. The dispatcher's reply path routes through `lifecycle.deliver`, which
 *      forwards to the adapter's `deliver(envelope)` method.
 *   4. Disabling the gateway keeps the orchestrator bootable without any
 *      Gateway wiring.
 */
import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { VinyanConfigSchema } from '../../src/config/schema.ts';
import { createBus } from '../../src/core/bus.ts';
import { ALL_MIGRATIONS, MigrationRunner } from '../../src/db/migrations/index.ts';
import type {
  GatewayAdapter,
  GatewayAdapterContext,
  GatewayDeliveryReceipt,
  GatewayOutboundEnvelope,
} from '../../src/gateway/types.ts';
import { initializePlugins } from '../../src/orchestrator/plugin-init.ts';
import type { Tool } from '../../src/orchestrator/tools/tool-interface.ts';
import type { TaskInput, TaskResult } from '../../src/orchestrator/types.ts';

// ── Harness ─────────────────────────────────────────────────────────────

function freshDb(): Database {
  const db = new Database(':memory:');
  new MigrationRunner().migrate(db, ALL_MIGRATIONS);
  return db;
}

const tmpDirs: string[] = [];
function mk(prefix: string): string {
  const d = mkdtempSync(path.join(tmpdir(), `vinyan-plugininit-gateway-${prefix}-`));
  tmpDirs.push(d);
  return d;
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    const d = tmpDirs.pop();
    if (d) rmSync(d, { recursive: true, force: true });
  }
});

// ── Tests ───────────────────────────────────────────────────────────────

describe('initializePlugins — gateway integration', () => {
  it('gateway.enabled=false produces no dispatcher (baseline)', async () => {
    const db = freshDb();
    const bus = createBus();
    const cfg = VinyanConfigSchema.parse({
      plugins: {
        enabled: true,
        activateMemory: false,
        registerSkillTools: false,
        autoActivateMessagingAdapters: false,
      },
      gateway: { enabled: false, telegram: { enabled: false, allowedChats: [], pollTimeoutSec: 30 } },
    });

    const result = await initializePlugins({
      db,
      profile: 'default',
      bus,
      toolRegistry: new Map<string, Tool>(),
      pluginConfig: cfg.plugins!,
      gatewayConfig: cfg.gateway,
      vinyanHome: mk('home'),
      profileRoot: mk('profile'),
      discoveryCwd: mk('cwd'),
    });

    expect(result.dispatcher).toBeUndefined();
    expect(result.registry.activeIn('messaging-adapter')).toHaveLength(0);
  });

  it('gateway.enabled=true without executeTask warns and skips dispatcher', async () => {
    const db = freshDb();
    const bus = createBus();
    const cfg = VinyanConfigSchema.parse({
      plugins: { enabled: true, activateMemory: false, registerSkillTools: false },
      // Telegram sub-block disabled so we don't need a bot token.
      gateway: { enabled: true, telegram: { enabled: false, allowedChats: [], pollTimeoutSec: 30 } },
    });

    const result = await initializePlugins({
      db,
      profile: 'default',
      bus,
      toolRegistry: new Map<string, Tool>(),
      pluginConfig: cfg.plugins!,
      gatewayConfig: cfg.gateway,
      // executeTask intentionally omitted.
      vinyanHome: mk('home'),
      profileRoot: mk('profile'),
      discoveryCwd: mk('cwd'),
    });

    expect(result.dispatcher).toBeUndefined();
    expect(result.warnings.some((w) => w.includes('executeTask not provided'))).toBe(true);
  });

  it('gateway.telegram.enabled=true but botToken missing warns (adapter not registered)', async () => {
    const db = freshDb();
    const bus = createBus();
    const cfg = VinyanConfigSchema.parse({
      plugins: { enabled: true, activateMemory: false, registerSkillTools: false },
      gateway: {
        enabled: true,
        telegram: { enabled: true, allowedChats: [], pollTimeoutSec: 30 },
      },
    });

    const executeTaskCalls: TaskInput[] = [];
    const executeTask = async (input: TaskInput): Promise<TaskResult> => {
      executeTaskCalls.push(input);
      return {
        id: input.id,
        status: 'completed',
        routingLevel: 0,
        artifacts: [],
        traceId: 't',
      } as unknown as TaskResult;
    };

    const result = await initializePlugins({
      db,
      profile: 'default',
      bus,
      toolRegistry: new Map<string, Tool>(),
      pluginConfig: cfg.plugins!,
      gatewayConfig: cfg.gateway,
      executeTask,
      vinyanHome: mk('home'),
      profileRoot: mk('profile'),
      discoveryCwd: mk('cwd'),
    });

    expect(result.warnings.some((w) => w.includes('botToken absent'))).toBe(true);
    expect(result.registry.activeIn('messaging-adapter')).toHaveLength(0);
    // Dispatcher IS still constructed — rest of messaging gateway works even
    // without the Telegram adapter.
    expect(result.dispatcher).toBeDefined();
  });

  it('gateway.enabled=true + telegram.enabled=true + botToken + executeTask = full wire-up', async () => {
    const db = freshDb();
    const bus = createBus();
    const cfg = VinyanConfigSchema.parse({
      plugins: { enabled: true, activateMemory: false, registerSkillTools: false },
      gateway: {
        enabled: true,
        telegram: { enabled: true, botToken: 'TEST_TOKEN', allowedChats: [], pollTimeoutSec: 30 },
      },
    });

    const executeTaskCalls: TaskInput[] = [];
    const executeTask = async (input: TaskInput): Promise<TaskResult> => {
      executeTaskCalls.push(input);
      return {
        id: input.id,
        status: 'completed',
        response: 'fake reply',
        routingLevel: 0,
        artifacts: [],
        traceId: 't',
      } as unknown as TaskResult;
    };

    const result = await initializePlugins({
      db,
      profile: 'default',
      bus,
      toolRegistry: new Map<string, Tool>(),
      pluginConfig: cfg.plugins!,
      gatewayConfig: cfg.gateway,
      executeTask,
      vinyanHome: mk('home'),
      profileRoot: mk('profile'),
      discoveryCwd: mk('cwd'),
    });

    expect(result.dispatcher).toBeDefined();
    const active = result.registry.activeIn('messaging-adapter');
    expect(active).toHaveLength(1);
    expect(active[0]!.manifest.pluginId).toBe('vinyan.bundled.telegram');

    // Teardown to avoid leaking the real telegram-api's pending fetch.
    result.dispatcher?.stop();
  });

  it('bus publish → dispatcher → executeTask, and reply routes via lifecycle.deliver', async () => {
    const db = freshDb();
    const bus = createBus();
    const cfg = VinyanConfigSchema.parse({
      plugins: { enabled: true, activateMemory: false, registerSkillTools: false },
      // Telegram sub-block OFF — we substitute our own fake adapter into the
      // registry so we can observe deliver() without the real Telegram API.
      gateway: { enabled: true, telegram: { enabled: false, allowedChats: [], pollTimeoutSec: 30 } },
    });

    const executeTaskCalls: TaskInput[] = [];
    const executeTask = async (input: TaskInput): Promise<TaskResult> => {
      executeTaskCalls.push(input);
      return {
        id: input.id,
        status: 'completed',
        response: 'hello back',
        routingLevel: 0,
        artifacts: [],
        traceId: 't',
      } as unknown as TaskResult;
    };

    const result = await initializePlugins({
      db,
      profile: 'default',
      bus,
      toolRegistry: new Map<string, Tool>(),
      pluginConfig: cfg.plugins!,
      gatewayConfig: cfg.gateway,
      executeTask,
      vinyanHome: mk('home'),
      profileRoot: mk('profile'),
      discoveryCwd: mk('cwd'),
    });

    expect(result.dispatcher).toBeDefined();

    // Inject a fake Telegram adapter into the registry post-init so
    // `lifecycle.deliver` has somewhere to route replies. Using ingestInternal
    // keeps the test on the same hot path production uses.
    const delivered: GatewayOutboundEnvelope[] = [];
    const fakeAdapter: GatewayAdapter = {
      platform: 'telegram',
      async start(_ctx: GatewayAdapterContext) {
        /* no-op */
      },
      async stop() {
        /* no-op */
      },
      async deliver(envelope: GatewayOutboundEnvelope): Promise<GatewayDeliveryReceipt> {
        delivered.push(envelope);
        return { ok: true, platformMessageId: 'fake-1', deliveredAt: Date.now() };
      },
      async healthcheck() {
        return { ok: true };
      },
    };
    result.registry.ingestInternal(
      {
        pluginId: 'test.telegram-fake',
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
        provides: [],
        consumes: [],
      },
      fakeAdapter,
    );
    await result.registry.activate('test.telegram-fake');
    const started = await result.lifecycle.startAll();
    expect(started.started).toContain('test.telegram-fake');

    // Publish an inbound envelope; dispatcher should schedule executeTask.
    // Carry fields that satisfy BOTH `GatewayInboundEnvelopeMinimal` (the bus
    // event type — requires top-level `text`) and the dispatcher's internal
    // `InboundEnvelope` (re-parsed via Zod on receipt — requires `chat`,
    // `sender`, `message`, `hypothesis`). Intersecting both is valid for
    // observers that read either shape.
    const envelope = {
      envelopeId: '00000000-0000-4000-8000-000000000001',
      platform: 'telegram' as const,
      profile: 'default',
      receivedAt: Date.now(),
      text: 'hello bot',
      chat: { id: '123', kind: 'dm' as const },
      sender: {
        platformUserId: 'u-1',
        displayName: 'Tester',
        gatewayUserId: null,
        trustTier: 'paired' as const,
      },
      message: {
        text: 'hello bot',
        attachments: [],
      },
      hypothesis: {
        claim: 'hello bot',
        confidence: 'unknown' as const,
        evidence: [{ kind: 'user-message' as const, hash: 'abc' }],
      },
    };
    bus.emit('gateway:inbound', { envelope });

    // executeTask runs inside the dispatcher's async handler — give the
    // microtask queue a tick to settle.
    await new Promise((r) => setTimeout(r, 10));

    expect(executeTaskCalls).toHaveLength(1);
    expect(executeTaskCalls[0]!.source).toBe('gateway-telegram');
    expect(executeTaskCalls[0]!.goal).toBe('hello bot');

    // Reply should have been routed through lifecycle.deliver to the fake
    // adapter.
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.platform).toBe('telegram');
    expect(delivered[0]!.chatId).toBe('123');
    expect(delivered[0]!.text).toContain('hello back');

    // Teardown.
    result.dispatcher?.stop();
    await result.lifecycle.stopAll();
  });
});
