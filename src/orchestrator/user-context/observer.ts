/**
 * UserMdObserver — dialectic wiring for USER.md.
 *
 * Two-step observer:
 *   1. `observeTurn` is called after a user turn is persisted. For every
 *      active USER.md section with a non-empty `predictedResponse` it computes
 *      a prediction-error delta against the turn text and records it via
 *      `UserMdStore.recordError`. This is a pure ledger append — A7 in
 *      action, no decisions taken here.
 *   2. `applyPending` is called periodically (Sleep Cycle in P5, or on-demand
 *      from the CLI). It asks the dialectic rule in `./dialectic.ts` to make
 *      demote/revise/flip decisions from the rolling window and then applies
 *      those decisions to the store.
 *
 * Axiom anchors:
 *   - A1 Generation ≠ verification. The observer is a verifier (records
 *     reality); the critic dep (optional) is the generator of revised
 *     predictions. The observer never asks an LLM to evaluate its own output.
 *   - A2 First-class uncertainty — flips to `unknown` propagate via the
 *     dialectic rule.
 *   - A3 Deterministic governance — `observeTurn` is pure; `applyPending` is
 *     rule-based with an optional critic escape hatch.
 *   - A7 Prediction-error as learning — every user turn ledgers its delta
 *     against every active prediction so the rolling rule has replay data.
 */
import type { UserMdStore } from '../../db/user-md-store.ts';

import { applyDialectic, type DialecticDeps, type DialecticUpdate, type SectionObservation } from './dialectic.ts';
import { computeSectionDelta } from './prediction-error.ts';
import { UNKNOWN_PREDICTION_TEXT, type UserMdRecord, type UserMdSection } from './user-md-schema.ts';

export interface UserMdObserverDeps {
  readonly store: UserMdStore;
  readonly profile: string;
  readonly clock?: () => number;
  /** Optional critic for dialectic revisions (A1 — verifier ≠ generator). */
  readonly critic?: DialecticDeps['critic'];
  /** Thresholds for dialectic rule. Defaults per dialectic.ts. */
  readonly windowSize?: number;
  readonly revisionThreshold?: number;
  readonly flipThreshold?: number;
}

export interface ObserveTurnArgs {
  readonly turnId: string;
  readonly userText: string;
  readonly ts: number;
}

export class UserMdObserver {
  private readonly store: UserMdStore;
  private readonly profile: string;
  private readonly clock: () => number;
  private readonly critic?: DialecticDeps['critic'];
  private readonly windowSize?: number;
  private readonly revisionThreshold?: number;
  private readonly flipThreshold?: number;

  constructor(deps: UserMdObserverDeps) {
    this.store = deps.store;
    this.profile = deps.profile;
    this.clock = deps.clock ?? (() => Date.now());
    if (deps.critic) this.critic = deps.critic;
    if (deps.windowSize !== undefined) this.windowSize = deps.windowSize;
    if (deps.revisionThreshold !== undefined) this.revisionThreshold = deps.revisionThreshold;
    if (deps.flipThreshold !== undefined) this.flipThreshold = deps.flipThreshold;
  }

  /**
   * Record the observed-vs-predicted delta for every active section after a
   * user turn is persisted. Sections with an empty `predictedResponse` or
   * a `predictedResponse` equal to the unknown sentinel are skipped — we have
   * no claim to falsify.
   *
   * Best-effort: errors from `store.recordError` are caught and logged so a
   * store hiccup can never break turn processing.
   */
  observeTurn(args: ObserveTurnArgs): void {
    let sections: UserMdSection[];
    try {
      sections = this.store.getSections(this.profile);
    } catch (err) {
      console.warn(`[user-md] getSections failed for profile=${this.profile}: ${String(err)}`);
      return;
    }

    for (const section of sections) {
      const prediction = section.predictedResponse;
      if (!prediction || prediction.length === 0) continue;
      if (prediction === UNKNOWN_PREDICTION_TEXT) continue;

      const delta = computeSectionDelta(prediction, args.userText);
      try {
        this.store.recordError({
          profile: this.profile,
          slug: section.slug,
          observed: args.userText,
          predicted: prediction,
          delta,
          turnId: args.turnId,
          ts: args.ts,
        });
      } catch (err) {
        // Never throw — the caller persists turns, a ledger-append failure
        // must not cascade into a lost user turn.
        console.warn(`[user-md] recordError failed for profile=${this.profile} slug=${section.slug}: ${String(err)}`);
      }
    }
  }

  /**
   * Run the dialectic rule over the current rolling window and apply the
   * resulting updates to the store. Meant to be called periodically (Sleep
   * Cycle owns the trigger in P5) or on demand from the CLI.
   *
   * Returns the updates that were produced. Updates with `kind === 'none'`
   * are returned unchanged for observability but do NOT touch the store.
   */
  async applyPending(): Promise<readonly DialecticUpdate[]> {
    const sections = this.store.getSections(this.profile);
    if (sections.length === 0) return [];

    const windowSize = this.windowSize ?? undefined;
    const effectiveWindow = windowSize ?? 5; // dialectic default, mirrored so we can pull history

    const observationHistory: SectionObservation[] = [];
    for (const section of sections) {
      const window = this.store.rollingWindow(this.profile, section.slug, effectiveWindow);
      for (const row of window) {
        observationHistory.push({
          slug: row.slug,
          observed: row.observed,
          predicted: row.predicted,
          delta: row.delta,
          ts: row.ts,
        });
      }
    }

    const record: UserMdRecord = {
      frontmatter: { version: '1.0.0', profile: this.profile },
      sections,
    };

    const deps: DialecticDeps = {
      record,
      observationHistory,
      ...(this.windowSize !== undefined && { windowSize: this.windowSize }),
      ...(this.revisionThreshold !== undefined && { revisionThreshold: this.revisionThreshold }),
      ...(this.flipThreshold !== undefined && { flipThreshold: this.flipThreshold }),
      ...(this.critic && { critic: this.critic }),
    };

    const updates = await applyDialectic(deps);

    const now = this.clock();
    for (const update of updates) {
      if (update.kind === 'none') continue;
      const patch: Parameters<UserMdStore['applyRevision']>[2] = {
        lastRevisedAt: now,
        ...(update.newPredictedResponse !== undefined && { predictedResponse: update.newPredictedResponse }),
        ...(update.newEvidenceTier !== undefined && { evidenceTier: update.newEvidenceTier }),
        ...(update.newConfidence !== undefined && { confidence: update.newConfidence }),
      };
      try {
        this.store.applyRevision(this.profile, update.slug, patch);
      } catch (err) {
        console.warn(`[user-md] applyRevision failed for profile=${this.profile} slug=${update.slug}: ${String(err)}`);
      }
    }

    return updates;
  }
}
