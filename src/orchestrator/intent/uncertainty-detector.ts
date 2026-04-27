/**
 * Uncertainty detector — deterministic gate that decides whether the primary
 * intent classifier's verdict is "clear enough to commit" or warrants a
 * second-stage focused verifier.
 *
 * Embodies Axiom A2 (first-class uncertainty): the detector enumerates
 * named uncertainty reasons that flow into the bus for observability,
 * rather than papering over ambiguity with a default.
 *
 * Embodies Axiom A3 (deterministic governance): the trigger decision is a
 * pure function of regex hits, confidence thresholds, and rule-mapper flags
 * — no LLM in the gate itself. The verifier (when invoked) is a separate
 * LLM call with a different prompt and tier (A1 generation ≠ verification).
 *
 * Pure: no I/O, no module state.
 */

import type {
  ExecutionStrategy,
  IntentDeterministicCandidate,
  IntentResolution,
} from '../types.ts';
import type { IntentResponse } from './parser.ts';

export type UncertaintyReason =
  /** Merged confidence below the commit threshold. */
  | 'low-confidence'
  /** Goal text contains explicit deliverable-shape signals (artifact noun + size). */
  | 'deliverable-signal-regex'
  /** Deterministic rule-mapper flagged ambiguity (creativeAmbiguity / missingReferent). */
  | 'deterministic-ambiguous'
  /** LLM picked the cheapest class (conversational) but goal length + signals contradict it. */
  | 'cheapest-class-with-deliverable-signal';

export interface UncertaintyVerdict {
  uncertain: boolean;
  reasons: UncertaintyReason[];
  /** Strategy the verifier should test FOR — typically 'agentic-workflow'. */
  suspectedTarget?: ExecutionStrategy;
}

/**
 * Deliverable signals: explicit artifact nouns paired with size hints. The
 * regex is intentionally narrower than `short-affirmative.ts`'s noun list —
 * here we want HIGH-PRECISION evidence that the user expects a multi-section
 * artifact, not just any mention of "story" / "report".
 *
 * TUNE: the noun + quantity pattern was chosen because it is the most
 * reliable structural signal observed in misclassification incidents. False
 * positives will surface in the `intent:verifier_invoked` event stream for
 * empirical tuning.
 */
const DELIVERABLE_REGEX_PATTERNS: RegExp[] = [
  // Quantity + Thai artifact noun: "2 บท", "5 ตอน", "3 หน้า"
  /\d+\s*(บท|ตอน|หน้า|chapter|chapters|page|pages|section|sections|paragraph|paragraphs)/i,
  // Imperative + creative artifact noun (Thai). Allow up to a few intervening
  // characters so phrasings like "ช่วยเขียนนิยายก่อนนอน" / "เขียนเรื่องสั้นเรื่องหนึ่ง" still match.
  /(เขียน|แต่ง|สร้าง|ร่าง|ประพันธ์|ออกแบบ)[^.!?]{0,20}(นิยาย|นิทาน|บทความ|รายงาน|บท|ตอน|กลอน|สคริปต์|เรื่อง|essay|story|article|poem|script)/i,
  // English authoring verbs + artifact noun. Allow up to 40 chars between
  // verb and noun so "write me a chapter about cats" / "draft a long report on X" match.
  /\b(write|draft|compose|author|generate|produce)\b[^.!?]{0,40}\b(story|chapter|article|essay|report|poem|script|spec|outline|deck|novel|book)\b/i,
  // Plural multi-section / multi-page hints
  /(หลาย\s*(บท|ตอน|หน้า)|multi[-\s]*chapter|multi[-\s]*page|long[-\s]*form)/i,
];

/** Heuristic threshold below which we treat a verdict as not committable. TUNE empirically. */
export const UNCERTAINTY_CONFIDENCE_FLOOR = 0.65;
/**
 * Character count above which a "conversational" verdict deserves extra
 * scrutiny when deliverable signals are present. Tuned for Thai prose
 * density (no inter-word spaces) — 40 chars ≈ a full multi-clause sentence.
 * TUNE empirically as the verifier-invocation rate stabilizes.
 */
export const CHEAPEST_CLASS_LENGTH_THRESHOLD = 40;
/** Max merged-confidence after a verifier override — narrow binary verdicts are reliable, but capping prevents over-confidence. */
export const VERIFIER_OVERRIDE_CONFIDENCE = 0.78;

/** True when the goal text matches any high-precision deliverable signal. */
export function hasDeliverableSignal(goal: string): boolean {
  return DELIVERABLE_REGEX_PATTERNS.some((re) => re.test(goal));
}

export interface UncertaintyDetectorInput {
  merged: IntentResolution;
  llm: IntentResponse;
  deterministicCandidate: IntentDeterministicCandidate | null;
  goal: string;
}

/**
 * Decide whether the primary classifier's verdict warrants verifier
 * escalation. Conservative by design: only fires when deliberate signals
 * are present, not on every low-confidence call.
 *
 * The detector NEVER fires when the merged strategy is already
 * `agentic-workflow` — the verifier exists to catch under-classification
 * (conversational/direct-tool that should have been agentic-workflow), not
 * to second-guess correct verdicts.
 */
export function evaluateUncertainty(input: UncertaintyDetectorInput): UncertaintyVerdict {
  const { merged, llm, deterministicCandidate, goal } = input;
  const reasons: UncertaintyReason[] = [];

  // Skip: verdict is already on the heavier branch — no need to escalate to it.
  if (merged.strategy === 'agentic-workflow' || merged.strategy === 'full-pipeline') {
    return { uncertain: false, reasons: [] };
  }

  const mergedConfidence = merged.confidence ?? llm.confidence ?? 0;
  const goalHasDeliverable = hasDeliverableSignal(goal);

  if (mergedConfidence < UNCERTAINTY_CONFIDENCE_FLOOR) {
    reasons.push('low-confidence');
  }
  if (goalHasDeliverable) {
    reasons.push('deliverable-signal-regex');
  }
  if (deterministicCandidate?.ambiguous) {
    reasons.push('deterministic-ambiguous');
  }
  if (
    merged.strategy === 'conversational' &&
    goalHasDeliverable &&
    goal.length > CHEAPEST_CLASS_LENGTH_THRESHOLD
  ) {
    reasons.push('cheapest-class-with-deliverable-signal');
  }

  // Require at least one signal that is NOT just low-confidence — pure
  // low-confidence on conversational verdicts (e.g., short ambiguous Q&A)
  // should not always escalate, because the verifier itself costs an LLM
  // call. The deliverable signal or ambiguity flag is the cost-justifying
  // evidence.
  const hasSubstantiveSignal = reasons.some(
    (r) => r === 'deliverable-signal-regex' || r === 'deterministic-ambiguous' || r === 'cheapest-class-with-deliverable-signal',
  );
  if (!hasSubstantiveSignal) {
    return { uncertain: false, reasons: [] };
  }

  return {
    uncertain: true,
    reasons,
    // The verifier always tests "is this actually a deliverable" → on yes, flip to agentic-workflow.
    suspectedTarget: 'agentic-workflow',
  };
}
