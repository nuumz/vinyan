import { describe, test, expect, beforeEach } from 'bun:test';
import { PercentileCache } from '../../src/orchestrator/percentile-cache.ts';

describe('PercentileCache', () => {
  let cache: PercentileCache;

  beforeEach(() => {
    cache = new PercentileCache();
  });

  test('getPercentiles returns zeros for unknown taskType', () => {
    const dist = cache.getPercentiles('unknown');
    expect(dist).toEqual({ lo: 0, mid: 0, hi: 0 });
  });

  test('loadAll computes initial percentiles', () => {
    cache.loadAll('code', [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const dist = cache.getPercentiles('code');
    expect(dist.lo).toBeGreaterThan(0);
    expect(dist.mid).toBeGreaterThan(0);
    expect(dist.hi).toBeGreaterThan(0);
  });

  test('loadAll with single value returns same for all', () => {
    cache.loadAll('single', [42]);
    const dist = cache.getPercentiles('single');
    expect(dist).toEqual({ lo: 42, mid: 42, hi: 42 });
  });

  test('loadAll with 10 values computes correct percentiles (matches PredictionLedger formula)', () => {
    // values sorted: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
    // p(pct) = values[Math.min(Math.floor(pct * 10), 9)]
    // lo  = p(0.1) = values[Math.floor(1)]   = values[1] = 2
    // mid = p(0.5) = values[Math.floor(5)]   = values[5] = 6
    // hi  = p(0.9) = values[Math.floor(9)]   = values[9] = 10
    cache.loadAll('code', [5, 3, 8, 1, 10, 2, 7, 4, 9, 6]);
    const dist = cache.getPercentiles('code');
    expect(dist).toEqual({ lo: 2, mid: 6, hi: 10 });
  });

  test('recordValue does NOT recompute before threshold', () => {
    cache.loadAll('code', [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const before = cache.getPercentiles('code');

    // Add 9 values (below threshold of 10) — should NOT trigger recompute
    for (let i = 0; i < 9; i++) {
      cache.recordValue('code', 100);
    }
    const after = cache.getPercentiles('code');
    expect(after).toEqual(before);
  });

  test('recordValue triggers recompute at threshold (every 10)', () => {
    cache.loadAll('code', [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const before = cache.getPercentiles('code');

    // Add 10 high values → triggers recompute, percentiles should shift up
    for (let i = 0; i < 10; i++) {
      cache.recordValue('code', 100);
    }
    const after = cache.getPercentiles('code');
    expect(after.mid).toBeGreaterThan(before.mid);
  });

  test('recordValue recomputes periodically (every 10th call)', () => {
    cache.loadAll('code', [10]);

    // First 9 records: no recompute
    for (let i = 0; i < 9; i++) {
      cache.recordValue('code', 50);
    }
    expect(cache.getPercentiles('code')).toEqual({ lo: 10, mid: 10, hi: 10 });

    // 10th record triggers recompute
    cache.recordValue('code', 50);
    const dist = cache.getPercentiles('code');
    expect(dist.mid).toBeGreaterThan(10);
  });

  test('percentiles reflect new values after recompute', () => {
    // Start empty via recordValue (no loadAll)
    // 10 records of value 5 → triggers recompute at 10th
    for (let i = 0; i < 10; i++) {
      cache.recordValue('fresh', 5);
    }
    expect(cache.getPercentiles('fresh')).toEqual({ lo: 5, mid: 5, hi: 5 });

    // 10 more records of value 20 → triggers recompute at 20th
    for (let i = 0; i < 10; i++) {
      cache.recordValue('fresh', 20);
    }
    const dist = cache.getPercentiles('fresh');
    expect(dist.hi).toBe(20);
    expect(dist.lo).toBe(5);
  });

  test('multiple task types tracked independently', () => {
    cache.loadAll('code', [1, 2, 3, 4, 5]);
    cache.loadAll('test', [10, 20, 30, 40, 50]);

    const code = cache.getPercentiles('code');
    const testDist = cache.getPercentiles('test');

    expect(code.mid).toBeLessThan(testDist.mid);
    expect(cache.taskTypeCount).toBe(2);
  });

  test('custom recomputeEvery works', () => {
    const fast = new PercentileCache(3);
    fast.loadAll('code', [10]);

    fast.recordValue('code', 50);
    fast.recordValue('code', 50);
    // Still at initial (2 records, threshold=3)
    expect(fast.getPercentiles('code')).toEqual({ lo: 10, mid: 10, hi: 10 });

    // 3rd record triggers recompute
    fast.recordValue('code', 50);
    expect(fast.getPercentiles('code').mid).toBeGreaterThan(10);
  });

  test('clear resets everything', () => {
    cache.loadAll('code', [1, 2, 3]);
    expect(cache.taskTypeCount).toBe(1);

    cache.clear();
    expect(cache.taskTypeCount).toBe(0);
    expect(cache.getPercentiles('code')).toEqual({ lo: 0, mid: 0, hi: 0 });
  });

  test('taskTypeCount tracks correctly', () => {
    expect(cache.taskTypeCount).toBe(0);

    cache.loadAll('a', [1]);
    expect(cache.taskTypeCount).toBe(1);

    cache.loadAll('b', [2]);
    expect(cache.taskTypeCount).toBe(2);

    // recordValue for new type doesn't add to cache until recompute
    cache.recordValue('c', 5);
    expect(cache.taskTypeCount).toBe(2);
  });
});
