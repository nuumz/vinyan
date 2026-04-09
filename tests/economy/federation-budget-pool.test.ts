import { describe, expect, test } from 'bun:test';
import { FederationBudgetPool } from '../../src/economy/federation-budget-pool.ts';

describe('FederationBudgetPool', () => {
  test('starts empty', () => {
    const pool = new FederationBudgetPool(0.1);
    const status = pool.getStatus();
    expect(status.total_contributed_usd).toBe(0);
    expect(status.remaining_usd).toBe(0);
    expect(status.exhausted).toBe(false);
  });

  test('contributes fraction of task cost', () => {
    const pool = new FederationBudgetPool(0.1);
    pool.contribute(10.0); // 10% of 10 = 1.0
    expect(pool.getStatus().total_contributed_usd).toBeCloseTo(1.0, 5);
  });

  test('consume reduces remaining', () => {
    const pool = new FederationBudgetPool(0.1);
    pool.contribute(100.0); // contributes 10.0
    expect(pool.consume(3.0)).toBe(true);
    expect(pool.getStatus().remaining_usd).toBeCloseTo(7.0, 5);
  });

  test('consume fails when pool exhausted', () => {
    const pool = new FederationBudgetPool(0.1);
    pool.contribute(10.0); // contributes 1.0
    expect(pool.consume(2.0)).toBe(false);
  });

  test('canAfford checks remaining', () => {
    const pool = new FederationBudgetPool(0.1);
    pool.contribute(50.0); // contributes 5.0
    expect(pool.canAfford(3.0)).toBe(true);
    expect(pool.canAfford(6.0)).toBe(false);
  });

  test('exhausted is true after full consumption', () => {
    const pool = new FederationBudgetPool(0.1);
    pool.contribute(10.0); // contributes 1.0
    pool.consume(1.0);
    const status = pool.getStatus();
    expect(status.exhausted).toBe(true);
  });
});
