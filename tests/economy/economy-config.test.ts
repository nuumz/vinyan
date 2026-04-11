import { describe, expect, test } from 'bun:test';
import { EconomyConfigSchema } from '../../src/economy/economy-config.ts';

describe('EconomyConfigSchema', () => {
  test('defaults to disabled', () => {
    const config = EconomyConfigSchema.parse({});
    expect(config.enabled).toBe(false);
    expect(config.rate_cards).toEqual({});
    expect(config.budgets.enforcement).toBe('warn');
    expect(config.market.enabled).toBe(false);
    expect(config.federation.cost_sharing_enabled).toBe(false);
  });

  test('parses full config', () => {
    const config = EconomyConfigSchema.parse({
      enabled: true,
      rate_cards: {
        'my-model': {
          input_per_mtok: 5.0,
          output_per_mtok: 20.0,
        },
      },
      budgets: {
        hourly_usd: 10.0,
        enforcement: 'block',
      },
      market: {
        enabled: true,
        min_cost_records: 500,
      },
      federation: {
        cost_sharing_enabled: true,
        shared_pool_fraction: 0.2,
      },
    });

    expect(config.enabled).toBe(true);
    expect(config.rate_cards['my-model']!.input_per_mtok).toBe(5.0);
    expect(config.rate_cards['my-model']!.cache_read_per_mtok).toBe(0); // default
    expect(config.budgets.hourly_usd).toBe(10.0);
    expect(config.budgets.enforcement).toBe('block');
    expect(config.market.enabled).toBe(true);
    expect(config.market.min_cost_records).toBe(500);
    expect(config.federation.shared_pool_fraction).toBe(0.2);
  });

  test('rejects invalid enforcement mode', () => {
    expect(() =>
      EconomyConfigSchema.parse({
        budgets: { enforcement: 'invalid' },
      }),
    ).toThrow();
  });

  test('rejects negative rate card values', () => {
    expect(() =>
      EconomyConfigSchema.parse({
        rate_cards: {
          'bad-model': {
            input_per_mtok: -1.0,
            output_per_mtok: 5.0,
          },
        },
      }),
    ).toThrow();
  });

  test('market weights have defaults', () => {
    const config = EconomyConfigSchema.parse({ market: {} });
    expect(config.market.weights.cost).toBe(0.3);
    expect(config.market.weights.quality).toBe(0.4);
    expect(config.market.weights.duration).toBe(0.1);
    expect(config.market.weights.accuracy).toBe(0.2);
  });
});
