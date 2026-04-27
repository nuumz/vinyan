/**
 * Short-affirmative continuation pre-classifier.
 *
 * Failure mode this fixes: a user types "จัดการให้เลย" / "ทำเลย" / "go" /
 * "ok do it" right after the assistant proposed a deliverable. The primary
 * intent classifier sees only the literal short reply and routes to
 * conversational, producing another empty acknowledgment instead of
 * dispatching the deliverable.
 *
 * The fix is a deterministic pre-classifier that runs BEFORE the LLM. When
 * it matches, it reconstructs the workflow prompt from the most recent
 * "promise without action" by the assistant and the user request that
 * preceded that promise — then short-circuits intent resolution to
 * `agentic-workflow` with that reconstructed prompt.
 *
 * Design rationale:
 *   - A1: separation — this is a deterministic verifier of what the LLM
 *     would otherwise have to infer; rule wins because the input is
 *     structurally unambiguous (literal short affirmative + recent unfulfilled
 *     promise).
 *   - A3: deterministic governance — no LLM in the routing decision.
 *   - Conservative match: requires BOTH a tight affirmative regex AND a
 *     recent assistant turn that contains a promise marker but no completed
 *     deliverable. Returns `matched: false` whenever either side is missing
 *     so the normal LLM flow takes over.
 *
 * Pure: no I/O, no module state.
 */

import type { Turn } from '../types.ts';

/**
 * The user's reply matches a short affirmative. Whitespace tolerated.
 * Trailing period optional. Examples covered: "จัดการให้เลย", "ทำเลย",
 * "เอาเลย", "เริ่มเลย", "ลุย", "จัดไป", "go", "do it", "ok", "okay",
 * "yes please", "เอา", "ไปต่อ".
 *
 * Tight by design — anything with additional context (e.g. "ok let me
 * think more") falls through.
 */
const AFFIRMATIVE_REGEX =
  /^\s*(จัด(การ)?(ให้)?(เลย)?|ทำ(เลย|ไป)?|เอาเลย|เริ่มเลย|ลุย|จัดไป|จัดมา|do\s*it|please\s*do|go(\s*ahead)?|ok(ay)?|yes(\s*please)?|sure|เอา|ไปต่อ)\s*[.!]?\s*$/i;

/** Tokens that look like a deliverable / artifact noun (Thai + English). */
const DELIVERABLE_NOUN_REGEX =
  /(นิยาย|นิทาน|บทความ|บทความ|รายงาน|สรุป|บท|ตอน|story|chapter|article|essay|report|poem|script|spec|outline|draft)/i;

/**
 * Tokens that mark a future-tense promise to do something the assistant
 * has NOT yet done in the same turn. Used to identify "I'll forward to X" /
 * "จะส่งต่อให้" style fake-delegation patterns.
 */
const PROMISE_MARKER_REGEX =
  /(จะ\s*(ส่งต่อ|มอบหมาย|จัดการ|เริ่ม|เขียน|ดำเนินการ)|พร้อมจะ|กำลังจะ|ส่งต่อให้|มอบหมายให้|will\s+(forward|send|hand|delegate|start|write|create)|let\s*me\s+(forward|delegate|hand)|forward(ed|ing)?\s+to|hand(ed|ing)?\s+off\s+to|delegating\s+to)/i;

/** Quick rejection: a fenced code block or numbered enumeration suggests the assistant ALREADY produced output. */
const COMPLETED_OUTPUT_HINTS = /```|^\s*\d+\.\s+\S/m;

export interface AffirmativeMatch {
  matched: boolean;
  /** Reconstructed prompt to feed into agentic-workflow when matched. */
  reconstructedWorkflowPrompt?: string;
  /** Human-readable reason recorded on the IntentResolution + bus event. */
  reason?: string;
  /** seq of the assistant turn whose promise we're acting on (for observability). */
  reconstructedFromTurnSeq?: number;
}

/**
 * Concatenate all text blocks of a turn into a single inspectable string.
 * Non-text blocks (tool_use, tool_result, etc.) are ignored — the heuristic
 * only inspects what the user can read.
 */
function turnText(turn: Turn): string {
  return turn.blocks
    .filter((b): b is Extract<typeof b, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

/**
 * Detect short-affirmative continuation. Scans up to the most recent 8
 * turns; the affirmative must be the user's CURRENT goal text (not in the
 * `turns`).
 */
export function detectShortAffirmativeContinuation(args: {
  goal: string;
  turns: Turn[] | undefined;
}): AffirmativeMatch {
  const { goal, turns } = args;
  if (!AFFIRMATIVE_REGEX.test(goal)) return { matched: false };
  if (!turns || turns.length === 0) return { matched: false };

  // Walk newest-to-oldest, looking for the most recent assistant promise.
  // Limit to the last 8 turns — older context is unlikely to be the referent.
  const window = turns.slice(-8);
  for (let i = window.length - 1; i >= 0; i--) {
    const turn = window[i];
    if (!turn || turn.role !== 'assistant') continue;
    const text = turnText(turn);
    if (!text) continue;
    if (COMPLETED_OUTPUT_HINTS.test(text)) {
      // Assistant already produced output in this turn — affirmative is not
      // a "do the proposed thing" but something else (continuation of a
      // delivered draft). Bail; let LLM handle it.
      return { matched: false };
    }
    const hasDeliverable = DELIVERABLE_NOUN_REGEX.test(text);
    const hasPromise = PROMISE_MARKER_REGEX.test(text);
    if (!hasDeliverable || !hasPromise) continue;

    // Found a promise. Look backwards for the immediately prior user turn —
    // that user request is the actual workflow we want to execute.
    const priorUser = window
      .slice(0, i)
      .reverse()
      .find((t) => t.role === 'user');
    const priorUserText = priorUser ? turnText(priorUser) : undefined;

    const reconstructedWorkflowPrompt = priorUserText
      ? `User has confirmed they want to proceed with the previously requested task. Original request: ${priorUserText.trim()}`
      : `User confirmed the assistant's prior proposal. Assistant promise transcript: ${text.trim()}`;

    return {
      matched: true,
      reconstructedWorkflowPrompt,
      reason: priorUserText
        ? `short affirmative "${goal.trim()}" confirms prior unfulfilled deliverable proposal at turn seq=${turn.seq}`
        : `short affirmative "${goal.trim()}" confirms prior assistant promise (no preceding user turn found)`,
      reconstructedFromTurnSeq: turn.seq,
    };
  }

  return { matched: false };
}
