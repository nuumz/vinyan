import { migration001 } from '../../../src/db/migrations/001_initial_schema.ts';
/**
 * Regression tests for commitment-bridge bugs that slipped past the
 * original ecosystem suite.
 *
 * 1. `market:auction_completed` carries both `auctionId` (format
 *    `auc-<taskId>-<ts>`) AND `taskId` — the bridge must key commitments
 *    by `taskId`, otherwise `trace:record` (which only has `trace.taskId`)
 *    cannot resolve the commitment the bridge opened.
 *
 * 2. Multiple auctions for the same task must NOT produce duplicate
 *    commitments — a retry / escalation that re-runs the auction should
 *    leave the ledger with exactly one open commitment per task.
 *
 * 3. The reapExpired path must close orphan commitments whose deadline
 *    has passed (crash without `trace:record` arrival).
 */
import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';

import { createBus } from '../../../src/core/bus.ts';
import { buildEcosystem } from '../../../src/orchestrator/ecosystem/index.ts';
import type { ExecutionTrace } from '../../../src/orchestrator/types.ts';
import type { TaskFacts } from '../../../src/orchestrator/ecosystem/commitment-bridge.ts';

function makeDb(): Database {
  const db = new Database(':memory:');
  migration001.up(db);
  return db;
}

function makeTrace(taskId: string, outcome: 'success' | 'failure' = 'success'): ExecutionTrace {
  return {
    id: `trace-${taskId}`,
    taskId,
    timestamp: 2_000_000,
    routingLevel: 1,
    approach: 'regression',
    oracleVerdicts: { ast: outcome === 'success' },
    modelUsed: 'test',
    tokensConsumed: 0,
    durationMs: 0,
    outcome,
    affectedFiles: [],
  } as unknown as ExecutionTrace;
}

describe('CommitmentBridge regression — auctionId vs taskId', () => {
  it('keys commitment by taskId (not auctionId) when market emits production-shaped payload', () => {
    const db = makeDb();
    const bus = createBus();
    const tasks = new Map<string, TaskFacts>([
      ['t-42', { goal: 'refactor', targetFiles: [], deadlineAt: 9e12 }],
    ]);
    const { coordinator, commitments } = buildEcosystem({
      db,
      bus,
      taskResolver: (id) => tasks.get(id) ?? null,
      engineRoster: () => [],
    });
    coordinator.start();

    // Production-shaped payload: auctionId is derived from taskId+timestamp,
    // so the two are DIFFERENT strings.
    bus.emit('market:auction_completed', {
      auctionId: 'auc-t-42-1234567890',
      taskId: 't-42',
      winnerId: 'eng-x',
      score: 0.7,
      bidderCount: 2,
    });

    // Bridge must open commitment keyed by the real taskId.
    expect(commitments.openByTask('t-42')).toHaveLength(1);
    expect(commitments.openByTask('auc-t-42-1234567890')).toHaveLength(0);

    // trace:record with the real taskId must resolve the commitment.
    bus.emit('trace:record', { trace: makeTrace('t-42', 'success') });
    expect(commitments.openByTask('t-42')).toHaveLength(0);

    coordinator.stop();
  });

  it('does NOT open a second commitment when the same task re-auctions (idempotency)', () => {
    const db = makeDb();
    const bus = createBus();
    const tasks = new Map<string, TaskFacts>([
      ['t-retry', { goal: 'flaky task', targetFiles: [], deadlineAt: 9e12 }],
    ]);
    const { coordinator, commitments } = buildEcosystem({
      db,
      bus,
      taskResolver: (id) => tasks.get(id) ?? null,
      engineRoster: () => [],
    });
    coordinator.start();

    for (const i of [1, 2, 3]) {
      bus.emit('market:auction_completed', {
        auctionId: `auc-t-retry-${i}`,
        taskId: 't-retry',
        winnerId: `eng-${i}`,
        score: 0.5,
        bidderCount: 2,
      });
    }

    // Only ONE commitment despite three auction-completed events.
    expect(commitments.openByTask('t-retry')).toHaveLength(1);
    // And it's bound to the first winner (retry losers don't displace).
    expect(commitments.openByTask('t-retry')[0]!.engineId).toBe('eng-1');

    coordinator.stop();
  });
});

describe('Reconcile sweep — expired commitment reaper', () => {
  it('reconcile() closes commitments whose deadline has passed', () => {
    const db = makeDb();
    const bus = createBus();
    let clock = 1_000_000;

    const { coordinator, commitments } = buildEcosystem({
      db,
      bus,
      taskResolver: () => null,
      engineRoster: () => [],
      now: () => clock,
    });
    coordinator.start();

    commitments.open({
      engineId: 'crashed-engine',
      taskId: 't-orphan',
      goal: 'something',
      deadlineAt: clock + 1_000,
    });
    expect(commitments.openByEngine('crashed-engine')).toHaveLength(1);

    // Jump past the deadline.
    clock = clock + 5_000;
    const report = coordinator.reconcile();

    expect(report.expiredCommitmentsReaped).toBe(1);
    expect(commitments.openByEngine('crashed-engine')).toHaveLength(0);

    coordinator.stop();
  });

  it('reconcile() does NOT reap commitments still within deadline', () => {
    const db = makeDb();
    const bus = createBus();
    let clock = 1_000_000;

    const { coordinator, commitments } = buildEcosystem({
      db,
      bus,
      taskResolver: () => null,
      engineRoster: () => [],
      now: () => clock,
    });
    coordinator.start();

    commitments.open({
      engineId: 'healthy',
      taskId: 't-ongoing',
      goal: 'something',
      deadlineAt: clock + 1_000_000, // deadline well in the future
    });

    clock = clock + 10_000;
    const report = coordinator.reconcile();

    expect(report.expiredCommitmentsReaped).toBe(0);
    expect(commitments.openByEngine('healthy')).toHaveLength(1);

    coordinator.stop();
  });
});
