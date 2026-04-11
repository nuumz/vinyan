/**
 * Overconfidence Detector — lexical analysis to detect RLHF overconfidence bias.
 *
 * Detects patterns where LLMs produce high-certainty output for uncertain claims,
 * a direct consequence of RLHF rewarding confident, detailed responses.
 *
 * A3 compliant: deterministic pattern matching, no LLM.
 *
 * Source of truth: HMS plan §H1 (HMS-4)
 */

export interface OverconfidenceSignals {
  certainty_markers: number;
  hedging_absence: boolean;
  universal_claims: number;
  false_precision: number;
  score: number;
}

/** Certainty markers — language indicating unwarranted confidence. */
const CERTAINTY_PATTERNS =
  /\b(definitely|certainly|absolutely|undoubtedly|guaranteed|always works|never fails|without question|100%|impossible to)\b/gi;

/** Hedging markers — language indicating appropriate uncertainty. */
const HEDGING_PATTERNS =
  /\b(might|perhaps|possibly|probably|I think|I believe|could be|may be|it seems|likely|uncertain|not sure|approximately|roughly)\b/gi;

/** Universal claims without qualification. */
const UNIVERSAL_PATTERNS =
  /\b(always|never|all cases|every time|no exceptions|in all situations|without exception)\b/gi;

/** False precision — specific numbers/percentages without source. */
const FALSE_PRECISION_RE = /\b(\d{2,}%|\d+\.\d{2,}x|\d{4,}\s*(ms|tokens|bytes))\b/g;

/**
 * Detect overconfidence signals in LLM output.
 * Pure function — no side effects (A3).
 */
export function detectOverconfidence(text: string): OverconfidenceSignals {
  const words = text.split(/\s+/).length;
  const per100 = Math.max(1, words / 100);

  const certaintyMatches = text.match(CERTAINTY_PATTERNS) ?? [];
  const hedgingMatches = text.match(HEDGING_PATTERNS) ?? [];
  const universalMatches = text.match(UNIVERSAL_PATTERNS) ?? [];
  const falsePrecisionMatches = text.match(FALSE_PRECISION_RE) ?? [];

  const certaintyMarkers = certaintyMatches.length;
  const hedgingAbsence = hedgingMatches.length === 0 && words > 50;
  const universalClaims = universalMatches.length;
  const falsePrecision = falsePrecisionMatches.length;

  // Weighted composite (A3: deterministic formula)
  const score = Math.min(
    1.0,
    0.35 * Math.min(1, certaintyMarkers / per100) +
      0.25 * (hedgingAbsence ? 1 : 0) +
      0.25 * Math.min(1, universalClaims / per100) +
      0.15 * Math.min(1, falsePrecision / per100),
  );

  return {
    certainty_markers: certaintyMarkers,
    hedging_absence: hedgingAbsence,
    universal_claims: universalClaims,
    false_precision: falsePrecision,
    score,
  };
}
