/**
 * ClarificationTrendProvider interface contract test — verifies the
 * NULL_TREND_PROVIDER returns an empty map and that custom mocks honour
 * the composite-key contract.
 */
import { describe, expect, test } from 'bun:test';
import {
  type ClarificationTrendHintMap,
  type ClarificationTrendProvider,
  NULL_TREND_PROVIDER,
  trendHintKey,
} from '../../../src/orchestrator/user-context/trend-feed.ts';

describe('NULL_TREND_PROVIDER', () => {
  test('returns an empty map for every query', async () => {
    const result = await Promise.resolve(NULL_TREND_PROVIDER.fetch({ creativeDomain: 'video', goal: 'anything' }));
    expect(result.size).toBe(0);
  });

  test('id is stable / readable for traces', () => {
    expect(NULL_TREND_PROVIDER.id).toBe('null-trend-provider');
  });
});

describe('trendHintKey', () => {
  test('joins question id + option id with `::` (specialist ids may contain dots)', () => {
    expect(trendHintKey('genre', 'lifestyle')).toBe('genre::lifestyle');
    expect(trendHintKey('specialist', 'runway-gen-4.5')).toBe('specialist::runway-gen-4.5');
  });
});

describe('ClarificationTrendProvider — custom mock contract', () => {
  test('mock provider honours the composite-key contract', async () => {
    const mock: ClarificationTrendProvider = {
      id: 'mock-trend',
      fetch(query): ClarificationTrendHintMap {
        if (query.creativeDomain !== 'video') return new Map();
        return new Map([
          [trendHintKey('genre', 'lifestyle'), { text: 'Lifestyle vlogs trending', score: 0.8 }],
          [trendHintKey('platform', 'tiktok'), { text: 'TikTok algorithm rewarding saves', score: 0.7 }],
        ]);
      },
    };
    const hints = await Promise.resolve(mock.fetch({ creativeDomain: 'video', goal: 'tiktok content' }));
    expect(hints.size).toBe(2);
    expect(hints.get(trendHintKey('genre', 'lifestyle'))?.text).toBe('Lifestyle vlogs trending');
    expect(hints.get(trendHintKey('platform', 'tiktok'))?.score).toBe(0.7);
  });

  test('non-matching domain returns empty map (no fabrication)', async () => {
    const mock: ClarificationTrendProvider = {
      id: 'mock-music',
      fetch(query): ClarificationTrendHintMap {
        if (query.creativeDomain !== 'music') return new Map();
        return new Map([[trendHintKey('genre', 'lofi'), { text: 'Lo-fi peaking', score: 0.9 }]]);
      },
    };
    const out = await Promise.resolve(mock.fetch({ creativeDomain: 'video', goal: 'x' }));
    expect(out.size).toBe(0);
  });
});
