/**
 * Phase 0 — failing tests pinning the task-identity contract.
 *
 * The selector currently treats its second parameter as a "taskType" string
 * and stamps it into bus events (`engine:selected`) AND into the market
 * auction key (`MarketScheduler.allocate('task-' + taskType, ...)`). Callers
 * pass `input.goal.slice(0, 50)` from phase-predict, which corrupts auction
 * ids, commitment keys, and observability.
 *
 * After Phase 1 the second parameter is the real `taskId`, the bus event
 * carries that taskId, and the market auction is keyed on that taskId so the
 * `market:auction_completed` payload flows naturally into the commitment
 * bridge.
 *
 * These tests are intentionally RED until Phase 1 lands.
 */
import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';

import { createBus } from '../../src/core/bus.ts';
import { migration001 } from '../../src/db/migrations/001_initial_schema.ts';
import { ProviderTrustStore } from '../../src/db/provider-trust-store.ts';
import { MarketConfigSchema } from '../../src/economy/economy-config.ts';
import { MarketScheduler } from '../../src/economy/market/market-scheduler.ts';
import { DefaultEngineSelector } from '../../src/orchestrator/engine-selector.ts';

function makeDb(): Database {
  const db = new Database(':memory:');
  migration001.up(db);
  return db;
}

describe('EngineSelector — task identity contract', () => {
  it('emits engine:selected with the real taskId, not goal prefix or task type', () => {
    const db = makeDb();
    const bus = createBus();
    const trustStore = new ProviderTrustStore(db);
    for (let i = 0; i < 18; i++) trustStore.recordOutcome('alpha', true);
    for (let i = 0; i < 2; i++) trustStore.recordOutcome('alpha', false);

    const selector = new DefaultEngineSelector({ trustStore, bus });

    const events: Array<{ taskId: string }> = [];
    bus.on('engine:selected', (p) => events.push({ taskId: p.taskId }));

    const taskId = 'task-abc-123';
    selector.select(1, taskId);

    expect(events).toHaveLength(1);
    expect(events[0]!.taskId).toBe(taskId);
  });

  it('routes the auction with the real taskId (not "task-<taskType>" composite)', () => {
    const db = makeDb();
    const bus = createBus();
    const trustStore = new ProviderTrustStore(db);
    // Two qualified providers so an auction is feasible.
    for (let i = 0; i < 20; i++) {
      trustStore.recordOutcome('alpha', true);
      trustStore.recordOutcome('beta', true);
    }

    const auctions: Array<{ auctionId: string; taskId: string }> = [];
    bus.on('market:auction_started', (p) => auctions.push({ auctionId: p.auctionId, taskId: p.taskId }));

    const marketConfig = MarketConfigSchema.parse({ enabled: true, min_bidders: 2, min_cost_records: 0 });
    const market = new MarketScheduler(marketConfig, bus);
    // Force phase A → B so isActive() is true and the selector takes the auction path.
    market.checkAutoActivation(0, 2);
    expect(market.isActive()).toBe(true);

    const selector = new DefaultEngineSelector({
      trustStore,
      bus,
      marketScheduler: market,
    });

    const taskId = 't-real-7';
    selector.select(1, taskId);

    expect(auctions.length).toBeGreaterThan(0);
    // The auctionId format is `auc-<taskId>-<ts>` — must contain the real id,
    // NOT the legacy `auc-task-<taskType>-<ts>` composite.
    const a = auctions[0]!;
    expect(a.taskId).toBe(taskId);
    expect(a.auctionId).toContain(`-${taskId}-`);
    expect(a.auctionId).not.toContain('task-t-real-7'); // no double-prefixing
  });
});
