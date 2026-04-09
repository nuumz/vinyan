import { describe, expect, test } from 'bun:test';
import { computeCost } from '../../src/economy/cost-computer.ts';
import type { RateCard } from '../../src/economy/rate-card.ts';

const SONNET_CARD: RateCard = {
  modelPattern: '*claude-sonnet*',
  input_per_mtok: 3.0,
  output_per_mtok: 15.0,
  cache_read_per_mtok: 0.3,
  cache_create_per_mtok: 3.75,
};

describe('computeCost', () => {
  test('computes USD from token counts and rate card', () => {
    const result = computeCost({ input: 1000, output: 500, cacheRead: 200, cacheCreation: 100 }, SONNET_CARD);
    expect(result.cost_tier).toBe('billing');
    // input: 1000 * 3.0 / 1M = 0.003
    // output: 500 * 15.0 / 1M = 0.0075
    // cache_read: 200 * 0.3 / 1M = 0.00006
    // cache_create: 100 * 3.75 / 1M = 0.000375
    const expected = 0.003 + 0.0075 + 0.00006 + 0.000375;
    expect(result.computed_usd).toBeCloseTo(expected, 8);
    expect(result.breakdown.input_usd).toBeCloseTo(0.003, 8);
    expect(result.breakdown.output_usd).toBeCloseTo(0.0075, 8);
  });

  test('returns estimated tier when card is null', () => {
    const result = computeCost({ input: 1000, output: 500 }, null);
    expect(result.cost_tier).toBe('estimated');
    expect(result.computed_usd).toBe(0);
  });

  test('handles zero tokens', () => {
    const result = computeCost({ input: 0, output: 0 }, SONNET_CARD);
    expect(result.computed_usd).toBe(0);
    expect(result.cost_tier).toBe('billing');
  });

  test('handles missing cache fields', () => {
    const result = computeCost({ input: 1_000_000, output: 0 }, SONNET_CARD);
    expect(result.computed_usd).toBeCloseTo(3.0, 5);
    expect(result.breakdown.cache_read_usd).toBe(0);
    expect(result.breakdown.cache_create_usd).toBe(0);
  });

  test('1M output tokens at opus rate = $75', () => {
    const opusCard: RateCard = {
      modelPattern: '*opus*',
      input_per_mtok: 15.0,
      output_per_mtok: 75.0,
      cache_read_per_mtok: 1.5,
      cache_create_per_mtok: 18.75,
    };
    const result = computeCost({ input: 0, output: 1_000_000 }, opusCard);
    expect(result.computed_usd).toBeCloseTo(75.0, 5);
  });
});
