/**
 * A5 merge rule — combine a rule-based stage-1 envelope with an
 * LLM-based stage-2 envelope into a single hybrid output.
 *
 * Invariants (all axiom-driven):
 *   A1 — The merger does not generate; it only projects. No new facts.
 *   A2 — When either side is `type: 'unknown'`, the known side wins
 *        (or we return the non-unknown side). Never silently substitute.
 *   A3 — Pure function; deterministic given inputs. No LLM in merge path.
 *   A4 — `inputHash` must match between s1 and s2. Mismatched hashes =
 *        refuse to merge — consumer falls back to s1 alone.
 *   A5 — Final `tier` = the LOWER of the two (conservative). The
 *        LLM's probabilistic input CANNOT upgrade a rule result; it can
 *        only enrich resolvedGoal/priorContextSummary WITHIN the stage-1
 *        structural state (isClarificationAnswer, rootGoal, etc.)
 *   A6 — State flags stay the rule engine's — no LLM influence on
 *        governance-critical structural signals.
 *
 * The merger NEVER throws. On contradiction or mismatch it returns s1
 * unchanged (fail-safe to the deterministic side).
 */

import type { ComprehendedTaskMessage } from './types.ts';
import { tierRank, type ComprehensionTier } from './types.ts';

/** Pick the lower-trust tier (more conservative). */
function lowerTier(a: ComprehensionTier, b: ComprehensionTier): ComprehensionTier {
  return tierRank(a) <= tierRank(b) ? a : b;
}

export interface MergeResult {
  /** The merged envelope (or s1 unchanged when merge was declined). */
  readonly envelope: ComprehendedTaskMessage;
  /**
   * True when s2 actually contributed to the final envelope. False when
   * the merger declined (hash mismatch, s2=unknown, etc.) — consumers
   * can log this for A7 diagnostics.
   */
  readonly s2Contributed: boolean;
  /** Short reason when s2 did NOT contribute. */
  readonly declineReason?: string;
}

/**
 * Merge stage-1 (rule) and stage-2 (LLM) comprehension envelopes.
 *
 * Fast-path outcomes:
 *   - s2 is `type: 'unknown'`        → s1 unchanged, declineReason='s2-unknown'
 *   - inputHash mismatch             → s1 unchanged, declineReason='hash-mismatch'
 *   - s1 is `type: 'unknown'`        → s2's payload is accepted (nothing to merge),
 *                                      but tier stays probabilistic
 *
 * Enrichment (when both sides are usable):
 *   - resolvedGoal: s2 wins IF s1 couldn't anchor (resolvedGoal === literalGoal)
 *                   AND s2's resolvedGoal differs meaningfully. Otherwise s1.
 *   - priorContextSummary: s2 wins (LLM enriches prose).
 *   - state: ALWAYS from s1 (A6 — governance-critical deterministic signals).
 *   - rootGoal: from s1 (should be identical; validated via hash).
 *   - memoryLaneRelevance: from s1 (rule-based token-overlap is the stable signal).
 *   - tier: lowerTier(s1, s2) — conservative (A5).
 *   - confidence: min(s1, s2) — LLM confidence is already ceiling-clamped.
 *   - evidence_chain: s1.evidence_chain ++ s2.evidence_chain (preserve both).
 *   - falsifiable_by: union of both sides (preserve all falsifiers).
 */
export function mergeComprehensions(
  s1: ComprehendedTaskMessage,
  s2: ComprehendedTaskMessage,
): MergeResult {
  // A4: refuse to merge across different inputs. This shouldn't happen
  // when the pipeline drives both engines with the same ComprehensionInput,
  // but a bug upstream would create ghost mergers — guard explicitly.
  if (s1.params.inputHash !== s2.params.inputHash) {
    return {
      envelope: s1,
      s2Contributed: false,
      declineReason: 'hash-mismatch',
    };
  }

  // s2 couldn't resolve — return s1 alone. Note s1.evidence still reflects
  // only stage 1; the orchestrator can emit an observability bus event
  // based on MergeResult.declineReason.
  if (s2.params.type === 'unknown') {
    return {
      envelope: s1,
      s2Contributed: false,
      declineReason: 's2-unknown',
    };
  }

  // s1 was itself unknown (rare — empty literal goal). The LLM CAN'T
  // anchor against an empty goal either; honestly keep `type: unknown`
  // but fold in s2's evidence for audit.
  if (s1.params.type === 'unknown' || !s1.params.data) {
    return {
      envelope: {
        ...s1,
        params: {
          ...s1.params,
          evidence_chain: [...s1.params.evidence_chain, ...s2.params.evidence_chain],
        },
      },
      s2Contributed: false,
      declineReason: 's1-unknown',
    };
  }

  const s1Data = s1.params.data;
  const s2Data = s2.params.data;
  if (!s2Data) {
    // Defensive — shouldn't happen given s2.type === 'comprehension' here.
    return { envelope: s1, s2Contributed: false, declineReason: 's2-missing-data' };
  }

  // Enrichment decisions.
  const s1CouldNotAnchor = s1Data.resolvedGoal === s1Data.literalGoal;
  const s2Differs = s2Data.resolvedGoal !== s1Data.literalGoal && s2Data.resolvedGoal.length > 0;
  const resolvedGoal = s1CouldNotAnchor && s2Differs ? s2Data.resolvedGoal : s1Data.resolvedGoal;

  const priorContextSummary =
    s2Data.priorContextSummary && s2Data.priorContextSummary.length > s1Data.priorContextSummary.length
      ? s2Data.priorContextSummary
      : s1Data.priorContextSummary;

  const mergedTier = lowerTier(s1.params.tier, s2.params.tier);
  const mergedConfidence = Math.min(s1.params.confidence, s2.params.confidence);
  const mergedEvidence = [...s1.params.evidence_chain, ...s2.params.evidence_chain];
  const mergedFalsifiable = Array.from(
    new Set([...s1.params.falsifiable_by, ...s2.params.falsifiable_by]),
  );
  // Temporal: keep the earlier `as_of` (the originating moment) and the
  // narrower `valid_until` (whichever expires first).
  const mergedTemporal = {
    as_of: Math.min(s1.params.temporal_context.as_of, s2.params.temporal_context.as_of),
    ...(s1.params.temporal_context.valid_until || s2.params.temporal_context.valid_until
      ? {
          valid_until: (() => {
            const a = s1.params.temporal_context.valid_until;
            const b = s2.params.temporal_context.valid_until;
            if (a == null) return b;
            if (b == null) return a;
            return Math.min(a, b);
          })(),
        }
      : {}),
  };

  return {
    envelope: {
      jsonrpc: '2.0',
      method: 'comprehension.result',
      params: {
        type: 'comprehension',
        confidence: mergedConfidence,
        tier: mergedTier,
        evidence_chain: mergedEvidence,
        falsifiable_by: mergedFalsifiable,
        temporal_context: mergedTemporal,
        inputHash: s1.params.inputHash,
        rootGoal: s1.params.rootGoal,
        data: {
          literalGoal: s1Data.literalGoal,
          resolvedGoal,
          state: s1Data.state, // A6 — governance signals from rule engine.
          priorContextSummary,
          memoryLaneRelevance: s1Data.memoryLaneRelevance, // rule-based stable signal.
        },
      },
    },
    s2Contributed: true,
  };
}
