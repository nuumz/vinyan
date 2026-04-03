import { describe, test, expect, beforeEach } from 'bun:test';
import { FileStatsCache } from '../../src/orchestrator/file-stats-cache';
import type { FileOutcomeStat } from '../../src/orchestrator/forward-predictor-types';

function makeStat(
  filePath: string,
  successCount: number,
  failCount: number,
  partialCount: number,
  quality: number,
): FileOutcomeStat {
  return {
    filePath,
    successCount,
    failCount,
    partialCount,
    samples: successCount + failCount + partialCount,
    avgQuality: quality,
  };
}

describe('FileStatsCache', () => {
  let cache: FileStatsCache;

  beforeEach(() => {
    cache = new FileStatsCache();
  });

  describe('loadAll', () => {
    test('populates cache', () => {
      const stats = [makeStat('a.ts', 3, 1, 0, 0.8), makeStat('b.ts', 2, 0, 1, 0.9)];
      cache.loadAll(stats);
      expect(cache.size).toBe(2);
      expect(cache.getStats('a.ts')).toEqual(stats[0]);
      expect(cache.getStats('b.ts')).toEqual(stats[1]);
    });

    test('clears existing data', () => {
      cache.loadAll([makeStat('old.ts', 1, 0, 0, 1.0)]);
      cache.loadAll([makeStat('new.ts', 2, 1, 0, 0.7)]);
      expect(cache.size).toBe(1);
      expect(cache.getStats('old.ts')).toBeUndefined();
      expect(cache.getStats('new.ts')).toBeDefined();
    });
  });

  describe('getFileOutcomeStats', () => {
    test('returns stats for known files', () => {
      cache.loadAll([makeStat('a.ts', 3, 1, 0, 0.8), makeStat('b.ts', 2, 0, 1, 0.9)]);
      const result = cache.getFileOutcomeStats(['a.ts', 'b.ts']);
      expect(result).toHaveLength(2);
    });

    test('returns empty for unknown files', () => {
      cache.loadAll([makeStat('a.ts', 1, 0, 0, 1.0)]);
      const result = cache.getFileOutcomeStats(['unknown.ts']);
      expect(result).toHaveLength(0);
    });

    test('filters to requested files only', () => {
      cache.loadAll([makeStat('a.ts', 1, 0, 0, 0.8), makeStat('b.ts', 2, 0, 0, 0.9), makeStat('c.ts', 3, 0, 0, 1.0)]);
      const result = cache.getFileOutcomeStats(['a.ts', 'c.ts']);
      expect(result).toHaveLength(2);
      expect(result.map(s => s.filePath)).toEqual(['a.ts', 'c.ts']);
    });
  });

  describe('recordOutcome', () => {
    test('increments success count for pass', () => {
      cache.loadAll([makeStat('a.ts', 1, 0, 0, 0.8)]);
      cache.recordOutcome(['a.ts'], 'pass', 0.9);
      const stat = cache.getStats('a.ts')!;
      expect(stat.successCount).toBe(2);
      expect(stat.samples).toBe(2);
    });

    test('increments fail count for fail', () => {
      cache.loadAll([makeStat('a.ts', 1, 0, 0, 0.8)]);
      cache.recordOutcome(['a.ts'], 'fail', 0.3);
      const stat = cache.getStats('a.ts')!;
      expect(stat.failCount).toBe(1);
      expect(stat.samples).toBe(2);
    });

    test('increments partial count for partial', () => {
      cache.loadAll([makeStat('a.ts', 1, 0, 0, 0.8)]);
      cache.recordOutcome(['a.ts'], 'partial', 0.5);
      const stat = cache.getStats('a.ts')!;
      expect(stat.partialCount).toBe(1);
      expect(stat.samples).toBe(2);
    });

    test('creates new entry for unseen file', () => {
      cache.recordOutcome(['new.ts'], 'pass', 0.95);
      const stat = cache.getStats('new.ts')!;
      expect(stat.filePath).toBe('new.ts');
      expect(stat.successCount).toBe(1);
      expect(stat.failCount).toBe(0);
      expect(stat.partialCount).toBe(0);
      expect(stat.samples).toBe(1);
      expect(stat.avgQuality).toBe(0.95);
    });

    test('updates running average quality correctly', () => {
      cache.recordOutcome(['a.ts'], 'pass', 0.8);
      cache.recordOutcome(['a.ts'], 'pass', 0.6);
      const stat = cache.getStats('a.ts')!;
      expect(stat.avgQuality).toBeCloseTo(0.7, 10);
      expect(stat.samples).toBe(2);

      cache.recordOutcome(['a.ts'], 'pass', 1.0);
      expect(cache.getStats('a.ts')!.avgQuality).toBeCloseTo(0.8, 10);
    });

    test('updates multiple files at once', () => {
      cache.recordOutcome(['a.ts', 'b.ts', 'c.ts'], 'pass', 0.9);
      expect(cache.size).toBe(3);
      expect(cache.getStats('a.ts')!.successCount).toBe(1);
      expect(cache.getStats('b.ts')!.successCount).toBe(1);
      expect(cache.getStats('c.ts')!.successCount).toBe(1);
    });
  });

  test('size tracks file count', () => {
    expect(cache.size).toBe(0);
    cache.recordOutcome(['a.ts'], 'pass', 1.0);
    expect(cache.size).toBe(1);
    cache.recordOutcome(['b.ts'], 'fail', 0.2);
    expect(cache.size).toBe(2);
    cache.recordOutcome(['a.ts'], 'pass', 0.9);
    expect(cache.size).toBe(2); // same file, no new entry
  });

  test('clear resets everything', () => {
    cache.loadAll([makeStat('a.ts', 3, 1, 0, 0.8)]);
    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.getStats('a.ts')).toBeUndefined();
  });
});
