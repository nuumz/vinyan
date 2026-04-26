import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { migration001 } from '../../../src/db/migrations/001_initial_schema.ts';

import { createBus } from '../../../src/core/bus.ts';
import { ProviderTrustStore } from '../../../src/db/provider-trust-store.ts';
import { DefaultEngineSelector } from '../../../src/orchestrator/engine-selector.ts';
import { buildEcosystem } from '../../../src/orchestrator/ecosystem/index.ts';
function makeDb(): Database {
  const db = new Database(':memory:');
  // We need provider_trust_records from migration 013 + its dependencies.
  // Simplest: run all leading migrations.
  migration001.up(db);
  // 013 depends on 001 only (trust table is self-contained). Others we skip
  // because only 013's schema is needed here.
  migration001.up(db);
  return db;
}

describe('EngineSelector — runtime-state gate', () => {
  it('excludes providers in dormant/awakening runtime state', () => {
    const db = makeDb();
    const bus = createBus();
    const trustStore = new ProviderTrustStore(db);

    // Pre-register two providers in the trust store
    for (let i = 0; i < 10; i++) trustStore.recordOutcome('warm', true, 'code-generation');
    trustStore.recordOutcome('warm', false, 'code-generation');
    for (let i = 0; i < 10; i++) trustStore.recordOutcome('cold', true, 'code-generation');
    trustStore.recordOutcome('cold', false, 'code-generation');

    const { runtime } = buildEcosystem({
      db,
      bus,
      taskResolver: () => null,
      engineRoster: () => [],
    });
    runtime.register('warm');
    runtime.awaken('warm');
    runtime.markReady('warm');
    runtime.register('cold'); // stays dormant

    const selector = new DefaultEngineSelector({
      trustStore,
      bus,
      runtimeStateManager: runtime,
    });
    const result = selector.select(1, 'task', ['code-generation']);
    expect(result.provider).toBe('warm');
  });

  it('falls back to department-scoped pool when options.departmentId is set', () => {
    const db = makeDb();
    const bus = createBus();
    const trustStore = new ProviderTrustStore(db);

    for (let i = 0; i < 20; i++) {
      trustStore.recordOutcome('coder', true, 'code-generation');
      trustStore.recordOutcome('talker', true, 'code-generation');
    }

    const { runtime, departments } = buildEcosystem({
      db,
      bus,
      departments: [
        { id: 'code', anchorCapabilities: ['code-generation'], minMatchCount: 1 },
      ],
      taskResolver: () => null,
      engineRoster: () => [
        { id: 'coder', capabilities: ['code-generation', 'tool-use'] },
        { id: 'talker', capabilities: ['text-generation'] }, // not in 'code'
      ],
    });
    departments.refresh([
      { id: 'coder', capabilities: ['code-generation', 'tool-use'] },
      { id: 'talker', capabilities: ['text-generation'] },
    ]);
    runtime.register('coder');
    runtime.awaken('coder');
    runtime.markReady('coder');
    runtime.register('talker');
    runtime.awaken('talker');
    runtime.markReady('talker');

    const selector = new DefaultEngineSelector({
      trustStore,
      bus,
      runtimeStateManager: runtime,
      departmentIndex: departments,
    });

    const result = selector.select(1, 'task', ['code-generation'], undefined, { departmentId: 'code' });
    expect(result.provider).toBe('coder');
  });

  it('invokes volunteerFallback when market + wilson-LB both fail to meet threshold', () => {
    const db = makeDb();
    const bus = createBus();
    const trustStore = new ProviderTrustStore(db);

    // Provider with poor record — below wilson-LB threshold at L2
    trustStore.recordOutcome('poor', true, 'code-generation');
    for (let i = 0; i < 20; i++) trustStore.recordOutcome('poor', false, 'code-generation');

    const calls: Array<{ taskId: string }> = [];
    const selector = new DefaultEngineSelector({
      trustStore,
      bus,
      volunteerFallback: ({ taskId }) => {
        calls.push({ taskId });
        return 'rescued-engine';
      },
    });

    const result = selector.select(2, 'help-me', ['code-generation']);
    expect(calls).toHaveLength(1);
    expect(result.provider).toBe('rescued-engine');
    expect(result.selectionReason).toBe('volunteer-fallback');
  });

  it('skips volunteerFallback when wilson-LB already picked a trusted provider', () => {
    const db = makeDb();
    const bus = createBus();
    const trustStore = new ProviderTrustStore(db);

    for (let i = 0; i < 50; i++) trustStore.recordOutcome('strong', true, 'code-generation');
    trustStore.recordOutcome('strong', false, 'code-generation');
    trustStore.recordOutcome('strong', false, 'code-generation');

    const calls: number[] = [];
    const selector = new DefaultEngineSelector({
      trustStore,
      bus,
      volunteerFallback: () => {
        calls.push(1);
        return 'shouldnt-be-used';
      },
    });

    const result = selector.select(1, 'task', ['code-generation']);
    expect(calls).toHaveLength(0);
    expect(result.provider).toBe('strong');
  });
});

describe('EngineSelector — task identity contract', () => {
  it('emits engine:selected with the real taskId, not the cost key', () => {
    const db = makeDb();
    const bus = createBus();
    const trustStore = new ProviderTrustStore(db);

    for (let i = 0; i < 20; i++) trustStore.recordOutcome('strong', true, 'code-generation');

    const events: Array<{ taskId: string; provider: string }> = [];
    bus.on('engine:selected', (p) => events.push({ taskId: p.taskId, provider: p.provider }));

    const selector = new DefaultEngineSelector({ trustStore, bus });
    selector.select(1, 'task-real-42', ['code-generation'], undefined, { taskType: 'code' });

    expect(events).toHaveLength(1);
    expect(events[0]!.taskId).toBe('task-real-42');
  });

  it('forwards the real taskId into market auction allocation', () => {
    const db = makeDb();
    const bus = createBus();
    const trustStore = new ProviderTrustStore(db);

    for (let i = 0; i < 20; i++) {
      trustStore.recordOutcome('a', true, 'code-generation');
      trustStore.recordOutcome('b', true, 'code-generation');
    }

    const allocateCalls: string[] = [];
    const fakeMarket = {
      isActive: () => true,
      checkAutoActivation: () => {},
      allocate: (taskId: string) => {
        allocateCalls.push(taskId);
        // Return a winner so the selector takes the auction path
        return { winnerId: 'a', winnerScore: 0.8 };
      },
    } as unknown as import('../../../src/economy/market/market-scheduler.ts').MarketScheduler;

    const selector = new DefaultEngineSelector({
      trustStore,
      bus,
      marketScheduler: fakeMarket,
    });
    selector.select(1, 'task-real-99', ['code-generation'], undefined, { taskType: 'code' });

    expect(allocateCalls).toHaveLength(1);
    // Must be the real taskId — never the cost key, never `task-${taskType}`.
    expect(allocateCalls[0]).toBe('task-real-99');
    expect(allocateCalls[0]).not.toBe('task-code');
    expect(allocateCalls[0]).not.toBe('code');
  });

  it('passes options.taskType (cost key) to costPredictor.predict, distinct from taskId', () => {
    const db = makeDb();
    const bus = createBus();
    const trustStore = new ProviderTrustStore(db);

    for (let i = 0; i < 20; i++) {
      trustStore.recordOutcome('a', true, 'code-generation');
      trustStore.recordOutcome('b', true, 'code-generation');
    }

    const predictCalls: Array<{ sig: string; level: number }> = [];
    const fakePredictor = {
      predict: (sig: string, level: number) => {
        predictCalls.push({ sig, level });
        return { predicted_usd: 0.001, confidence: 0.5 };
      },
    } as unknown as import('../../../src/economy/cost-predictor.ts').CostPredictor;
    const fakeMarket = {
      isActive: () => true,
      checkAutoActivation: () => {},
      allocate: () => ({ winnerId: 'a', winnerScore: 0.8 }),
    } as unknown as import('../../../src/economy/market/market-scheduler.ts').MarketScheduler;

    const selector = new DefaultEngineSelector({
      trustStore,
      bus,
      marketScheduler: fakeMarket,
      costPredictor: fakePredictor,
    });
    selector.select(1, 'task-xyz', ['code-generation'], undefined, { taskType: 'code' });

    expect(predictCalls.length).toBeGreaterThan(0);
    // Cost predictor must see the cost key, NOT the taskId.
    expect(predictCalls[0]!.sig).toBe('code');
  });
});

describe('EngineSelector — capacity-aware runtime gate', () => {
  it('excludes working providers at capacity and prefers ones with headroom', () => {
    const db = makeDb();
    const bus = createBus();
    const trustStore = new ProviderTrustStore(db);

    for (let i = 0; i < 30; i++) {
      trustStore.recordOutcome('busy', true, 'code-generation');
      trustStore.recordOutcome('free', true, 'code-generation');
    }

    const { runtime } = buildEcosystem({
      db,
      bus,
      taskResolver: () => null,
      engineRoster: () => [],
    });
    runtime.register('busy', 1);
    runtime.awaken('busy');
    runtime.markReady('busy');
    runtime.markWorking('busy', 'task-fill-1'); // active=1, capacity=1 → at capacity

    runtime.register('free', 2);
    runtime.awaken('free');
    runtime.markReady('free');

    const selector = new DefaultEngineSelector({
      trustStore,
      bus,
      runtimeStateManager: runtime,
    });
    const result = selector.select(1, 'task-pick-me', ['code-generation']);
    expect(result.provider).toBe('free');
  });
});
