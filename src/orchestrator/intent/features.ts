/**
 * Structural feature extraction for intent classification.
 *
 * Extracted from `src/orchestrator/intent-resolver.ts` (plan commit D2).
 *
 * The deterministic tier computes signals that are unambiguous — length,
 * end-punctuation, turn number — and hands them to the classifier alongside
 * the raw goal text. Pure: no I/O, no LLM, no side effects.
 */
import type { Turn } from '../types.ts';

export interface StructuralFeatures {
  /** Goal length in characters after trim. */
  lengthChars: number;
  /** True when the goal ends with a punctuation or particle that marks it as a question. */
  endsWithQuestion: boolean;
  /** Number of the current turn in the session (1-indexed). */
  turnNumber: number;
}

const THAI_QUESTION_PARTICLE_REGEX = /(ไหม|มั้ย|หรือเปล่า|หรอ|รึเปล่า|หรือไม่)[\s.?？]*$/u;

export function computeStructuralFeatures(
  goal: string,
  /** A6: Turn-model history replaces the legacy ConversationEntry[] input. */
  turns?: Turn[],
): StructuralFeatures {
  const trimmed = goal.trim();
  // Accept ASCII '?' and full-width '？' (U+FF1F, common in Thai/CJK IME input)
  // plus trailing Thai interrogative particles.
  const endsWithQuestion =
    trimmed.endsWith('?') ||
    trimmed.endsWith('？') ||
    THAI_QUESTION_PARTICLE_REGEX.test(trimmed);
  return {
    lengthChars: trimmed.length,
    endsWithQuestion,
    turnNumber: Math.floor((turns?.length ?? 0) / 2) + 1,
  };
}

export function renderStructuralFeatures(f: StructuralFeatures): string {
  return `Goal metadata (deterministic): length=${f.lengthChars} chars; ends with question marker: ${f.endsWithQuestion ? 'yes' : 'no'}; session turn: #${f.turnNumber}`;
}
