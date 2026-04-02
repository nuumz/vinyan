import { describe, expect, it } from 'bun:test';
import type { AgentBudget } from '../../src/orchestrator/protocol.ts';
import type { RoutingDecision } from '../../src/orchestrator/types.ts';
import { AgentBudgetTracker } from '../../src/orchestrator/worker/agent-budget.ts';

function makeBudget(overrides: Partial<AgentBudget> = {}): AgentBudget {
  return {
    maxTokens: 10000,
    maxTurns: 20,
    maxDurationMs: 60_000,
    contextWindow: 128_000,
    base: 6000,
    negotiable: 2500,
    delegation: 1500,
    maxExtensionRequests: 3,
    maxToolCallsPerTurn: 10,
    delegationDepth: 0,
    maxDelegationDepth: 3,
    ...overrides,
  };
}

describe('AgentBudgetTracker', () => {
  describe('fromRouting', () => {
    it('3-pool consistency: base + negotiable + delegation <= maxTokens', () => {
      const routing: RoutingDecision = {
        level: 2,
        model: 'claude-sonnet',
        budgetTokens: 10000,
        latencyBudgetMs: 30000,
      };
      const tracker = AgentBudgetTracker.fromRouting(routing, 128_000);
      const snapshot = tracker.toSnapshot();

      expect(snapshot.base + snapshot.negotiable + snapshot.delegation).toBeLessThanOrEqual(snapshot.maxTokens);
      expect(snapshot.maxTurns).toBe(30); // level 2 → 30 turns
    });

    it('level 1 gets 15 turns, level 3 gets 50 turns', () => {
      const makeRouting = (level: 0 | 1 | 2 | 3): RoutingDecision => ({
        level,
        model: 'claude-sonnet',
        budgetTokens: 10000,
        latencyBudgetMs: 30000,
      });

      const l1 = AgentBudgetTracker.fromRouting(makeRouting(1), 128_000).toSnapshot();
      const l3 = AgentBudgetTracker.fromRouting(makeRouting(3), 128_000).toSnapshot();

      expect(l1.maxTurns).toBe(15);
      expect(l3.maxTurns).toBe(50);
    });

    it('level >= 3 gets maxDelegationDepth=2, otherwise 1', () => {
      const makeRouting = (level: 0 | 1 | 2 | 3): RoutingDecision => ({
        level,
        model: null,
        budgetTokens: 5000,
        latencyBudgetMs: 10000,
      });

      const l2 = AgentBudgetTracker.fromRouting(makeRouting(2), 128_000).toSnapshot();
      const l3 = AgentBudgetTracker.fromRouting(makeRouting(3), 128_000).toSnapshot();

      expect(l2.maxDelegationDepth).toBe(1);
      expect(l3.maxDelegationDepth).toBe(2);
    });
  });

  describe('requestExtension', () => {
    it('grants 50% cap per request', () => {
      const tracker = new AgentBudgetTracker(makeBudget({ negotiable: 1000 }));

      const ext1 = tracker.requestExtension(800);
      expect(ext1.granted).toBe(500); // 50% of 1000

      const ext2 = tracker.requestExtension(400);
      expect(ext2.granted).toBe(250); // 50% of remaining 500
    });

    it('maxExtensionRequests=3 hard stop — 4th returns granted 0', () => {
      const tracker = new AgentBudgetTracker(makeBudget({ negotiable: 10000, maxExtensionRequests: 3 }));

      const r1 = tracker.requestExtension(100);
      const r2 = tracker.requestExtension(100);
      const r3 = tracker.requestExtension(100);

      expect(r1.granted).toBeGreaterThan(0);
      expect(r2.granted).toBeGreaterThan(0);
      expect(r3.granted).toBeGreaterThan(0);

      const r4 = tracker.requestExtension(100);
      expect(r4.granted).toBe(0);
      expect(r4.remaining).toBe(0);
    });
  });

  describe('deriveChildBudget', () => {
    it('uses delegationRemaining * 0.5 cap', () => {
      const tracker = new AgentBudgetTracker(makeBudget({ delegation: 2000, delegationDepth: 0, maxDelegationDepth: 3 }));

      const child = tracker.deriveChildBudget(1500);

      // cap = floor(2000 * 0.5) = 1000, min(1500, 1000) = 1000
      expect(child.maxTokens).toBe(1000);
      expect(tracker.delegationRemaining).toBe(1000); // 2000 - 1000
    });

    it('child budget has incremented delegationDepth', () => {
      const tracker = new AgentBudgetTracker(makeBudget({ delegationDepth: 1, maxDelegationDepth: 3 }));
      const child = tracker.deriveChildBudget();

      expect(child.delegationDepth).toBe(2);
      expect(child.maxDelegationDepth).toBe(3);
    });

    it('child budget pools sum correctly', () => {
      const tracker = new AgentBudgetTracker(makeBudget({ delegation: 2000 }));
      const child = tracker.deriveChildBudget(800);

      // allocated = min(800, floor(2000*0.5)=1000) = 800
      expect(child.maxTokens).toBe(800);
      expect(child.base).toBe(Math.floor(800 * 0.6));   // 480
      expect(child.negotiable).toBe(Math.floor(800 * 0.3)); // 240
      expect(child.delegation).toBe(Math.floor(800 * 0.1)); // 80
    });

    it('without requestedTokens uses 30% of remaining', () => {
      const tracker = new AgentBudgetTracker(makeBudget({ delegation: 2000 }));
      const child = tracker.deriveChildBudget();

      // default = floor(2000 * 0.3) = 600, cap = floor(2000 * 0.5) = 1000
      // allocated = min(600, 1000) = 600
      expect(child.maxTokens).toBe(600);
    });
  });

  describe('returnUnusedDelegation', () => {
    it('correctly refunds unused tokens', () => {
      const tracker = new AgentBudgetTracker(makeBudget({ delegation: 2000 }));

      const child = tracker.deriveChildBudget(1500);
      const reserved = child.maxTokens; // 1000 (capped at 50%)
      expect(tracker.delegationRemaining).toBe(1000);

      tracker.returnUnusedDelegation(reserved, 300);
      // refund = max(0, 1000 - 300) = 700
      expect(tracker.delegationRemaining).toBe(1700);
    });

    it('does not refund more than consumed', () => {
      const tracker = new AgentBudgetTracker(makeBudget({ delegation: 2000 }));

      tracker.deriveChildBudget(500); // allocated = min(500, 1000) = 500
      expect(tracker.delegationRemaining).toBe(1500);

      // Try to refund more than was reserved
      tracker.returnUnusedDelegation(2000, 0);
      // refund = max(0, 2000-0) = 2000, but clamped: max(0, 500 - 2000) = 0
      expect(tracker.delegationRemaining).toBe(2000); // back to full
    });
  });

  describe('canContinue', () => {
    it('returns true when all limits are within bounds', () => {
      const tracker = new AgentBudgetTracker(makeBudget());
      expect(tracker.canContinue()).toBe(true);
    });

    it('returns false when turnsUsed >= maxTurns', () => {
      const tracker = new AgentBudgetTracker(makeBudget({ maxTurns: 2, base: 100000 }));
      tracker.recordTurn(10);
      tracker.recordTurn(10);
      expect(tracker.canContinue()).toBe(false);
    });

    it('returns false when baseConsumed >= base + negotiableGranted', () => {
      const tracker = new AgentBudgetTracker(makeBudget({ base: 100, negotiable: 0, maxTurns: 100 }));
      tracker.recordTurn(100);
      expect(tracker.canContinue()).toBe(false);
    });

    it('returns false when duration exceeded', () => {
      const tracker = new AgentBudgetTracker(makeBudget({ maxDurationMs: 1 }));
      // Spin briefly to exceed 1ms
      const start = performance.now();
      while (performance.now() - start < 5) {
        /* spin */
      }
      expect(tracker.canContinue()).toBe(false);
    });
  });

  describe('canDelegate', () => {
    it('returns true when depth < max and delegation remaining', () => {
      const tracker = new AgentBudgetTracker(makeBudget({
        delegationDepth: 0,
        maxDelegationDepth: 1,
        delegation: 1000,
      }));
      expect(tracker.canDelegate()).toBe(true);
    });

    it('returns false when at max depth', () => {
      const tracker = new AgentBudgetTracker(makeBudget({
        delegationDepth: 1,
        maxDelegationDepth: 1,
        delegation: 1000,
      }));
      expect(tracker.canDelegate()).toBe(false);
    });

    it('returns false when no delegation tokens remain', () => {
      const tracker = new AgentBudgetTracker(makeBudget({
        delegationDepth: 0,
        maxDelegationDepth: 3,
        delegation: 0,
      }));
      expect(tracker.canDelegate()).toBe(false);
    });
  });

  describe('recordTurn', () => {
    it('increments turns and accumulates tokens', () => {
      const tracker = new AgentBudgetTracker(makeBudget({ base: 5000, maxTurns: 10 }));
      tracker.recordTurn(100);
      tracker.recordTurn(200);

      const snapshot = tracker.toSnapshot();
      // base remaining = 5000 - 300 = 4700
      expect(snapshot.base).toBe(4700);
    });
  });

  describe('remainingMs', () => {
    it('returns positive value immediately after construction', () => {
      const tracker = new AgentBudgetTracker(makeBudget({ maxDurationMs: 60_000 }));
      expect(tracker.remainingMs()).toBeGreaterThan(0);
      expect(tracker.remainingMs()).toBeLessThanOrEqual(60_000);
    });

    it('returns 0 after duration exceeded', () => {
      const tracker = new AgentBudgetTracker(makeBudget({ maxDurationMs: 1 }));
      const start = performance.now();
      while (performance.now() - start < 5) {
        /* spin */
      }
      expect(tracker.remainingMs()).toBe(0);
    });
  });

  describe('toSnapshot', () => {
    it('reflects consumed amounts in remaining pools', () => {
      const tracker = new AgentBudgetTracker(makeBudget({
        base: 6000,
        negotiable: 2500,
        delegation: 1500,
        maxExtensionRequests: 3,
      }));

      tracker.recordTurn(1000);
      tracker.requestExtension(500); // granted min(500, 2500*0.5=1250) = 500
      tracker.deriveChildBudget(500); // allocated min(500, floor(1500*0.5)=750) = 500

      const snap = tracker.toSnapshot();
      expect(snap.base).toBe(5000); // 6000 - 1000
      expect(snap.negotiable).toBe(2000); // 2500 - 500
      expect(snap.delegation).toBe(1000); // 1500 - 500
      expect(snap.maxExtensionRequests).toBe(2); // 3 - 1
    });
  });
});
