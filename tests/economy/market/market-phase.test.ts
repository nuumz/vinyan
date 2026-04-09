import { describe, expect, test } from 'bun:test';
import {
  createInitialPhaseState,
  evaluateMarketPhase,
  type MarketPhaseStats,
} from '../../../src/economy/market/market-phase.ts';

function makeStats(overrides?: Partial<MarketPhaseStats>): MarketPhaseStats {
  return {
    activeEngines: 3,
    minTasksPerEngine: 100,
    totalTraces: 1000,
    auctionCount: 0,
    trustedRemotePeers: 0,
    minRemotePeerTasks: 0,
    distinctEnginesWithBids: 0,
    minSettledBidsPerEngine: 0,
    dominantWinRate: 0.5,
    ...overrides,
  };
}

describe('evaluateMarketPhase', () => {
  test('starts at Phase A', () => {
    const state = createInitialPhaseState();
    expect(state.currentPhase).toBe('A');
  });

  test('A → B when sufficient engines + tasks + traces', () => {
    const state = createInitialPhaseState();
    const transition = evaluateMarketPhase(
      state,
      makeStats({
        activeEngines: 2,
        minTasksPerEngine: 50,
        totalTraces: 500,
      }),
    );
    expect(transition.newPhase).toBe('B');
  });

  test('stays A when insufficient engines', () => {
    const state = createInitialPhaseState();
    const transition = evaluateMarketPhase(
      state,
      makeStats({
        activeEngines: 1,
        minTasksPerEngine: 50,
        totalTraces: 500,
      }),
    );
    expect(transition.newPhase).toBe('A');
  });

  test('B → C when auctions + trusted remote peers', () => {
    const state = { ...createInitialPhaseState(), currentPhase: 'B' as const };
    const transition = evaluateMarketPhase(
      state,
      makeStats({
        activeEngines: 3,
        minTasksPerEngine: 100,
        totalTraces: 1000,
        auctionCount: 150,
        trustedRemotePeers: 1,
        minRemotePeerTasks: 100,
      }),
    );
    expect(transition.newPhase).toBe('C');
  });

  test('C → D when enough bid data', () => {
    const state = { ...createInitialPhaseState(), currentPhase: 'C' as const };
    const transition = evaluateMarketPhase(
      state,
      makeStats({
        activeEngines: 3,
        minTasksPerEngine: 100,
        totalTraces: 1000,
        auctionCount: 250,
        trustedRemotePeers: 1,
        minRemotePeerTasks: 100,
        distinctEnginesWithBids: 3,
        minSettledBidsPerEngine: 50,
      }),
    );
    expect(transition.newPhase).toBe('D');
  });

  test('regresses on market degeneracy (>90% dominant)', () => {
    const state = { ...createInitialPhaseState(), currentPhase: 'B' as const };
    const transition = evaluateMarketPhase(
      state,
      makeStats({
        activeEngines: 3,
        minTasksPerEngine: 100,
        totalTraces: 1000,
        auctionCount: 60,
        dominantWinRate: 0.95,
      }),
    );
    expect(transition.newPhase).toBe('A');
  });

  test('B → A when engines drop below threshold', () => {
    const state = { ...createInitialPhaseState(), currentPhase: 'B' as const };
    const transition = evaluateMarketPhase(
      state,
      makeStats({
        activeEngines: 1,
        minTasksPerEngine: 10,
      }),
    );
    expect(transition.newPhase).toBe('A');
  });

  test('no transition when conditions unchanged', () => {
    const state = { ...createInitialPhaseState(), currentPhase: 'B' as const };
    const transition = evaluateMarketPhase(
      state,
      makeStats({
        activeEngines: 3,
        minTasksPerEngine: 100,
        totalTraces: 1000,
        auctionCount: 10,
      }),
    );
    expect(transition.newPhase).toBe('B');
    expect(transition.reason).toBe('No transition');
  });
});
