/**
 * Correction Detector — closes half of the A7 learning loop.
 *
 * Called at the TOP of each task's pipeline (before this turn's
 * comprehension runs), with the prior turn's comprehension record. The
 * detector decides whether the user's NEW message confirms, corrects, or
 * abandons the prior resolvedGoal — then writes that outcome back to
 * `ComprehensionStore`, giving the calibrator a labeled sample.
 *
 * Detection is rule-based (A3): no LLM in the decision path. The cost of
 * rule-brittleness is a soft `abandoned` bucket (we refuse to guess when
 * signals are mixed), not a hallucinated outcome.
 *
 * Patterns (Thai + English):
 *   - **corrected**: user reply opens with a negation/correction token
 *     ("no / not that / actually / I meant / ไม่ใช่ / ผิด / แก้") OR
 *     explicitly negates the prior resolvedGoal by word overlap.
 *   - **confirmed**: user reply continues the thread WITHOUT correction
 *     tokens AND isn't the start of a new unrelated topic.
 *   - **abandoned**: detector cannot decide → soft bucket. Nightly sweep
 *     also promotes long-pending records to abandoned.
 *
 * A2 note: the detector NEVER returns a fake outcome under uncertainty;
 * it emits `null` and leaves the record pending for the sweep.
 */

import type { ComprehensionRecordRow } from '../../../db/comprehension-store.ts';

/** Tokens that, at the START of a reply, strongly imply correction. */
const CORRECTION_OPENING_TOKENS = [
  // English
  'no,',
  'no ',
  'not that',
  'not really',
  'not quite',
  'not what',
  'actually',
  'i meant',
  'i mean',
  'wait,',
  'wait ',
  'wrong',
  'incorrect',
  "that's not",
  'thats not',
  'change',
  'instead',
  'undo',
  // Thai
  'ไม่ใช่',
  'ผิด',
  'ไม่ได้',
  'ไม่ถูก',
  'ไม่ตรง',
  'แก้',
  'เปลี่ยน',
  'ผมหมายถึง',
  'ฉันหมายถึง',
  'หมายถึง',
] as const;

/**
 * Tokens inside a reply that signal explicit negation of the prior
 * result. Thai patterns deliberately omit `\b` word-boundary anchors
 * because Thai is not space-delimited; a `\b` would only match at
 * start-of-string / after non-Thai punctuation.
 */
const NEGATION_WITHIN_REPLY = [
  /\bnot\s+(?:that|this|the)\b/i,
  // "I don't want", "don't want", "do not want" — catches adverb insertions
  // like "really" by relaxing the left anchor.
  /\b(?:do\s+not|don'?t)\s+want\b/i,
  /ไม่\s*อยาก/,
  /ไม่\s*ใช่/,
  /เอา\s*ที่\s*ไม่/, // "เอาที่ไม่" — "I want one that's NOT..."
] as const;

export interface CorrectionDetectorInput {
  /**
   * The most-recent comprehension record for this session whose outcome
   * is still pending. Detector returns `null` when absent — there is
   * nothing to calibrate.
   */
  priorRecord: ComprehensionRecordRow | null;
  /** The user's current-turn message text. */
  currentUserMessage: string;
  /**
   * When true, this turn is a clarification answer for the prior turn
   * (detected by the comprehender itself). Clarification answers are
   * ALWAYS continuations — they can't "correct" a prior comprehension in
   * the sense the calibrator cares about, because the prior comprehension
   * was explicitly awaiting input.
   */
  currentIsClarificationAnswer: boolean;
  /**
   * Sometimes the prior record is fresh but unrelated (e.g. user is
   * starting a brand-new topic). When true, we emit `abandoned` instead
   * of judging.
   */
  currentIsNewTopic: boolean;
}

export type CorrectionVerdict =
  | {
      outcome: 'confirmed' | 'corrected' | 'abandoned';
      evidence: Record<string, unknown>;
    }
  | null;

/**
 * Detect the user's intent re: the prior comprehension. Pure function;
 * no IO. Callers combine with `ComprehensionStore.markOutcome`.
 */
export function detectCorrection(input: CorrectionDetectorInput): CorrectionVerdict {
  if (!input.priorRecord) return null;
  if (input.priorRecord.outcome) return null; // already marked

  const normalized = input.currentUserMessage.toLowerCase().trim();

  // 1. Clarification-answer path — always confirms (user is providing
  //    the data we asked for, not disputing the prior resolvedGoal).
  if (input.currentIsClarificationAnswer) {
    return {
      outcome: 'confirmed',
      evidence: { reason: 'clarification-answer', signal: 'continuation' },
    };
  }

  // 2. Explicit correction tokens at the opening of the reply.
  for (const token of CORRECTION_OPENING_TOKENS) {
    if (normalized.startsWith(token)) {
      return {
        outcome: 'corrected',
        evidence: { reason: 'correction-token', token, position: 'opening' },
      };
    }
  }

  // 3. Embedded negation patterns.
  for (const re of NEGATION_WITHIN_REPLY) {
    if (re.test(input.currentUserMessage)) {
      return {
        outcome: 'corrected',
        evidence: { reason: 'embedded-negation', pattern: re.source },
      };
    }
  }

  // 4. New-topic = abandoned (user moved on without resolving/confirming).
  if (input.currentIsNewTopic) {
    return {
      outcome: 'abandoned',
      evidence: { reason: 'new-topic', signal: 'topic-shift' },
    };
  }

  // 5. Default: the user continued the thread without corrective language.
  //    Treat as confirmed — this is the common happy path.
  return {
    outcome: 'confirmed',
    evidence: { reason: 'continuation', signal: 'no-correction-detected' },
  };
}
