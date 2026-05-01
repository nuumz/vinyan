/**
 * CollaborationDirective parser — Phase 1 of the multi-agent debate fix.
 *
 * Pure, deterministic extraction of the structural shape of a multi-agent
 * collaboration prompt: how many primary participants the user asked for,
 * what interaction shape (parallel-answer / debate / competition / comparison),
 * how many rebuttal rounds, whether oversight was explicitly requested, and
 * whether participants may bubble up clarification to the manager.
 *
 * Why this lives in the intent layer (pre-LLM):
 *   - The user's two example prompts —
 *       "แบ่ง Agent 3ตัว แข่งกันถามตอบ"
 *       "แบ่ง Agent 3ตัว แข่งกันถามตอบ และเพิ่มกระบวนการโต้แย้งกันเองได้อีก 2รอบ"
 *     carry the count + rounds + interaction shape as structural signals in
 *     the prompt text itself. They do NOT need an LLM to decode.
 *   - The codebase forbids semantic post-filtering of LLM planner output.
 *     Pre-LLM extraction is allowed; rewriting a valid plan after the LLM
 *     emitted it is not.
 *   - The downstream Room dispatcher (text-answer mode, Phase 2/3) needs
 *     persistent participant identity across rounds. Without a deterministic
 *     directive, the LLM planner reduces this to flat delegate-sub-agent
 *     steps + synthesis, which loses both the round shape and the same-
 *     participant-talks-again semantics.
 *
 * Strict gate: the parser ONLY returns a directive when
 * `matchesMultiAgentDelegation(goal)` already fires AND a count is
 * extractable. Bare mentions ("an agent helped me") and singular references
 * ("what is an agent") return `null`.
 */
import { matchesMultiAgentDelegation } from './strategy.ts';

/**
 * Hard upper bounds. Both clamp absurd inputs ("100 รอบ") rather than
 * reject them — the user's intent is preserved, just bounded so a prompt
 * cannot blow the parent task's budget.
 */
const MAX_REBUTTAL_ROUNDS = 5;
const MAX_PARTICIPANT_COUNT = 6;
/**
 * Default count when the user said "หลาย"/"multiple"/"several" without a
 * number. 3 matches the smallest meaningful multi-perspective set and the
 * existing brainstorm-room defaults.
 */
const DEFAULT_AMBIGUOUS_COUNT = 3;

const THAI_NUMBER_WORDS: Record<string, number> = {
  สอง: 2,
  สาม: 3,
  สี่: 4,
  ห้า: 5,
  หก: 6,
};

const ENGLISH_NUMBER_WORDS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
};

const MULTIPLE_WORDS = ['หลาย', 'multiple', 'several', 'many'] as const;

/**
 * The structural shape of a multi-agent collaboration request. Attached to
 * `IntentResolution.collaboration` when the parser fires.
 *
 * Field semantics are deliberately orthogonal so a prompt that asks for
 * "compete + debate 2 rounds" can express both: `interactionMode='debate'`
 * carries the conversation shape and `emitCompetitionVerdict=true` carries
 * the verdict shape independently.
 */
export interface CollaborationDirective {
  /**
   * Number of primary participants the user explicitly asked for. The
   * reviewer/oversight role is NEVER counted here, regardless of
   * `reviewerPolicy`. Clamped to `[1, MAX_PARTICIPANT_COUNT]`.
   */
  requestedPrimaryParticipantCount: number;
  /**
   * What the participants are doing as a conversation shape:
   *   - `parallel-answer` — independent answers, no shared context.
   *   - `competition`     — head-to-head, integrator picks a winner.
   *   - `debate`          — multi-round rebuttal with shared transcript.
   *   - `comparison`      — side-by-side analysis without rebuttal.
   *
   * Precedence when multiple signals fire:
   *   debate > competition > comparison > parallel-answer
   *
   * Rationale: rebuttal rounds change the runtime behaviour (shared
   * transcript across rounds) more than verdict shape does. The verdict
   * shape is preserved orthogonally via `emitCompetitionVerdict`.
   */
  interactionMode: 'parallel-answer' | 'competition' | 'debate' | 'comparison';
  /**
   * Additional rounds AFTER the initial round in which the same participants
   * rebut/refine. 0 = single round only. Total rounds = 1 + rebuttalRounds.
   * Clamped to `[0, MAX_REBUTTAL_ROUNDS]`.
   */
  rebuttalRounds: number;
  /**
   * Always true when `rebuttalRounds > 0`. Drives whether the room
   * dispatcher injects shared discussion context on rebuttal turns.
   */
  sharedDiscussion: boolean;
  /**
   * Whether the user named a reviewer/moderator role explicitly:
   *   - `none`      — no oversight requested; preset adds none.
   *   - `optional`  — reserved (reviewer may be added if available without
   *                   inflating count). Not currently emitted by the parser.
   *   - `explicit`  — preset MUST add exactly one oversight role outside
   *                   the primary count.
   */
  reviewerPolicy: 'none' | 'optional' | 'explicit';
  /**
   * Whether participants may emit `needsUserInput` to the orchestrator
   * mid-conversation. Defaults `true`; `false` only when the user explicitly
   * said "no clarification" / "ห้ามถาม".
   */
  managerClarificationAllowed: boolean;
  /**
   * Orthogonal verdict flag. True when the user's prompt carries a
   * competition/winner/rank signal — even if `interactionMode='debate'`
   * (e.g. "compete + debate 2 rounds" wants both rebuttal and a winner).
   * The collaboration runner reads this to decide whether to invoke
   * `processCompetitionVerdict` on the integrator's output.
   */
  emitCompetitionVerdict: boolean;
  /** Provenance — fixed since the parser is the only emitter. */
  source: 'pre-llm-parser';
  /**
   * Raw matched fragments for replay/debug. Useful when the directive
   * looks wrong on a trace and an operator wants to know which substring
   * the parser anchored on.
   */
  matchedFragments: {
    count: string;
    rounds?: string;
    reviewer?: string;
  };
}

/**
 * Pull the participant count out of the goal text. Returns `null` when no
 * recognisable count anchor is present — the caller treats `null` as "not a
 * collaboration directive after all".
 */
function extractCount(text: string): { count: number; matched: string } | null {
  // Pattern A: digit immediately followed by ตัว / agents / คน. Matches
  //   "3ตัว", "3 agents", "3 คน", "Agent 3 ตัว".
  const digitFirst = text.match(/(\d+)\s*(?:ตัว|agents?|คน)/i);
  if (digitFirst?.[1]) {
    const raw = parseInt(digitFirst[1], 10);
    if (raw >= 1) {
      return { count: Math.min(raw, MAX_PARTICIPANT_COUNT), matched: digitFirst[0] };
    }
  }

  // Pattern B: agents+digit (English-style "agents 3" — uncommon but seen).
  const agentDigit = text.match(/agents?\s+(\d+)/i);
  if (agentDigit?.[1]) {
    const raw = parseInt(agentDigit[1], 10);
    if (raw >= 1) {
      return { count: Math.min(raw, MAX_PARTICIPANT_COUNT), matched: agentDigit[0] };
    }
  }

  // Pattern C: Thai number word + (optional space) + ตัว/agent. Matches
  //   "สามตัว", "สาม agents".
  for (const [word, n] of Object.entries(THAI_NUMBER_WORDS)) {
    const re = new RegExp(`${word}\\s*(?:ตัว|agents?|คน)`, 'i');
    const m = text.match(re);
    if (m) return { count: Math.min(n, MAX_PARTICIPANT_COUNT), matched: m[0] };
  }

  // Pattern D: English number word + agents. Matches "three agents".
  for (const [word, n] of Object.entries(ENGLISH_NUMBER_WORDS)) {
    const re = new RegExp(`\\b${word}\\s+agents?\\b`, 'i');
    const m = text.match(re);
    if (m) return { count: Math.min(n, MAX_PARTICIPANT_COUNT), matched: m[0] };
  }

  // Pattern E: "หลาย" / "multiple" / "several" / "many" → DEFAULT_AMBIGUOUS_COUNT.
  for (const word of MULTIPLE_WORDS) {
    const re = new RegExp(`${word}\\s*agents?`, 'i');
    const m = text.match(re);
    if (m) return { count: DEFAULT_AMBIGUOUS_COUNT, matched: m[0] };
  }

  return null;
}

/**
 * Pull the rebuttal-round count out of the goal text. Returns `null` when
 * no round anchor is present — caller defaults to 0.
 */
function extractRounds(text: string): { rounds: number; matched: string } | null {
  // Thai: digit + (optional space) + รอบ. Matches "2รอบ", "2 รอบ", "อีก 2 รอบ".
  const thaiDigit = text.match(/(\d+)\s*รอบ/);
  if (thaiDigit?.[1]) {
    const raw = parseInt(thaiDigit[1], 10);
    return { rounds: Math.min(Math.max(raw, 0), MAX_REBUTTAL_ROUNDS), matched: thaiDigit[0] };
  }

  // Thai number word + รอบ.
  for (const [word, n] of Object.entries(THAI_NUMBER_WORDS)) {
    const re = new RegExp(`${word}\\s*รอบ`);
    const m = text.match(re);
    if (m) return { rounds: Math.min(n, MAX_REBUTTAL_ROUNDS), matched: m[0] };
  }

  // English: digit + (optional "rebuttal "/"additional ") + rounds/times/iterations.
  const englishMatch = text.match(/(\d+)\s+(?:rebuttal\s+|additional\s+|more\s+)?(?:rounds?|times|iterations?)\b/i);
  if (englishMatch?.[1]) {
    const raw = parseInt(englishMatch[1], 10);
    return { rounds: Math.min(Math.max(raw, 0), MAX_REBUTTAL_ROUNDS), matched: englishMatch[0] };
  }

  // English: "debate N times".
  const debateNTimes = text.match(/debate\s+(\d+)\s*times?/i);
  if (debateNTimes?.[1]) {
    const raw = parseInt(debateNTimes[1], 10);
    return { rounds: Math.min(Math.max(raw, 0), MAX_REBUTTAL_ROUNDS), matched: debateNTimes[0] };
  }

  return null;
}

const COMPETITION_PATTERN = /แข่ง|ประชัน|ผู้ชนะ|ชนะ|\b(?:compete|competition|winner|best.of|vote|rank|ranking)\b/i;
const DEBATE_PATTERN = /โต้แย้ง|โต้กัน|ดีเบต|รบกัน|\b(?:debate|argue|rebut|rebuttal|challenge|critique\s+each\s+other)\b/i;
const COMPARISON_PATTERN = /เปรียบเทียบ|\b(?:compare|comparison|side.by.side)\b/i;
const REVIEWER_PATTERN = /reviewer|moderator|judge|ผู้ตรวจ|คนตรวจ|กรรมการ/i;
const NO_CLARIFICATION_PATTERN = /no\s+clarification|don'?t\s+ask|ห้ามถาม|อย่าถาม|ไม่ต้องถาม/i;

/**
 * Extract a `CollaborationDirective` from a free-form goal. Returns `null`
 * when the goal does not structurally describe a multi-agent collaboration
 * (no quantifier+verb anchor, or no extractable count).
 *
 * Pure: no I/O, no LLM, no module state.
 */
export function parseCollaborationDirective(goal: string): CollaborationDirective | null {
  if (!matchesMultiAgentDelegation(goal)) return null;

  const countResult = extractCount(goal);
  if (!countResult) return null;

  const roundsResult = extractRounds(goal);
  const rebuttalRounds = roundsResult?.rounds ?? 0;

  const hasCompetition = COMPETITION_PATTERN.test(goal);
  const hasDebateSignal = DEBATE_PATTERN.test(goal);
  const hasComparison = COMPARISON_PATTERN.test(goal);
  const hasReviewer = REVIEWER_PATTERN.test(goal);
  const noClarification = NO_CLARIFICATION_PATTERN.test(goal);

  // Mode precedence: an explicit debate verb OR rebuttal rounds present
  // dominate, because they reshape the runtime conversation (shared
  // transcript across rounds). Competition/comparison are verdict-shape
  // signals; competition specifically is preserved orthogonally via
  // `emitCompetitionVerdict` so a "compete + debate 2 รอบ" prompt yields
  // mode='debate' AND emitCompetitionVerdict=true.
  const isDebate = hasDebateSignal || rebuttalRounds > 0;
  let interactionMode: CollaborationDirective['interactionMode'];
  if (isDebate) {
    interactionMode = 'debate';
  } else if (hasCompetition) {
    interactionMode = 'competition';
  } else if (hasComparison) {
    interactionMode = 'comparison';
  } else {
    interactionMode = 'parallel-answer';
  }

  const matchedFragments: CollaborationDirective['matchedFragments'] = {
    count: countResult.matched,
  };
  if (roundsResult) matchedFragments.rounds = roundsResult.matched;
  if (hasReviewer) {
    const reviewerMatch = goal.match(REVIEWER_PATTERN);
    if (reviewerMatch) matchedFragments.reviewer = reviewerMatch[0];
  }

  return {
    requestedPrimaryParticipantCount: countResult.count,
    interactionMode,
    rebuttalRounds,
    sharedDiscussion: rebuttalRounds > 0,
    reviewerPolicy: hasReviewer ? 'explicit' : 'none',
    managerClarificationAllowed: !noClarification,
    emitCompetitionVerdict: hasCompetition,
    source: 'pre-llm-parser',
    matchedFragments,
  };
}

/** Exposed for test assertions and downstream guard rails. */
export const COLLABORATION_PARSER_LIMITS = {
  MAX_REBUTTAL_ROUNDS,
  MAX_PARTICIPANT_COUNT,
  DEFAULT_AMBIGUOUS_COUNT,
} as const;
