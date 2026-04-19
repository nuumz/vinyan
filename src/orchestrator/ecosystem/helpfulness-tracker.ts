/**
 * HelpfulnessTracker — feeds the A4 helpfulness counter.
 *
 * Listens for `commitment:resolved` with kind=`delivered` and, if the
 * commitment was born from a volunteer offer, credits the volunteering
 * engine. Failed or transferred commitments do NOT count — a volunteer
 * earns helpfulness only by actually delivering.
 *
 * The counter is exposed read-only to the fleet lifecycle so promotion
 * gates can consult it; it is DELIBERATELY absent from the bid-scoring
 * formula (see docs/design/vinyan-os-ecosystem-plan.md §3.3 — gaming
 * resistance).
 */

import type { VinyanBus } from '../../core/bus.ts';
import type { HelpfulnessRecord, VolunteerStore } from '../../db/volunteer-store.ts';

export interface HelpfulnessTrackerConfig {
  readonly store: VolunteerStore;
  readonly bus: VinyanBus;
  readonly now?: () => number;
}

export class HelpfulnessTracker {
  private readonly store: VolunteerStore;
  private readonly bus: VinyanBus;
  private readonly now: () => number;
  private unsub: (() => void) | null = null;

  constructor(config: HelpfulnessTrackerConfig) {
    this.store = config.store;
    this.bus = config.bus;
    this.now = config.now ?? (() => Date.now());
  }

  start(): void {
    if (this.unsub) return;
    this.unsub = this.bus.on('commitment:resolved', (payload) => {
      if (payload.kind !== 'delivered') return;
      // Only count if the commitment came from a volunteer offer
      const offer = this.store.findOfferByCommitment(payload.commitmentId);
      if (!offer) return;
      this.store.recordDelivery(payload.engineId, this.now());
    });
  }

  stop(): void {
    this.unsub?.();
    this.unsub = null;
  }

  // ── Read API (for promotion gates) ───────────────────────────────

  get(engineId: string): HelpfulnessRecord | null {
    return this.store.getHelpfulness(engineId);
  }

  list(): readonly HelpfulnessRecord[] {
    return this.store.listHelpfulness();
  }
}
