/**
 * Federation Budget Pool → A2A Delegation Wiring Tests
 *
 * Verifies that InstanceCoordinator checks FederationBudgetPool before delegation
 * and returns the correct result when the pool is exhausted vs. has funds.
 */
import { describe, expect, test } from 'bun:test';
import { FederationBudgetPool } from '../../src/economy/federation-budget-pool.ts';
import { InstanceCoordinator, type DelegationResult } from '../../src/orchestrator/instance-coordinator.ts';
import type { TaskInput } from '../../src/orchestrator/types.ts';

function makeTaskInput(overrides?: Partial<TaskInput>): TaskInput {
  return {
    id: 'task-1',
    source: 'cli',
    goal: 'refactor auth module',
    taskType: 'code',
    budget: { maxTokens: 10000, maxDurationMs: 60000, maxRetries: 3 },
    ...overrides,
  };
}

/**
 * Inject a fake peer into the coordinator so delegation path is reachable.
 * Without peers, delegate() short-circuits with "No peers available" before
 * ever checking the budget pool.
 */
function injectFakePeer(coordinator: InstanceCoordinator): void {
  // Access private peers array to simulate a discovered peer
  (coordinator as any).peers = [
    {
      url: 'http://peer-1:3928',
      instanceId: 'peer-1',
      status: 'online',
      ecpExtension: { oracle_capabilities: [] },
    },
  ];
}

describe('FederationBudgetPool → InstanceCoordinator wiring', () => {
  test('delegate() returns exhausted reason when pool has no funds', async () => {
    const pool = new FederationBudgetPool(0.1);
    // Pool has zero contributions — canAfford(any) returns false

    const coordinator = new InstanceCoordinator({
      peerUrls: [],
      instanceId: 'local-1',
      federationBudgetPool: pool,
    });
    injectFakePeer(coordinator);

    const result = await coordinator.delegate(makeTaskInput());
    expect(result.delegated).toBe(false);
    expect(result.reason).toBe('Federation budget pool exhausted');
  });

  test('delegate() consumes estimated cost when pool has funds', async () => {
    const pool = new FederationBudgetPool(1.0); // 100% contribution for simplicity
    pool.contribute(1.0); // contributes $1.0

    const coordinator = new InstanceCoordinator({
      peerUrls: [],
      instanceId: 'local-1',
      federationBudgetPool: pool,
    });
    injectFakePeer(coordinator);

    const statusBefore = pool.getStatus();
    expect(statusBefore.remaining_usd).toBeCloseTo(1.0, 5);

    // delegate() will consume 0.01 (conservative default) then attempt A2A transport
    // Transport will fail (no real peer), but pool consumption happens before transport
    const result = await coordinator.delegate(makeTaskInput());

    const statusAfter = pool.getStatus();
    // 0.01 was consumed before transport attempt
    expect(statusAfter.total_consumed_usd).toBeCloseTo(0.01, 5);
    expect(statusAfter.remaining_usd).toBeCloseTo(0.99, 5);

    // Delegation itself fails because the peer isn't real, but the budget was consumed
    expect(result.delegated).toBe(false);
    expect(result.reason).toBe('All delegation attempts failed');
  });

  test('delegate() without pool skips budget check entirely', async () => {
    const coordinator = new InstanceCoordinator({
      peerUrls: [],
      instanceId: 'local-1',
      // No federationBudgetPool — budget check is skipped
    });
    injectFakePeer(coordinator);

    const result = await coordinator.delegate(makeTaskInput());
    // Should attempt delegation (transport fails) without budget rejection
    expect(result.delegated).toBe(false);
    expect(result.reason).toBe('All delegation attempts failed');
  });

  test('pool exhaustion after partial consumption blocks next delegation', async () => {
    const pool = new FederationBudgetPool(0.1);
    pool.contribute(0.1); // contributes $0.01 (exactly the estimated cost)

    const coordinator = new InstanceCoordinator({
      peerUrls: [],
      instanceId: 'local-1',
      federationBudgetPool: pool,
    });
    injectFakePeer(coordinator);

    // First delegation: consumes $0.01 (entire pool)
    const first = await coordinator.delegate(makeTaskInput({ id: 'task-1' }));
    expect(first.reason).not.toBe('Federation budget pool exhausted');

    // Second delegation: pool is exhausted
    const second = await coordinator.delegate(makeTaskInput({ id: 'task-2' }));
    expect(second.delegated).toBe(false);
    expect(second.reason).toBe('Federation budget pool exhausted');
  });

  test('canAfford check uses the conservative 0.01 default estimate', async () => {
    const pool = new FederationBudgetPool(0.1);
    pool.contribute(0.05); // contributes $0.005 — less than $0.01 estimate

    const coordinator = new InstanceCoordinator({
      peerUrls: [],
      instanceId: 'local-1',
      federationBudgetPool: pool,
    });
    injectFakePeer(coordinator);

    const result = await coordinator.delegate(makeTaskInput());
    // $0.005 < $0.01 estimated cost → pool exhausted
    expect(result.delegated).toBe(false);
    expect(result.reason).toBe('Federation budget pool exhausted');
  });
});
