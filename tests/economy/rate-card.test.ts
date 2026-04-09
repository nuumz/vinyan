import { describe, expect, test } from 'bun:test';
import { DEFAULT_RATE_CARDS, resolveRateCard } from '../../src/economy/rate-card.ts';

describe('resolveRateCard', () => {
  test('matches claude-opus via default glob', () => {
    const card = resolveRateCard('anthropic/claude-opus-4');
    expect(card).not.toBeNull();
    expect(card!.input_per_mtok).toBe(15.0);
    expect(card!.output_per_mtok).toBe(75.0);
  });

  test('matches claude-sonnet via default glob', () => {
    const card = resolveRateCard('anthropic/claude-sonnet-4');
    expect(card).not.toBeNull();
    expect(card!.input_per_mtok).toBe(3.0);
    expect(card!.output_per_mtok).toBe(15.0);
  });

  test('matches claude-haiku via default glob', () => {
    const card = resolveRateCard('claude-haiku-3.5');
    expect(card).not.toBeNull();
    expect(card!.input_per_mtok).toBe(0.25);
  });

  test('returns null for unknown model', () => {
    const card = resolveRateCard('totally-unknown-model');
    expect(card).toBeNull();
  });

  test('config cards take priority over defaults', () => {
    const card = resolveRateCard('anthropic/claude-opus-4', {
      'anthropic/claude-opus-4': {
        input_per_mtok: 99.0,
        output_per_mtok: 199.0,
        cache_read_per_mtok: 0,
        cache_create_per_mtok: 0,
      },
    });
    expect(card).not.toBeNull();
    expect(card!.input_per_mtok).toBe(99.0);
    expect(card!.output_per_mtok).toBe(199.0);
  });

  test('config cards use exact match (not glob)', () => {
    const card = resolveRateCard('custom-model', {
      'custom-model': {
        input_per_mtok: 5.0,
        output_per_mtok: 20.0,
        cache_read_per_mtok: 1.0,
        cache_create_per_mtok: 2.0,
      },
    });
    expect(card).not.toBeNull();
    expect(card!.modelPattern).toBe('custom-model');
    expect(card!.cache_read_per_mtok).toBe(1.0);
  });

  test('default rate cards are ordered correctly', () => {
    expect(DEFAULT_RATE_CARDS.length).toBeGreaterThanOrEqual(3);
    // Opus should be most expensive
    const opus = DEFAULT_RATE_CARDS.find((c) => c.modelPattern.includes('opus'));
    const haiku = DEFAULT_RATE_CARDS.find((c) => c.modelPattern.includes('haiku'));
    expect(opus).toBeDefined();
    expect(haiku).toBeDefined();
    expect(opus!.input_per_mtok).toBeGreaterThan(haiku!.input_per_mtok);
  });
});
