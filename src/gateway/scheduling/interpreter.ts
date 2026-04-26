/**
 * W3 H3 — natural-language scheduling interpreter.
 *
 * Given the raw user text, an origin envelope, and a profile, this module:
 *   1. Extracts a CRON + timezone via `parseCron()`.
 *   2. Strips the time spec and uses the remainder as the task goal.
 *   3. Consults the caller-injected goal-alignment oracle to verify the
 *      derived goal is what the user actually wants.
 *   4. Builds a `ScheduledHypothesisTuple` skeleton (minus the fields the
 *      store generates: `id`, `createdAt`, `evidenceHash`, `nextFireAt`,
 *      `runHistory`, `status`, `failureStreak`).
 *
 * The interpreter is intentionally I/O-free (other than the injected
 * oracle). A3: the rule-based parser owns the decision; the oracle is
 * advisory and may veto low-confidence matches. A2: a failed oracle
 * returns `ok: false` — the caller surfaces a clarification, not a
 * hallucinated schedule.
 */

import { parseCron } from './cron-parser.ts';
import type { ScheduledHypothesisTuple } from './types.ts';

export interface InterpreterDeps {
  readonly goalAlignmentOracle: (req: {
    goal: string;
    nlOriginal: string;
  }) => Promise<{ confidence: number; aligned: boolean }>;
  readonly defaultTimezone: string;
  readonly clock?: () => number;
}

/** Fields the interpreter resolves; everything else is set by the store/runner. */
export type InterpretedTupleDraft = Omit<
  ScheduledHypothesisTuple,
  'id' | 'createdAt' | 'evidenceHash' | 'nextFireAt' | 'runHistory' | 'status' | 'failureStreak'
>;

export interface InterpretResult {
  readonly ok: true;
  readonly tuple: InterpretedTupleDraft;
}

export interface InterpretFailure {
  readonly ok: false;
  readonly reason: 'cron-parse-failed' | 'goal-alignment-failed' | 'too-ambiguous';
  readonly detail: string;
}

const MIN_GOAL_WORDS = 3;
const MIN_ALIGNMENT_CONFIDENCE = 0.5;

export async function interpretSchedule(
  nl: string,
  origin: ScheduledHypothesisTuple['origin'],
  profile: string,
  deps: InterpreterDeps,
): Promise<InterpretResult | InterpretFailure> {
  const trimmed = nl.trim();
  if (!trimmed) {
    return { ok: false, reason: 'too-ambiguous', detail: 'empty input' };
  }

  const parsed = parseCron(trimmed, { defaultTimezone: deps.defaultTimezone });
  if (!parsed.ok) {
    return { ok: false, reason: 'cron-parse-failed', detail: parsed.detail };
  }

  const goal = deriveGoal(trimmed);
  if (wordCount(goal) < MIN_GOAL_WORDS) {
    return {
      ok: false,
      reason: 'too-ambiguous',
      detail: `goal "${goal}" is too short (needs ≥${MIN_GOAL_WORDS} words)`,
    };
  }

  const oracle = await deps.goalAlignmentOracle({ goal, nlOriginal: trimmed });
  if (!oracle.aligned || oracle.confidence < MIN_ALIGNMENT_CONFIDENCE) {
    return {
      ok: false,
      reason: 'goal-alignment-failed',
      detail: `oracle aligned=${oracle.aligned} confidence=${oracle.confidence.toFixed(2)}`,
    };
  }

  const tuple: InterpretedTupleDraft = {
    profile,
    createdByHermesUserId: null,
    origin,
    cron: parsed.cron,
    timezone: parsed.timezone,
    nlOriginal: trimmed,
    goal,
    constraints: {},
    confidenceAtCreation: clamp(oracle.confidence, 0, 1),
  };
  return { ok: true, tuple };
}

/**
 * Strip scheduling clauses from the input to isolate the task goal.
 * The grammar mirrors `cron-parser.ts` but is forgiving — we only need a
 * reasonable best-effort extraction; the oracle is what decides if it's
 * good enough.
 */
export function deriveGoal(nl: string): string {
  let text = nl;
  // Remove trailing `in <tz>` clause, if any.
  text = text.replace(/\bin\s+[A-Za-z_][A-Za-z0-9_+\-/]+\s*$/i, '');
  // Strip the leading scheduling clause (any chunk that starts the sentence).
  text = text.replace(
    /^\s*(?:every\s+\d+\s*(?:minutes?|mins?|m)|every\s+hour|every\s+(?:weekday|weekend)|every\s+(?:sunday|sun|monday|mon|tuesday|tues|tue|wednesday|wed|thursday|thurs|thur|thu|friday|fri|saturday|sat)s?|daily|everyday|every\s+day)\b/i,
    '',
  );
  // Strip time-of-day clauses wherever they appear.
  text = text.replace(/\bat\s+(?:[01]?\d|2[0-3]):[0-5]\d\b/gi, '');
  text = text.replace(/\bat\s+(?:1[0-2]|0?[1-9])(?::[0-5]\d)?\s*(?:am|pm)\b/gi, '');
  // Strip "on weekday/weekend/day" clauses (after time extraction).
  text = text.replace(/\bon\s+(?:weekdays?|weekends?)\b/gi, '');
  text = text.replace(
    /\bon\s+(?:sunday|sun|monday|mon|tuesday|tues|tue|wednesday|wed|thursday|thurs|thur|thu|friday|fri|saturday|sat)s?\b/gi,
    '',
  );
  // Strip leading connectors left behind: "please", "then", punctuation.
  text = text.replace(/^\s*[:,;\-–—]+\s*/g, '');
  return text.replace(/\s+/g, ' ').trim();
}

function wordCount(s: string): number {
  return s.split(/\s+/).filter(Boolean).length;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}
