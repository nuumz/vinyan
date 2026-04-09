import type { FileOutcomeStat } from './forward-predictor-types';

/**
 * In-memory cache for per-file outcome statistics.
 * Replaces SQL queries on the hot path with O(1) Map lookups.
 */
export class FileStatsCache {
  private readonly stats = new Map<string, FileOutcomeStat>();

  /** Bulk load from initial SQL query at boot. Clears existing data. */
  loadAll(stats: readonly FileOutcomeStat[]): void {
    this.stats.clear();
    for (const s of stats) {
      this.stats.set(s.filePath, { ...s });
    }
  }

  /** Return stats for requested files. Files not in cache are omitted. */
  getFileOutcomeStats(files: readonly string[]): FileOutcomeStat[] {
    const result: FileOutcomeStat[] = [];
    for (const f of files) {
      const stat = this.stats.get(f);
      if (stat) result.push(stat);
    }
    return result;
  }

  /** Incremental update after a task outcome. */
  recordOutcome(affectedFiles: readonly string[], testResult: 'pass' | 'partial' | 'fail', quality: number): void {
    for (const filePath of affectedFiles) {
      let entry = this.stats.get(filePath);
      if (!entry) {
        entry = { filePath, successCount: 0, failCount: 0, partialCount: 0, samples: 0, avgQuality: 0 };
        this.stats.set(filePath, entry);
      }

      entry.samples++;
      if (testResult === 'pass') entry.successCount++;
      else if (testResult === 'fail') entry.failCount++;
      else entry.partialCount++;

      entry.avgQuality = ((entry.avgQuality * (entry.samples - 1)) + quality) / entry.samples;
    }
  }

  /** Single file lookup. */
  getStats(filePath: string): FileOutcomeStat | undefined {
    return this.stats.get(filePath);
  }

  /** Number of tracked files. */
  get size(): number {
    return this.stats.size;
  }

  /** Clear all stats. */
  clear(): void {
    this.stats.clear();
  }
}
