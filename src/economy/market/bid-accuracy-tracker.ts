/**
 * Bid Accuracy Tracker — EMA-based per-engine bid accuracy.
 *
 * Uses EMA (not Wilson LB) because bid accuracy is a continuous value [0,1].
 * Tracks violations for anti-gaming penalty decisions.
 *
 * Source of truth: Economy OS plan §E3
 */
import type { BidAccuracyRecord, Settlement } from './schemas.ts';

/** EMA window size for accuracy tracking. */
const EMA_WINDOW = 20;
const EMA_ALPHA = 2 / (EMA_WINDOW + 1);

/** Sliding window size for violation detection. */
const VIOLATION_WINDOW = 10;

/** Penalty duration in auctions. */
const PENALTY_DURATION = 20;

/** Underbid threshold: actual/estimated > 1.5. */
const UNDERBID_THRESHOLD = 3;

export class BidAccuracyTracker {
  private records = new Map<string, BidAccuracyRecord>();
  /** Recent settlements per bidder for windowed violation detection. */
  private recentSettlements = new Map<string, Settlement[]>();

  /** Update accuracy from a settlement. */
  recordSettlement(settlement: Settlement): void {
    const bidderId = settlement.engineId;
    const record = this.records.get(bidderId) ?? {
      bidderId,
      accuracy_ema: 0.5,
      total_settled_bids: 0,
      underbid_violations: 0,
      overclaim_violations: 0,
      free_ride_violations: 0,
      penalty_active: false,
      penalty_auctions_remaining: 0,
      last_settled_at: 0,
    };

    // Update EMA
    record.accuracy_ema =
      record.total_settled_bids === 0
        ? settlement.composite_accuracy
        : EMA_ALPHA * settlement.composite_accuracy + (1 - EMA_ALPHA) * record.accuracy_ema;
    record.total_settled_bids++;
    record.last_settled_at = settlement.timestamp;

    // Track violations in window
    const recent = this.recentSettlements.get(bidderId) ?? [];
    recent.push(settlement);
    if (recent.length > VIOLATION_WINDOW) recent.shift();
    this.recentSettlements.set(bidderId, recent);

    // Check underbid violations in window
    if (settlement.penalty_type === 'underbid') {
      record.underbid_violations++;
      const windowViolations = recent.filter((s) => s.penalty_type === 'underbid').length;
      if (windowViolations >= UNDERBID_THRESHOLD && !record.penalty_active) {
        record.penalty_active = true;
        record.penalty_auctions_remaining = PENALTY_DURATION;
      }
    }

    // Decrement penalty counter
    if (record.penalty_active && record.penalty_auctions_remaining > 0) {
      record.penalty_auctions_remaining--;
      if (record.penalty_auctions_remaining <= 0) {
        record.penalty_active = false;
      }
    }

    this.records.set(bidderId, record);
  }

  /** Get accuracy record for a bidder. */
  getAccuracy(bidderId: string): BidAccuracyRecord | null {
    return this.records.get(bidderId) ?? null;
  }

  /** Get the accuracy premium for bid scoring. */
  getAccuracyPremium(bidderId: string): number {
    const record = this.records.get(bidderId);
    if (!record) return 0.5; // cold-start
    if (record.total_settled_bids < 10) return Math.max(0.5, record.accuracy_ema);
    return Math.max(0.3, record.accuracy_ema);
  }

  /** Get all tracked bidders. */
  getAllRecords(): BidAccuracyRecord[] {
    return Array.from(this.records.values());
  }
}
