/**
 * Tests for `deliverCronReply` — origin → OutboundEnvelope + dispatch.
 *
 * Covers:
 *   - CLI origin is a no-op (no lifecycle call, logged).
 *   - Telegram origin builds an envelope and calls lifecycle.deliver.
 *   - Oversized answers are truncated to MAX_ENVELOPE_TEXT_LEN.
 *   - Lifecycle returning ok:false is logged, not thrown.
 *   - Lifecycle throwing is caught and logged, not propagated.
 */
import { describe, expect, test } from 'bun:test';
import { MAX_ENVELOPE_TEXT_LEN } from '../../../src/gateway/envelope.ts';
import { deliverCronReply } from '../../../src/gateway/scheduling/deliver-reply.ts';
import type { ScheduledHypothesisTuple, ScheduleOrigin } from '../../../src/gateway/scheduling/types.ts';
import type { GatewayDeliveryReceipt, GatewayOutboundEnvelope } from '../../../src/gateway/types.ts';
import type { TaskResult } from '../../../src/orchestrator/types.ts';

type Logged = { level: 'info' | 'warn' | 'error'; msg: string; meta?: Record<string, unknown> };

function makeTuple(origin: ScheduleOrigin): ScheduledHypothesisTuple {
  return {
    id: 'sched-1',
    profile: 'default',
    createdAt: 1_000,
    createdByHermesUserId: null,
    origin,
    cron: '0 9 * * *',
    timezone: 'UTC',
    nlOriginal: 'daily at 9am send stand-up summary',
    goal: 'send stand-up summary',
    constraints: {},
    confidenceAtCreation: 0.9,
    evidenceHash: 'hash-1',
    status: 'active',
    failureStreak: 0,
    nextFireAt: 5_000,
    runHistory: [],
  };
}

function makeResult(overrides: Partial<TaskResult> = {}): TaskResult {
  return {
    id: 'task-1',
    status: 'completed',
    mutations: [],
    trace: { events: [] } as unknown as TaskResult['trace'],
    answer: 'Your stand-up summary: 3 PRs merged, 1 blocker.',
    ...overrides,
  };
}

interface FakeLifecycle {
  deliver: (env: GatewayOutboundEnvelope) => Promise<GatewayDeliveryReceipt>;
  calls: GatewayOutboundEnvelope[];
}

function makeFakeLifecycle(
  impl: (env: GatewayOutboundEnvelope) => Promise<GatewayDeliveryReceipt> = async () => ({ ok: true }),
): FakeLifecycle {
  const calls: GatewayOutboundEnvelope[] = [];
  return {
    calls,
    deliver: async (env) => {
      calls.push(env);
      return impl(env);
    },
  };
}

function makeLogCapture(): {
  entries: Logged[];
  log: (level: 'info' | 'warn' | 'error', msg: string, meta?: Record<string, unknown>) => void;
} {
  const entries: Logged[] = [];
  return {
    entries,
    log: (level, msg, meta) => {
      entries.push({ level, msg, meta });
    },
  };
}

describe('deliverCronReply — CLI origin', () => {
  test('is a no-op; no lifecycle call; info log emitted', async () => {
    const schedule = makeTuple({ platform: 'cli', chatId: null });
    const lifecycle = makeFakeLifecycle();
    const { entries, log } = makeLogCapture();

    await deliverCronReply(schedule, makeResult(), {
      lifecycle: lifecycle as unknown as Parameters<typeof deliverCronReply>[2]['lifecycle'],
      log,
    });

    expect(lifecycle.calls.length).toBe(0);
    expect(entries.some((e) => e.level === 'info' && e.msg.includes('cli-origin'))).toBe(true);
  });
});

describe('deliverCronReply — messaging origin', () => {
  test('builds an envelope and calls lifecycle.deliver', async () => {
    const schedule = makeTuple({ platform: 'telegram', chatId: 'chat-42', threadKey: 'thread-7' });
    const lifecycle = makeFakeLifecycle();
    const { log } = makeLogCapture();

    await deliverCronReply(schedule, makeResult({ answer: 'hello' }), {
      lifecycle: lifecycle as unknown as Parameters<typeof deliverCronReply>[2]['lifecycle'],
      log,
      uuid: () => 'env-static-1',
    });

    expect(lifecycle.calls.length).toBe(1);
    const env = lifecycle.calls[0]!;
    expect(env.envelopeId).toBe('env-static-1');
    expect(env.platform).toBe('telegram');
    expect(env.chatId).toBe('chat-42');
    expect(env.text).toBe('hello');
    expect(env.replyTo).toBe('thread-7');
  });

  test('truncates oversized text to MAX_ENVELOPE_TEXT_LEN', async () => {
    const schedule = makeTuple({ platform: 'slack', chatId: 'C123' });
    const lifecycle = makeFakeLifecycle();
    const { log } = makeLogCapture();

    const bigAnswer = 'x'.repeat(MAX_ENVELOPE_TEXT_LEN + 2_000);
    await deliverCronReply(schedule, makeResult({ answer: bigAnswer }), {
      lifecycle: lifecycle as unknown as Parameters<typeof deliverCronReply>[2]['lifecycle'],
      log,
    });

    expect(lifecycle.calls[0]!.text.length).toBe(MAX_ENVELOPE_TEXT_LEN);
  });

  test('non-cli origin without chatId → warn log, no deliver', async () => {
    const schedule = makeTuple({ platform: 'discord', chatId: null });
    const lifecycle = makeFakeLifecycle();
    const { entries, log } = makeLogCapture();

    await deliverCronReply(schedule, makeResult(), {
      lifecycle: lifecycle as unknown as Parameters<typeof deliverCronReply>[2]['lifecycle'],
      log,
    });

    expect(lifecycle.calls.length).toBe(0);
    expect(entries.some((e) => e.level === 'warn' && e.msg.includes('without chatId'))).toBe(true);
  });

  test('lifecycle returning ok:false is logged, not thrown', async () => {
    const schedule = makeTuple({ platform: 'telegram', chatId: 'chat-42' });
    const lifecycle = makeFakeLifecycle(async () => ({ ok: false, error: 'rate-limited' }));
    const { entries, log } = makeLogCapture();

    await expect(
      deliverCronReply(schedule, makeResult(), {
        lifecycle: lifecycle as unknown as Parameters<typeof deliverCronReply>[2]['lifecycle'],
        log,
      }),
    ).resolves.toBeUndefined();

    expect(entries.some((e) => e.level === 'warn' && e.msg.includes('receipt reported failure'))).toBe(true);
  });

  test('lifecycle throwing is caught and logged, not propagated', async () => {
    const schedule = makeTuple({ platform: 'telegram', chatId: 'chat-42' });
    const throwingLifecycle = {
      deliver: async () => {
        throw new Error('lifecycle-broken');
      },
    };
    const { entries, log } = makeLogCapture();

    await expect(
      deliverCronReply(schedule, makeResult(), {
        lifecycle: throwingLifecycle as unknown as Parameters<typeof deliverCronReply>[2]['lifecycle'],
        log,
      }),
    ).resolves.toBeUndefined();

    expect(entries.some((e) => e.level === 'error' && e.msg.includes('deliver threw'))).toBe(true);
  });
});
