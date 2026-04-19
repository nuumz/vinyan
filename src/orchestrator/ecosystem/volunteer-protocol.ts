/**
 * Volunteer Protocol — "I can help" offers when the auction goes empty.
 *
 * Flow:
 *   1. Auction opens. Priced bids collected for `auctionWindowMs`.
 *   2. Auction closes. If no winning bid, a short volunteer window opens.
 *   3. Standby agents submit `VolunteerOffer`s.
 *   4. The coordinator picks deterministically using:
 *        score = capability × trust × (1 / (1 + currentLoad))
 *   5. The winner gets a commitment; others stay Standby.
 *   6. Only volunteers whose commitment resolves as `delivered` count
 *      toward `helpfulness` — so indiscriminate volunteering gains nothing.
 *
 * All selection is pure (A3). The only side-effect the protocol has on
 * career standing is through `helpfulness`, which affects **promotion**
 * gates — NOT bid scoring (prevents auction gaming).
 *
 * Source of truth: docs/design/vinyan-os-ecosystem-plan.md §3.3
 */

import { randomUUID } from 'crypto';

import type { VinyanBus } from '../../core/bus.ts';
import type { VolunteerOfferRecord, VolunteerStore } from '../../db/volunteer-store.ts';

// ── Types ────────────────────────────────────────────────────────────

export interface VolunteerOffer {
  readonly offerId: string;
  readonly engineId: string;
  readonly taskId: string;
  readonly offeredAt: number;
  /** Optional self-declared confidence 0-1. Advisory only. */
  readonly declaredConfidence?: number;
}

export interface VolunteerContext {
  readonly capability: number; // 0-1, from CapabilityModel
  readonly trust: number; // 0-1, Wilson LB from success history
  readonly currentLoad: number; // 0-N, active task count
}

export interface VolunteerCandidate {
  readonly offer: VolunteerOffer;
  readonly context: VolunteerContext;
}

export interface SelectionVerdict {
  readonly winner: VolunteerOffer | null;
  readonly reason: string;
  readonly scores: ReadonlyArray<{ offer: VolunteerOffer; score: number }>;
}

// ── Pure selection rule ──────────────────────────────────────────────

/**
 * Score a volunteer candidate. A3: deterministic formula, no LLM.
 *
 *   score = capability × trust × (1 / (1 + currentLoad))
 *
 * Capability and trust are both clamped ≥ 0.01 so a cold-start agent
 * can still win when no one else offers.
 */
export function scoreCandidate(c: VolunteerCandidate): number {
  const cap = Math.max(0.01, c.context.capability);
  const trust = Math.max(0.01, c.context.trust);
  const loadPenalty = 1 / (1 + Math.max(0, c.context.currentLoad));
  return cap * trust * loadPenalty;
}

/**
 * Pick the highest-scoring volunteer. Ties are broken by `offeredAt`
 * (earlier offer wins). Returns `{ winner: null }` when no candidates.
 */
export function selectVolunteer(candidates: readonly VolunteerCandidate[]): SelectionVerdict {
  const scored = candidates
    .map((c) => ({ offer: c.offer, score: scoreCandidate(c) }))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.offer.offeredAt - b.offer.offeredAt;
    });

  if (scored.length === 0) {
    return { winner: null, reason: 'no volunteers', scores: [] };
  }
  const top = scored[0]!;
  if (top.score <= 0) {
    return { winner: null, reason: 'all candidates scored zero', scores: scored };
  }
  return { winner: top.offer, reason: 'highest score', scores: scored };
}

// ── Registry (collect offers + persist) ──────────────────────────────

export interface VolunteerRegistryConfig {
  readonly store: VolunteerStore;
  readonly bus?: VinyanBus;
  readonly now?: () => number;
  readonly idFactory?: () => string;
}

/**
 * Collects offers for tasks and persists them to SQLite. Callers feed in
 * `declareOffer(taskId, engineId)` during the volunteer window; at window
 * close, `finalize(taskId, candidates)` consults the in-memory offers +
 * caller-supplied scoring context and returns a verdict.
 */
export class VolunteerRegistry {
  private readonly store: VolunteerStore;
  private readonly bus?: VinyanBus;
  private readonly now: () => number;
  private readonly newId: () => string;

  constructor(config: VolunteerRegistryConfig) {
    this.store = config.store;
    this.bus = config.bus;
    this.now = config.now ?? (() => Date.now());
    this.newId = config.idFactory ?? (() => randomUUID());
  }

  /** Record an offer. Returns the row for use in the selection step. */
  declareOffer(params: { taskId: string; engineId: string }): VolunteerOffer {
    const offerId = this.newId();
    const offeredAt = this.now();
    this.store.insertOffer({
      offerId,
      taskId: params.taskId,
      engineId: params.engineId,
      offeredAt,
    });
    const offer: VolunteerOffer = {
      offerId,
      taskId: params.taskId,
      engineId: params.engineId,
      offeredAt,
    };
    this.bus?.emit('ecosystem:volunteer_offered', offer);
    return offer;
  }

  /** List offers recorded for a task (helpful for tests / observability). */
  offersForTask(taskId: string): readonly VolunteerOfferRecord[] {
    return this.store.listOffersByTask(taskId);
  }

  /**
   * Close the volunteer window and pick a winner.
   *
   * @param candidates  the offers with scoring context; must be a subset of
   *                    the offers previously declared for the task. The caller
   *                    assembles context (capability, trust, load) from their
   *                    own sources.
   * @param commitmentId  commitment-id that the winner is about to be bound
   *                      to. Accepted offers are linked to this id.
   */
  finalize(
    taskId: string,
    candidates: readonly VolunteerCandidate[],
    commitmentId: string,
  ): SelectionVerdict {
    const verdict = selectVolunteer(candidates);
    const at = this.now();

    if (verdict.winner) {
      this.store.acceptOffer({
        offerId: verdict.winner.offerId,
        commitmentId,
        at,
      });
      // Decline the rest
      for (const c of candidates) {
        if (c.offer.offerId === verdict.winner.offerId) continue;
        this.store.declineOffer(c.offer.offerId, 'not-selected');
      }
      this.bus?.emit('ecosystem:volunteer_selected', {
        taskId,
        winnerEngineId: verdict.winner.engineId,
        commitmentId,
        score: verdict.scores[0]!.score,
        offerCount: candidates.length,
      });
    } else {
      for (const c of candidates) {
        this.store.declineOffer(c.offer.offerId, verdict.reason);
      }
    }

    return verdict;
  }
}
