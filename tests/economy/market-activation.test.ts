/**
 * Market Activation Tests — auto phase transition, auction-based selection,
 * and settlement → trust feedback loop.
 *
 * Tests three integration boundaries:
 * 1. MarketScheduler.checkAutoActivation() A→B transition + bus events
 * 2. DefaultEngineSelector.select() delegates to auction when market active
 * 3. MarketScheduler.settle() emits settlement_accurate / settlement_inaccurate
 */
import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { createBus, type VinyanBus, type VinyanBusEvents } from '../../src/core/bus.ts';
import { ProviderTrustStore } from '../../src/db/provider-trust-store.ts';
import { MarketScheduler } from '../../src/economy/market/market-scheduler.ts';
import type { MarketConfig } from '../../src/economy/economy-config.ts';
import type { EngineBid } from '../../src/economy/market/schemas.ts';
import type { ActualOutcome } from '../../src/economy/market/settlement-engine.ts';
import { DefaultEngineSelector } from '../../src/orchestrator/engine-selector.ts';
import type { RoutingLevel } from '../../src/orchestrator/types.ts';

// ── Helpers ──────────────────────────────────────────────────────────

function makeMarketConfig(overrides?: Partial<MarketConfig>): MarketConfig {
  return {
    enabled: true,
    min_cost_records: 200,
    bid_ttl_ms: 30_000,
    min_bidders: 2,
    weights: { cost: 0.3, quality: 0.4, duration: 0.1, accuracy: 0.2 },
    ...overrides,
  };
}

function makeTrustStore(seedFn?: (store: ProviderTrustStore) => void): ProviderTrustStore {
  const db = new Database(':memory:');
  const store = new ProviderTrustStore(db);
  if (seedFn) seedFn(store);
  return store;
}

/** Collect all bus events by name. */
function collectEvents(bus: VinyanBus) {
  const events: Array<{ event: string; payload: unknown }> = [];
  const originalEmit = bus.emit.bind(bus);
  bus.emit = (<K extends keyof VinyanBusEvents & string>(event: K, payload: VinyanBusEvents[K]) => {
    events.push({ event, payload });
    originalEmit(event, payload);
  }) as typeof bus.emit;
  return events;
}

function makeBid(bidderId: string, overrides?: Partial<EngineBid>): EngineBid {
  const now = Date.now();
  return {
    bidId: `bid-${bidderId}-${now}`,
    auctionId: '',
    bidderId,
    bidderType: 'local',
    estimatedTokensInput: 2000,
    estimatedTokensOutput: 1000,
    estimatedDurationMs: 3000,
    declaredConfidence: 0.8,
    acceptsTokenBudget: 10_000,
    acceptsTimeLimitMs: 10_000,
    submittedAt: now,
    ...overrides,
  };
}

// ── 1. Auto Phase Transition (A → B) ────────────────────────────────

describe('MarketScheduler.checkAutoActivation — A→B transition', () => {
  test('transitions A→B when cost records and engine count meet thresholds', () => {
    const bus = createBus();
    const events = collectEvents(bus);
    const scheduler = new MarketScheduler(makeMarketConfig({ min_cost_records: 100, min_bidders: 2 }), bus);

    expect(scheduler.getPhase().currentPhase).toBe('A');
    expect(scheduler.isActive()).toBe(false);

    const activated = scheduler.checkAutoActivation(100, 2);

    expect(activated).toBe(true);
    expect(scheduler.getPhase().currentPhase).toBe('B');
    expect(scheduler.isActive()).toBe(true);
  });

  test('emits market:auto_activated and market:phase_transition events', () => {
    const bus = createBus();
    const events = collectEvents(bus);
    const scheduler = new MarketScheduler(makeMarketConfig({ min_cost_records: 50, min_bidders: 2 }), bus);

    scheduler.checkAutoActivation(60, 3);

    const autoActivated = events.filter((e) => e.event === 'market:auto_activated');
    expect(autoActivated).toHaveLength(1);
    expect((autoActivated[0]!.payload as any).fromPhase).toBe('A');
    expect((autoActivated[0]!.payload as any).toPhase).toBe('B');
    expect((autoActivated[0]!.payload as any).costRecordCount).toBe(60);
    expect((autoActivated[0]!.payload as any).engineCount).toBe(3);

    const phaseTransition = events.filter((e) => e.event === 'market:phase_transition');
    expect(phaseTransition).toHaveLength(1);
    expect((phaseTransition[0]!.payload as any).from).toBe('A');
    expect((phaseTransition[0]!.payload as any).to).toBe('B');
  });

  test('does not transition when cost records below threshold', () => {
    const bus = createBus();
    const events = collectEvents(bus);
    const scheduler = new MarketScheduler(makeMarketConfig({ min_cost_records: 200, min_bidders: 2 }), bus);

    const activated = scheduler.checkAutoActivation(199, 3);

    expect(activated).toBe(false);
    expect(scheduler.getPhase().currentPhase).toBe('A');
    expect(events.filter((e) => e.event === 'market:auto_activated')).toHaveLength(0);
  });

  test('does not transition when engine count below min_bidders', () => {
    const scheduler = new MarketScheduler(makeMarketConfig({ min_cost_records: 50, min_bidders: 3 }));

    const activated = scheduler.checkAutoActivation(100, 2);

    expect(activated).toBe(false);
    expect(scheduler.getPhase().currentPhase).toBe('A');
  });

  test('no-ops when already past phase A', () => {
    const bus = createBus();
    const scheduler = new MarketScheduler(makeMarketConfig({ min_cost_records: 10, min_bidders: 2 }), bus);

    // First activation succeeds
    expect(scheduler.checkAutoActivation(20, 3)).toBe(true);
    expect(scheduler.getPhase().currentPhase).toBe('B');

    // Second call is a no-op
    const events = collectEvents(bus);
    expect(scheduler.checkAutoActivation(50, 5)).toBe(false);
    expect(events.filter((e) => e.event === 'market:auto_activated')).toHaveLength(0);
  });

  test('sets activatedAt timestamp on transition', () => {
    const scheduler = new MarketScheduler(makeMarketConfig({ min_cost_records: 10, min_bidders: 2 }));
    const before = Date.now();

    scheduler.checkAutoActivation(20, 3);

    const phase = scheduler.getPhase();
    expect(phase.activatedAt).toBeGreaterThanOrEqual(before);
    expect(phase.activatedAt).toBeLessThanOrEqual(Date.now());
  });
});

// ── 2. Bid Solicitation in EngineSelector ────────────────────────────

describe('DefaultEngineSelector.select — auction path when market active', () => {
  test('auto-activates market and uses auction when conditions met', () => {
    const bus = createBus();
    const events = collectEvents(bus);
    const trustStore = makeTrustStore((store) => {
      // Seed enough records to trigger auto-activation (200+ total)
      for (let i = 0; i < 110; i++) store.recordOutcome('engine-alpha', true);
      for (let i = 0; i < 10; i++) store.recordOutcome('engine-alpha', false);
      for (let i = 0; i < 90; i++) store.recordOutcome('engine-beta', true);
      for (let i = 0; i < 10; i++) store.recordOutcome('engine-beta', false);
    });
    const scheduler = new MarketScheduler(
      makeMarketConfig({ min_cost_records: 200, min_bidders: 2 }),
      bus,
    );
    const selector = new DefaultEngineSelector({
      trustStore,
      bus,
      marketScheduler: scheduler,
    });

    // Total records = 120 + 100 = 220 >= 200, engines = 2 >= 2 → auto-activate → auction
    const result = selector.select(1 as RoutingLevel, 'code-gen');

    // Market should have auto-activated
    expect(scheduler.isActive()).toBe(true);
    expect(events.some((e) => e.event === 'market:auto_activated')).toBe(true);

    // Selection should come from auction (if auction succeeds) or fallback to Wilson LB
    expect(result.provider).toBeDefined();
    expect(result.trustScore).toBeGreaterThan(0);
  });

  test('falls back to Wilson LB when market is not active', () => {
    const trustStore = makeTrustStore((store) => {
      // Not enough records to trigger auto-activation
      for (let i = 0; i < 5; i++) store.recordOutcome('engine-alpha', true);
      for (let i = 0; i < 3; i++) store.recordOutcome('engine-beta', true);
    });
    const scheduler = new MarketScheduler(
      makeMarketConfig({ min_cost_records: 200, min_bidders: 2 }),
    );
    const selector = new DefaultEngineSelector({
      trustStore,
      marketScheduler: scheduler,
    });

    const result = selector.select(1 as RoutingLevel, 'test-task');

    // Market should NOT be active (only 8 total records < 200)
    expect(scheduler.isActive()).toBe(false);
    // Should fall back to Wilson LB selection
    expect(result.selectionReason).toContain('wilson-lb');
  });

  test('auction result includes provider and trust score', () => {
    const bus = createBus();
    const trustStore = makeTrustStore((store) => {
      for (let i = 0; i < 150; i++) store.recordOutcome('fast-engine', true);
      for (let i = 0; i < 10; i++) store.recordOutcome('fast-engine', false);
      for (let i = 0; i < 60; i++) store.recordOutcome('slow-engine', true);
      for (let i = 0; i < 10; i++) store.recordOutcome('slow-engine', false);
    });
    // Pre-activate the market by using a low threshold
    const scheduler = new MarketScheduler(
      makeMarketConfig({ min_cost_records: 50, min_bidders: 2 }),
      bus,
    );
    const selector = new DefaultEngineSelector({
      trustStore,
      bus,
      marketScheduler: scheduler,
    });

    const result = selector.select(1 as RoutingLevel, 'code-gen');

    // Verify market activated
    expect(scheduler.isActive()).toBe(true);

    // The result should have a valid provider from our seeded set
    expect(['fast-engine', 'slow-engine', 'claude-haiku']).toContain(result.provider);
    expect(result.trustScore).toBeGreaterThan(0);
  });

  test('emits engine:selected event on auction-based selection', () => {
    const bus = createBus();
    const events = collectEvents(bus);
    const trustStore = makeTrustStore((store) => {
      for (let i = 0; i < 120; i++) store.recordOutcome('eng-a', true);
      for (let i = 0; i < 5; i++) store.recordOutcome('eng-a', false);
      for (let i = 0; i < 100; i++) store.recordOutcome('eng-b', true);
      for (let i = 0; i < 5; i++) store.recordOutcome('eng-b', false);
    });
    const scheduler = new MarketScheduler(
      makeMarketConfig({ min_cost_records: 50, min_bidders: 2 }),
      bus,
    );
    const selector = new DefaultEngineSelector({
      trustStore,
      bus,
      marketScheduler: scheduler,
    });

    selector.select(1 as RoutingLevel, 'test-task');

    const selectedEvents = events.filter((e) => e.event === 'engine:selected');
    expect(selectedEvents.length).toBeGreaterThanOrEqual(1);
    const payload = selectedEvents[0]!.payload as any;
    expect(payload.provider).toBeDefined();
    expect(payload.trustScore).toBeGreaterThan(0);
  });

  test('selector works with costPredictor injected', () => {
    const bus = createBus();
    const trustStore = makeTrustStore((store) => {
      for (let i = 0; i < 120; i++) store.recordOutcome('eng-a', true);
      for (let i = 0; i < 100; i++) store.recordOutcome('eng-b', true);
    });
    const scheduler = new MarketScheduler(
      makeMarketConfig({ min_cost_records: 50, min_bidders: 2 }),
      bus,
    );
    // Minimal CostPredictor mock — predict returns cold-start data
    const costPredictor = {
      predict: (_taskType: string, _routingLevel: number) => ({
        taskTypeSignature: _taskType,
        predicted_usd: 0.05,
        confidence: 0.5,
        p95_usd: 0.1,
        basis: 'cold-start' as const,
        observation_count: 0,
      }),
      calibrate: () => {},
    };
    const selector = new DefaultEngineSelector({
      trustStore,
      bus,
      marketScheduler: scheduler,
      costPredictor: costPredictor as any,
    });

    const result = selector.select(1 as RoutingLevel, 'code-gen');

    expect(result.provider).toBeDefined();
    expect(scheduler.isActive()).toBe(true);
  });
});

// ── 3. Settlement → Trust Loop ───────────────────────────────────────

describe('MarketScheduler.settle — settlement accuracy bus events', () => {
  test('emits market:settlement_accurate for accurate bid', () => {
    const bus = createBus();
    const events = collectEvents(bus);
    const scheduler = new MarketScheduler(makeMarketConfig(), bus);

    // Bid closely matching actual outcome → accurate
    const bid = makeBid('engine-x', {
      estimatedTokensInput: 2000,
      estimatedTokensOutput: 1000,
      estimatedDurationMs: 3000,
      estimatedUsd: 0.05,
    });
    const actual: ActualOutcome = {
      tokensConsumed: 3000, // matches bid total (2000+1000)
      durationMs: 3000,
      computedUsd: 0.05,
      success: true,
    };

    scheduler.settle(bid, actual);

    const accurate = events.filter((e) => e.event === 'market:settlement_accurate');
    expect(accurate).toHaveLength(1);
    expect((accurate[0]!.payload as any).provider).toBe('engine-x');

    const inaccurate = events.filter((e) => e.event === 'market:settlement_inaccurate');
    expect(inaccurate).toHaveLength(0);
  });

  test('emits market:settlement_inaccurate for wildly off bid', () => {
    const bus = createBus();
    const events = collectEvents(bus);
    const scheduler = new MarketScheduler(makeMarketConfig(), bus);

    // Bid way off from actual → inaccurate
    const bid = makeBid('engine-y', {
      estimatedTokensInput: 500,
      estimatedTokensOutput: 500,
      estimatedDurationMs: 1000,
      estimatedUsd: 0.01,
    });
    const actual: ActualOutcome = {
      tokensConsumed: 50_000, // 50x the bid
      durationMs: 30_000, // 30x the bid
      computedUsd: 1.5,
      success: true,
    };

    scheduler.settle(bid, actual);

    const inaccurate = events.filter((e) => e.event === 'market:settlement_inaccurate');
    expect(inaccurate).toHaveLength(1);
    expect((inaccurate[0]!.payload as any).provider).toBe('engine-y');

    const accurate = events.filter((e) => e.event === 'market:settlement_accurate');
    expect(accurate).toHaveLength(0);
  });

  test('always emits market:settlement_recorded alongside accuracy event', () => {
    const bus = createBus();
    const events = collectEvents(bus);
    const scheduler = new MarketScheduler(makeMarketConfig(), bus);

    const bid = makeBid('engine-z', {
      estimatedTokensInput: 2000,
      estimatedTokensOutput: 1000,
      estimatedDurationMs: 3000,
    });
    const actual: ActualOutcome = {
      tokensConsumed: 3000,
      durationMs: 3000,
      computedUsd: 0.05,
      success: true,
    };

    scheduler.settle(bid, actual);

    const recorded = events.filter((e) => e.event === 'market:settlement_recorded');
    expect(recorded).toHaveLength(1);
    expect((recorded[0]!.payload as any).settlementId).toBeDefined();
    expect(typeof (recorded[0]!.payload as any).bidAccuracy).toBe('number');
  });

  test('settlement feeds back provider and taskId for trust store integration', () => {
    const bus = createBus();
    const received: Array<{ provider: string; taskId: string }> = [];

    // Listen for trust feedback events
    bus.on('market:settlement_accurate', (payload) => {
      received.push({ provider: payload.provider, taskId: payload.taskId });
    });
    bus.on('market:settlement_inaccurate', (payload) => {
      received.push({ provider: payload.provider, taskId: payload.taskId });
    });

    const scheduler = new MarketScheduler(makeMarketConfig(), bus);

    const bid = makeBid('engine-trust', {
      estimatedTokensInput: 2000,
      estimatedTokensOutput: 1000,
      estimatedDurationMs: 3000,
    });
    const actual: ActualOutcome = {
      tokensConsumed: 3000,
      durationMs: 3000,
      computedUsd: 0.05,
      success: true,
    };

    scheduler.settle(bid, actual);

    expect(received).toHaveLength(1);
    expect(received[0]!.provider).toBe('engine-trust');
    expect(received[0]!.taskId).toBeDefined();
  });

  test('multiple settlements track accuracy per bidder', () => {
    const bus = createBus();
    const events = collectEvents(bus);
    const scheduler = new MarketScheduler(makeMarketConfig(), bus);

    // Accurate bid
    scheduler.settle(
      makeBid('bidder-A', { estimatedTokensInput: 2000, estimatedTokensOutput: 1000, estimatedDurationMs: 3000 }),
      { tokensConsumed: 3000, durationMs: 3000, computedUsd: 0.05, success: true },
    );

    // Inaccurate bid from different bidder
    scheduler.settle(
      makeBid('bidder-B', { estimatedTokensInput: 500, estimatedTokensOutput: 500, estimatedDurationMs: 1000 }),
      { tokensConsumed: 50_000, durationMs: 30_000, computedUsd: 1.5, success: true },
    );

    const accurateEvents = events.filter((e) => e.event === 'market:settlement_accurate');
    const inaccurateEvents = events.filter((e) => e.event === 'market:settlement_inaccurate');

    expect(accurateEvents).toHaveLength(1);
    expect((accurateEvents[0]!.payload as any).provider).toBe('bidder-A');

    expect(inaccurateEvents).toHaveLength(1);
    expect((inaccurateEvents[0]!.payload as any).provider).toBe('bidder-B');

    // Accuracy tracker should have records for both
    const trackerA = scheduler.getAccuracyTracker().getAccuracy('bidder-A');
    const trackerB = scheduler.getAccuracyTracker().getAccuracy('bidder-B');
    expect(trackerA).not.toBeNull();
    expect(trackerB).not.toBeNull();
  });
});
