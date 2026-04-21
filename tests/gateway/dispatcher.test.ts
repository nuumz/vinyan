/**
 * Tests for GatewayDispatcher — the single gateway → orchestrator path.
 */

import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { GatewayDispatcher } from '../../src/gateway/dispatcher.ts';
import { GatewayRateLimiter } from '../../src/gateway/security/rate-limiter.ts';
import {
  buildInboundEnvelope,
  type InboundEnvelope,
  type OutboundEnvelope,
} from '../../src/gateway/envelope.ts';
import { GatewayIdentityStore } from '../../src/db/gateway-identity-store.ts';
import { migration001 } from '../../src/db/migrations/001_initial_schema.ts';
import { migration006 } from '../../src/db/migrations/006_gateway_tables.ts';
import { MigrationRunner } from '../../src/db/migrations/migration-runner.ts';
import type { TaskInput, TaskResult } from '../../src/orchestrator/types.ts';

// ── Harness ───────────────────────────────────────────────────────────

interface Harness {
  dispatcher: GatewayDispatcher;
  identityStore: GatewayIdentityStore;
  rateLimiter: GatewayRateLimiter;
  executeCalls: TaskInput[];
  delivered: OutboundEnvelope[];
  executeOverride: ((input: TaskInput) => Promise<TaskResult>) | null;
  logs: Array<{ level: string; msg: string; meta?: Record<string, unknown> }>;
  db: Database;
}

function makeTaskResult(id: string, response: string): TaskResult {
  return {
    id,
    status: 'completed',
    mutations: [],
    // The dispatcher reads fields opportunistically; only `id`, `status` and
    // `response` are needed for these tests.
    response,
  } as unknown as TaskResult;
}

function makeHarness(): Harness {
  const db = new Database(':memory:');
  new MigrationRunner().migrate(db, [migration001, migration006]);
  const identityStore = new GatewayIdentityStore(db);
  const rateLimiter = new GatewayRateLimiter();
  const executeCalls: TaskInput[] = [];
  const delivered: OutboundEnvelope[] = [];
  const logs: Harness['logs'] = [];
  const harness = {
    dispatcher: null as unknown as GatewayDispatcher,
    identityStore,
    rateLimiter,
    executeCalls,
    delivered,
    executeOverride: null as ((input: TaskInput) => Promise<TaskResult>) | null,
    logs,
    db,
  };

  const dispatcher = new GatewayDispatcher({
    bus: { on: () => () => {} },
    identityStore,
    rateLimiter,
    deliverReply: async (env) => {
      delivered.push(env);
    },
    log: (level, msg, meta) => {
      logs.push({ level, msg, meta });
    },
    executeTask: async (input) => {
      executeCalls.push(input);
      if (harness.executeOverride) return harness.executeOverride(input);
      return makeTaskResult(input.id, 'ack');
    },
  });
  harness.dispatcher = dispatcher;
  return harness;
}

let h: Harness;
beforeEach(() => {
  h = makeHarness();
});
afterEach(() => {
  h.db.close();
});

async function makePairedEnvelope(text = 'do the thing'): Promise<InboundEnvelope> {
  return buildInboundEnvelope({
    platform: 'telegram',
    profile: 'default',
    chat: { id: '123', kind: 'dm' },
    sender: { platformUserId: '7', trustTier: 'paired', displayName: 'alice' },
    text,
  });
}

async function makeUnknownEnvelope(text: string): Promise<InboundEnvelope> {
  return buildInboundEnvelope({
    platform: 'telegram',
    profile: 'default',
    chat: { id: '123', kind: 'dm' },
    sender: { platformUserId: '7', trustTier: 'unknown' },
    text,
  });
}

// ── Tests ─────────────────────────────────────────────────────────────

describe('GatewayDispatcher.handle', () => {
  test('happy path — paired user invokes executeTask with gateway-telegram source', async () => {
    const env = await makePairedEnvelope('ship the feature');
    await h.dispatcher.handle(env);

    expect(h.executeCalls).toHaveLength(1);
    const input = h.executeCalls[0]!;
    expect(input.source).toBe('gateway-telegram');
    expect(input.profile).toBe('default');
    expect(input.goal).toBe('ship the feature');
    expect(input.id).toBe(env.envelopeId);
    expect(input.originEnvelope).toEqual(env);
    expect(input.sessionId).toBe('gateway-telegram-123');
  });

  test('paired user — a reply is delivered after executeTask resolves', async () => {
    const env = await makePairedEnvelope();
    h.executeOverride = async () => makeTaskResult(env.envelopeId, 'hello from vinyan');
    await h.dispatcher.handle(env);

    expect(h.delivered).toHaveLength(1);
    const out = h.delivered[0]!;
    expect(out.platform).toBe('telegram');
    expect(out.chatId).toBe('123');
    expect(out.text).toBe('hello from vinyan');
    expect(out.replyTo).toBe(env.envelopeId);
  });

  test('unknown sender sending /pair <token> consumes the token and promotes to paired', async () => {
    const { token } = h.identityStore.issuePairingToken({
      profile: 'default',
      platform: 'telegram',
      ttlMs: 60_000,
    });
    const env = await makeUnknownEnvelope(`/pair ${token}`);
    await h.dispatcher.handle(env);

    expect(h.executeCalls).toHaveLength(0);
    const identity = h.identityStore.getIdentity('telegram', '7');
    expect(identity).not.toBeNull();
    expect(identity!.trustTier).toBe('paired');
    expect(identity!.pairedAt).not.toBeNull();

    // A second consumption of the same token fails.
    const second = h.identityStore.consumePairingToken({
      token,
      consumedBy: 'whoever',
      nowMs: Date.now(),
    });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe('already-consumed');

    // A friendly confirmation is delivered.
    expect(h.delivered.some((d) => /paired/i.test(d.text))).toBe(true);
  });

  test('unknown sender without /pair receives instructions — does not dispatch', async () => {
    const env = await makeUnknownEnvelope('what can you do?');
    await h.dispatcher.handle(env);

    expect(h.executeCalls).toHaveLength(0);
    expect(h.delivered).toHaveLength(1);
    expect(h.delivered[0]!.text.toLowerCase()).toContain('pair');
  });

  test('unknown sender with bad /pair token is politely refused', async () => {
    const env = await makeUnknownEnvelope('/pair nope');
    await h.dispatcher.handle(env);

    expect(h.executeCalls).toHaveLength(0);
    expect(h.delivered).toHaveLength(1);
    expect(h.delivered[0]!.text.toLowerCase()).toContain('not recognized');
  });

  test('rate-limit denial suppresses executeTask AND the reply', async () => {
    // Clock-controlled limiter so we can exhaust the bucket deterministically.
    const clock = { now: 0 };
    const rl = new GatewayRateLimiter(
      { pairedBucket: { capacity: 1, refillPerSec: 0 } },
      () => clock.now,
    );
    h.rateLimiter.resetAll();
    (h as unknown as { rateLimiter: GatewayRateLimiter }).rateLimiter = rl;
    const dispatcher = new GatewayDispatcher({
      bus: { on: () => () => {} },
      identityStore: h.identityStore,
      rateLimiter: rl,
      deliverReply: async (env) => {
        h.delivered.push(env);
      },
      log: (level, msg, meta) => h.logs.push({ level, msg, meta }),
      executeTask: async (input) => {
        h.executeCalls.push(input);
        return makeTaskResult(input.id, 'ok');
      },
    });

    const env1 = await makePairedEnvelope('first');
    const env2 = await makePairedEnvelope('second');
    await dispatcher.handle(env1);
    await dispatcher.handle(env2);

    expect(h.executeCalls).toHaveLength(1);
    expect(h.delivered).toHaveLength(1);
    expect(h.logs.some((l) => l.msg === 'gateway.dispatcher.rate_limited')).toBe(true);
  });

  test('a structurally invalid envelope is logged and dropped without dispatch', async () => {
    const env = await makePairedEnvelope();
    const bad = { ...env, platform: 'not-a-platform' } as unknown as InboundEnvelope;
    await h.dispatcher.handle(bad);

    expect(h.executeCalls).toHaveLength(0);
    expect(h.delivered).toHaveLength(0);
    expect(h.logs.some((l) => l.msg === 'gateway.dispatcher.envelope_invalid')).toBe(true);
  });

  test('executeTask throw → apology reply delivered, dispatcher never throws', async () => {
    h.executeOverride = async () => {
      throw new Error('boom');
    };
    const env = await makePairedEnvelope('something');
    await h.dispatcher.handle(env);

    // The harness records the call before invoking the override, so 1 attempt is expected.
    expect(h.executeCalls).toHaveLength(1);
    expect(h.delivered).toHaveLength(1);
    expect(h.delivered[0]!.text.toLowerCase()).toContain('internal error');
    expect(h.logs.some((l) => l.msg === 'gateway.dispatcher.execute_failed')).toBe(true);
  });

  test('start() subscribes and stop() unsubscribes without error', () => {
    let handler: ((payload: { envelope: InboundEnvelope }) => void) | null = null;
    let unsubscribeCalled = false;
    const bus = {
      on: (_event: 'gateway:inbound', h: (payload: { envelope: InboundEnvelope }) => void) => {
        handler = h;
        return () => {
          unsubscribeCalled = true;
        };
      },
    };
    const dispatcher = new GatewayDispatcher({
      bus,
      identityStore: h.identityStore,
      rateLimiter: h.rateLimiter,
      deliverReply: async () => {},
      log: () => {},
      executeTask: async (input) => makeTaskResult(input.id, 'ok'),
    });
    dispatcher.start();
    expect(handler).not.toBeNull();
    dispatcher.start(); // idempotent
    dispatcher.stop();
    expect(unsubscribeCalled).toBe(true);
    dispatcher.stop(); // idempotent
  });
});
