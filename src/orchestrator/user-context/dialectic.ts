/**
 * Dialectic update rule for USER.md.
 *
 * Given a `UserMdRecord` and a history of per-turn prediction-error deltas
 * (see `prediction-error.ts`), decide per section whether to:
 *
 *   - `none`                — rolling error is below the revision threshold.
 *   - `demoted`             — error above revision threshold but no critic
 *                             available. Drop evidence tier one step (A5);
 *                             no LLM means no new prediction is produced,
 *                             so the old claim stays but is weakened.
 *   - `revised`             — error above revision threshold AND a critic
 *                             dep is provided. The critic proposes a new
 *                             prediction from observed samples; tier resets
 *                             to `probabilistic` until re-verified.
 *   - `flipped-to-unknown`  — error above the *flip* threshold. Collapse
 *                             the section to the A2 unknown state: tier
 *                             `speculative`, confidence 0, prediction text
 *                             swapped to the sentinel placeholder.
 *
 * The rule is deterministic (A3): given the same inputs it emits the same
 * updates. The critic dep is intentionally OPTIONAL so the rule can degrade
 * gracefully without an LLM, and when present it is invoked from a
 * different component (A1: gen ≠ verify — the rule verifies/demotes; the
 * critic, not this file, generates a new prediction).
 */
import type { ConfidenceTier } from '../../core/confidence-tier.ts';
import { rollingMean } from './prediction-error.ts';
import { demoteOneTier, UNKNOWN_PREDICTION_TEXT, type UserMdRecord, type UserMdSection } from './user-md-schema.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Single per-turn observation for a given section slug. */
export interface SectionObservation {
  readonly slug: string;
  readonly observed: string;
  /** Prediction at the time of observation. Passed through so the rule doesn't
   *  need to look up history mid-evaluation. */
  readonly predicted: string;
  readonly delta: number;
  readonly ts: number;
}

/** Decision emitted per section. */
export interface DialecticUpdate {
  readonly slug: string;
  readonly kind: 'none' | 'revised' | 'flipped-to-unknown' | 'demoted';
  readonly reason: string;
  readonly newPredictedResponse?: string;
  readonly newEvidenceTier?: ConfidenceTier;
  readonly newConfidence?: number;
  /** Rolling mean of deltas across the window used for the decision. */
  readonly windowError: number;
  readonly windowSize: number;
}

/** Optional critic that proposes a replacement prediction from observed samples. */
export type DialecticCritic = (
  section: UserMdSection,
  observed: string[],
) => Promise<{ newPrediction: string; confidence: number }>;

/** Inputs to the rule. All thresholds default to the sane values below. */
export interface DialecticDeps {
  readonly record: UserMdRecord;
  readonly observationHistory: ReadonlyArray<SectionObservation>;
  readonly windowSize?: number;
  readonly revisionThreshold?: number;
  readonly flipThreshold?: number;
  readonly critic?: DialecticCritic;
  /** Clock injection for deterministic tests; defaults to `Date.now`. */
  readonly now?: () => number;
}

// ---------------------------------------------------------------------------
// Defaults — tuned so that Jaccard distances in [0.5, 0.8] revise rather
// than flip, and only near-total disagreement (≥ 0.85) flips to unknown.
// ---------------------------------------------------------------------------

export const DIALECTIC_DEFAULTS = {
  windowSize: 5,
  revisionThreshold: 0.6,
  flipThreshold: 0.85,
} as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Most-recent `windowSize` observations for the given slug. Returns the
 * raw objects in chronological order (oldest → newest) for stable unit tests.
 */
function windowForSlug(
  history: ReadonlyArray<SectionObservation>,
  slug: string,
  windowSize: number,
): SectionObservation[] {
  const all = history.filter((o) => o.slug === slug);
  all.sort((a, b) => a.ts - b.ts);
  if (all.length <= windowSize) return all;
  return all.slice(all.length - windowSize);
}

function noOp(slug: string, windowError: number, windowSize: number, reason: string): DialecticUpdate {
  return { slug, kind: 'none', reason, windowError, windowSize };
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

/**
 * Evaluate every section in `deps.record` and emit an update per section.
 * Sections with no observations in the window receive a `none` update.
 *
 * The function does NOT mutate the input record. Callers apply the updates
 * via the store (`UserMdStore.applyRevision`).
 */
export async function applyDialectic(deps: DialecticDeps): Promise<DialecticUpdate[]> {
  const windowSize = deps.windowSize ?? DIALECTIC_DEFAULTS.windowSize;
  const revisionThreshold = deps.revisionThreshold ?? DIALECTIC_DEFAULTS.revisionThreshold;
  const flipThreshold = deps.flipThreshold ?? DIALECTIC_DEFAULTS.flipThreshold;
  const now = deps.now ?? (() => Date.now());

  const updates: DialecticUpdate[] = [];

  for (const section of deps.record.sections) {
    const window = windowForSlug(deps.observationHistory, section.slug, windowSize);
    if (window.length === 0) {
      updates.push(noOp(section.slug, 0, 0, 'no observations in window'));
      continue;
    }

    const deltas = window.map((o) => o.delta);
    const windowError = rollingMean(deltas);

    // --- Flip to unknown (highest priority) -------------------------------
    if (windowError > flipThreshold) {
      updates.push({
        slug: section.slug,
        kind: 'flipped-to-unknown',
        reason: `rolling error ${windowError.toFixed(3)} > flip threshold ${flipThreshold} over ${window.length} observations`,
        newPredictedResponse: UNKNOWN_PREDICTION_TEXT,
        newEvidenceTier: 'speculative',
        newConfidence: 0,
        windowError,
        windowSize: window.length,
      });
      continue;
    }

    // --- Revise or demote -----------------------------------------------
    if (windowError > revisionThreshold) {
      if (deps.critic) {
        const observed = window.map((o) => o.observed);
        const proposal = await deps.critic(section, observed);
        updates.push({
          slug: section.slug,
          kind: 'revised',
          reason: `rolling error ${windowError.toFixed(3)} > revision threshold ${revisionThreshold}; critic proposed replacement`,
          newPredictedResponse: proposal.newPrediction,
          newEvidenceTier: 'probabilistic',
          newConfidence: Math.max(0, Math.min(0.85, proposal.confidence)),
          windowError,
          windowSize: window.length,
        });
        continue;
      }

      // No critic → demote one tier; prediction text unchanged.
      const nextTier = demoteOneTier(section.evidenceTier);
      if (nextTier === section.evidenceTier) {
        // Already at floor (speculative). No-op but recorded for audit.
        updates.push({
          slug: section.slug,
          kind: 'none',
          reason: `rolling error ${windowError.toFixed(3)} > revision threshold but already at demotion floor '${section.evidenceTier}'`,
          windowError,
          windowSize: window.length,
        });
        continue;
      }
      updates.push({
        slug: section.slug,
        kind: 'demoted',
        reason: `rolling error ${windowError.toFixed(3)} > revision threshold ${revisionThreshold}; no critic — demoted ${section.evidenceTier} → ${nextTier}`,
        newEvidenceTier: nextTier,
        // Confidence dampened by ~35% on each demotion to reflect weaker tier.
        newConfidence: Math.max(0, section.confidence * 0.65),
        windowError,
        windowSize: window.length,
      });
      continue;
    }

    updates.push(noOp(section.slug, windowError, window.length, 'rolling error below revision threshold'));
  }

  // Timestamp is carried in the reason field for debuggability; the store
  // records `lastRevisedAt` when the update is applied, not here. Consume
  // `now()` defensively so the dep is always used.
  void now();
  return updates;
}
