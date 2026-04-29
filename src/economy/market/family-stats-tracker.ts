/**
 * FamilyStatsTracker — Phase-8 producer for per-task-family auction stats.
 *
 * The market-phase stratification rule (Phase 3, risk H6) requires
 * `auctionsByFamily` and `dominantWinRateByFamily` to make sane regression
 * decisions in a persona-aware roster — Developer winning 95% of code
 * tasks while Author wins 95% of writing tasks should NOT trigger
 * "market degeneracy" regression.
 *
 * Pre-Phase-8 the producer side was missing: `evaluatePhase` was called
 * with hardcoded `dominantWinRate: 0` and no per-family fields, so the
 * regression rule was effectively dead. This tracker fills that gap.
 *
 * Design:
 *   - Ring buffer of `(winnerId, family)` tuples (sliding window, default 50)
 *   - `addAuction(winnerId, family)` records one entry
 *   - `getStats()` computes:
 *       - `auctionCount`               — total entries in window
 *       - `dominantWinRate`            — global max-frequency winner / total
 *       - `dominantWinRateByFamily`    — per-family max-frequency winner / family-total
 *       - `auctionsByFamily`           — count per family
 *
 * Pure data — no IO, no LLM, no clock. A3 compliant.
 */

export interface FamilyStats {
  auctionCount: number;
  dominantWinRate: number;
  dominantWinRateByFamily: Record<string, number>;
  auctionsByFamily: Record<string, number>;
}

interface AuctionEntry {
  winnerId: string;
  family: string;
}

/**
 * Default window size. Mirrors the regression rule's threshold check
 * (`stats.auctionCount >= 50`) so a freshly-filled window is the trigger
 * point for re-evaluation rather than a much-later post-fact view.
 */
export const DEFAULT_WINDOW_SIZE = 50;

/** Family used when the caller cannot derive a task-type from the auction. */
export const UNKNOWN_FAMILY = '__unknown__';

export class FamilyStatsTracker {
  private readonly windowSize: number;
  private readonly window: AuctionEntry[] = [];

  constructor(windowSize = DEFAULT_WINDOW_SIZE) {
    if (!Number.isFinite(windowSize) || windowSize <= 0) {
      throw new Error(`FamilyStatsTracker windowSize must be a positive integer, got ${windowSize}`);
    }
    this.windowSize = Math.floor(windowSize);
  }

  /**
   * Record one auction outcome. `family` defaults to `UNKNOWN_FAMILY` when
   * the caller cannot supply a task type — keeps the window non-empty so
   * `dominantWinRate` reflects all auctions even when family stratification
   * isn't available.
   */
  addAuction(winnerId: string, family: string = UNKNOWN_FAMILY): void {
    this.window.push({ winnerId, family });
    if (this.window.length > this.windowSize) this.window.shift();
  }

  /**
   * Snapshot the tracker's window into a `FamilyStats` shape directly
   * consumable by `evaluateMarketPhase`. Returns zero stats when the window
   * is empty (the regression rule's `auctionCount >= 50` gate already
   * blocks meaningless evaluation in that case).
   */
  getStats(): FamilyStats {
    const auctionCount = this.window.length;
    if (auctionCount === 0) {
      return {
        auctionCount: 0,
        dominantWinRate: 0,
        dominantWinRateByFamily: {},
        auctionsByFamily: {},
      };
    }

    // Global winner frequency.
    const winnerCount = new Map<string, number>();
    const familyEntries = new Map<string, AuctionEntry[]>();
    for (const entry of this.window) {
      winnerCount.set(entry.winnerId, (winnerCount.get(entry.winnerId) ?? 0) + 1);
      const list = familyEntries.get(entry.family) ?? [];
      list.push(entry);
      familyEntries.set(entry.family, list);
    }

    const maxGlobal = Math.max(...winnerCount.values());
    const dominantWinRate = maxGlobal / auctionCount;

    // Per-family.
    const auctionsByFamily: Record<string, number> = {};
    const dominantWinRateByFamily: Record<string, number> = {};
    for (const [family, entries] of familyEntries) {
      auctionsByFamily[family] = entries.length;
      const perFamilyWinner = new Map<string, number>();
      for (const e of entries) perFamilyWinner.set(e.winnerId, (perFamilyWinner.get(e.winnerId) ?? 0) + 1);
      dominantWinRateByFamily[family] = Math.max(...perFamilyWinner.values()) / entries.length;
    }

    return {
      auctionCount,
      dominantWinRate,
      dominantWinRateByFamily,
      auctionsByFamily,
    };
  }

  /** Drop all recorded entries. Tests / cold-start callers use this. */
  reset(): void {
    this.window.length = 0;
  }
}
