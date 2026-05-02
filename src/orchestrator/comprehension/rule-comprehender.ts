/**
 * Rule-based ComprehensionEngine — deterministic stage 1 of the
 * conversation comprehension pipeline.
 *
 * Zero LLM calls. &lt;20ms typical. Always available, so the pipeline never
 * hard-fails on LLM outage. Output tier is `deterministic` when every
 * signal resolves unambiguously, else `heuristic` when signals suffice but
 * ambiguity remains, else `unknown` when input is structurally unusable.
 *
 * Deliberately NOT a classifier — this is a structured-state extractor.
 * Where a classifier would guess intent, this engine surfaces the
 * ambiguity as a flag (`hasAmbiguousReferents`) so the orchestrator can
 * either escalate to the LLM comprehender (P2) or treat the goal as
 * provisional.
 */

import type {
  ComprehendedTaskMessage,
  ComprehensionEngine,
  ComprehensionEvidence,
  ComprehensionInput,
  ComprehensionMemoryLanes,
  ComprehensionState,
} from './types.ts';
import { computeInputHash } from './types.ts';
import type { AutoMemory, AutoMemoryEntry } from '../../memory/auto-memory-loader.ts';
import type { Turn } from '../types.ts';

/** A7: flatten a Turn's visible text blocks for grounding/text comparison. */
function turnText(t: Turn): string {
  return t.blocks
    .filter((b): b is Extract<typeof b, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

/**
 * Short acknowledgement / anaphoric referent tokens — Thai + English.
 * When the user's full message is one of these (or a trivial variation),
 * the literal message cannot stand alone as a goal.
 */
const AMBIGUOUS_ACK_TOKENS = new Set([
  // English
  'ok',
  'okay',
  'yes',
  'y',
  'yep',
  'yeah',
  'sure',
  'no',
  'n',
  'nope',
  'do it',
  'go',
  'go ahead',
  'continue',
  'next',
  'done',
  'cancel',
  'stop',
  'undo',
  'that',
  'this',
  'it',
  // Thai (common short replies)
  'ใช่',
  'ไม่',
  'ครับ',
  'ค่ะ',
  'ได้',
  'ทำเลย',
  'ทำ',
  'ต่อ',
  'หยุด',
  'ยกเลิก',
  'ข้าม',
  'เอาเลย',
  'โอเค',
  'โอเคร',
  'เอาอันนั้น',
  'อันนั้น',
  'อันนี้',
]);

/** Pattern for referent phrases that imply a prior subject. */
const REFERENT_RE = /\b(?:it|that|this|those|them|ones?)\b|อัน(?:นั้น|นี้|ไหน)/i;

/**
 * Rough token count — word + CJK/Thai chars / 3. Used to decide
 * "short acknowledgement vs substantial goal".
 */
function roughTokenCount(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return Math.max(words, Math.ceil(text.length / 3));
}

/**
 * Detect whether a message contains ambiguous referents. Returns true when
 * the message is very short AND matches known ack tokens OR contains
 * bare-anaphoric referents without their antecedent in the message itself.
 */
function hasAmbiguousReferents(literalGoal: string): boolean {
  const normalized = literalGoal
    .trim()
    .toLowerCase()
    .replace(/[.!?,…]/g, '');
  if (!normalized) return true;
  if (AMBIGUOUS_ACK_TOKENS.has(normalized)) return true;
  const tokenCount = roughTokenCount(normalized);
  if (tokenCount <= 3 && REFERENT_RE.test(normalized)) return true;
  return false;
}

// ── goalReferenceMode classification (Phase 1: pre-rule false-activation fix)

/**
 * Quote pairs the classifier recognises — straight, curly, single, backtick,
 * CJK corner brackets. Mirrors the set used in intent/collaboration-parser.
 * A substantive (≥3 chars) quoted span is a near-perfect mention signal:
 * users almost never quote text they want executed.
 */
const REFERENCE_QUOTE_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['"', '"'],
  ['“', '”'],
  ["'", "'"],
  ['‘', '’'],
  ['`', '`'],
  ['「', '」'],
];

const SUBSTANTIVE_QUOTE_LEN = 3;

/**
 * True when the prompt contains any quoted span whose CONTENT is at least
 * `SUBSTANTIVE_QUOTE_LEN` characters. We do not check what is inside the
 * quotes — a substantive citation anywhere in the prompt is enough to flag
 * it as meta. Empty/single-character quotes (e.g., apostrophes inside
 * "don't") are ignored to avoid false positives.
 */
function hasSubstantiveQuotedSpan(text: string): boolean {
  for (const [open, close] of REFERENCE_QUOTE_PAIRS) {
    let i = 0;
    while (i < text.length) {
      const start = text.indexOf(open, i);
      if (start === -1) break;
      // For symmetric quotes (open === close) advance past the opener so
      // `indexOf(close, start + 1)` does not match the SAME character.
      const end = text.indexOf(close, start + 1);
      if (end === -1) break;
      if (end - start - 1 >= SUBSTANTIVE_QUOTE_LEN) return true;
      i = end + 1;
    }
  }
  return false;
}

/**
 * Example-framing vocabulary — phrases that ALWAYS reframe the following
 * content as an example/citation rather than work to perform. Mirrored from
 * intent/collaboration-parser.ts but generalised: not gated on a particular
 * downstream phrase. When this fires anywhere in the prompt it is a strong
 * meta signal (the user is illustrating something, not instructing it).
 */
const EXAMPLE_FRAMING_PATTERN_GLOBAL =
  /\b(?:for\s+example|e\.g\.|examples?\b|such\s+as|prompts?\s+like|prompts?\s+such\s+as|like\s+this)\b|เช่น|ตัวอย่าง(?:เช่น)?|ยกตัวอย่าง|prompt\s*แบบ|prompt\s*ลักษณะ|prompt\s*ที่/i;

/**
 * Meta-action vocabulary paired with system nouns — the user is asking
 * Vinyan to fix/design/review/discuss its OWN behaviour, not to perform an
 * action. Position-gated downstream (must appear BEFORE the first
 * execution verb).
 *
 * Curated tightly: bare verbs like "fix", "review" are NOT included — only
 * when paired with a system noun does the combination signal meta intent.
 * "fix the parser" → meta. "fix this bug in the worker" → meta. But "fix
 * my code" alone → not meta. Mirrors META_FRAMING_PATTERN but without the
 * downstream-phrase coupling.
 */
const META_VERB_PATTERN =
  /\b(?:implementation\s+(?:plan|strategy|details?)|fix\s+(?:the\s+)?(?:parser|routing|logic|classifier|intent|bug|decomposition|workflow|pipeline)|review\s+(?:the\s+)?(?:routing|logic|parser|implementation|classifier|decomposition|workflow|pipeline)|design\s+(?:the\s+)?(?:parser|routing|classifier|intent|workflow|pipeline)|debug\s+(?:the\s+)?(?:parser|routing|logic|classifier|intent|workflow|pipeline)|analy[sz]e\s+(?:the\s+)?(?:parser|routing|logic|classifier|intent|workflow|prompt)|why\s+does)\b|แก้\s*(?:logic|parser|routing|bug|classifier|intent|decomposition|workflow|pipeline|ปัญหา)|ออกแบบ\s*(?:parser|routing|classifier|intent|logic|workflow|pipeline)|ตรวจ(?:สอบ)?\s*(?:parser|routing|classifier|intent|logic|workflow|pipeline)|รองรับ\s*(?:prompt|กรณี|case)|เพราะอะไร|ทำไม\s*(?:prompt|task|วินยัน|vinyan|มัน|ระบบ|router|routing|classifier|parser|workflow)/i;

/**
 * Standalone system terminology — unaccompanied mentions of Vinyan-internal
 * components. Weaker than META_VERB_PATTERN: a prompt that names "parser"
 * without a verb might be discussion or might be a request. When this is
 * the only meta-leaning signal, the result is `'unknown'` rather than
 * `'meta'` — pre-rules then fire at REDUCED confidence and the LLM advisor
 * gets to weigh in via the merge layer.
 */
const SYSTEM_NOUN_PATTERN =
  /\b(?:parser|routing|decomposition|classifier|intent\s+(?:layer|resolver|classifier)|workflow\s+planner|collaboration[\s-]runner|collaboration[\s-]parser)\b/i;

/**
 * Execution-verb anchor — the *imperative* signal that the prompt is an
 * instruction to do something. Used POSITIONALLY: meta vocabulary BEFORE
 * the first execution verb is framing about the system; meta vocabulary
 * AFTER is part of the agents' / worker's task ("have 3 agents review the
 * parser code" → "review the parser" is the agents' assignment, not the
 * user's frame).
 *
 * Limited to high-precision authoring/delegation/instruction verbs so the
 * rule does NOT swallow conversational content. Bare nouns are excluded.
 */
const EXECUTION_VERB_PATTERN =
  /\b(?:have|let|spawn|split|use|make|run|execute|call|launch|start|write|draft|compose|author|create|generate|build|implement|add|do|deploy|publish)\s|\bsplit\s+(?:into|among|across)\b/i;

const EXECUTION_VERB_THAI_PATTERN =
  /แบ่ง|เขียน|แต่ง|ประพันธ์|ร่าง|สร้าง|ทำ(?!ไม)|รัน|เรียก|spawn/;

/**
 * Find the index of the first execution verb anchor (English or Thai), or
 * -1 when no execution verb is present. We pick the EARLIEST match across
 * patterns because the prompt's leading instruction is what determines
 * whether the user is performing or discussing.
 */
function findFirstExecutionVerb(text: string): number {
  const en = text.match(EXECUTION_VERB_PATTERN);
  const th = text.match(EXECUTION_VERB_THAI_PATTERN);
  const indices: number[] = [];
  if (en?.index !== undefined) indices.push(en.index);
  if (th?.index !== undefined) indices.push(th.index);
  return indices.length > 0 ? Math.min(...indices) : -1;
}

/** Find the index of the first META_VERB_PATTERN match, or -1. */
function findFirstMetaPattern(text: string): number {
  const m = text.match(META_VERB_PATTERN);
  return m?.index ?? -1;
}

/** Find the index of the first SYSTEM_NOUN_PATTERN match, or -1. */
function findFirstSystemNoun(text: string): number {
  const m = text.match(SYSTEM_NOUN_PATTERN);
  return m?.index ?? -1;
}

/**
 * Classify the user's goal as `'direct'` (instruction to execute), `'meta'`
 * (discussion / quotation / framing of system behaviour), or `'unknown'`
 * (mixed signals). Pure, deterministic, language-aware (Thai + English).
 *
 * Decision order (most reliable signals first):
 *   1. empty                                                → 'unknown'
 *   2. substantive quoted span anywhere                    → 'meta'
 *   3. example-framing vocabulary anywhere                 → 'meta'
 *   4. meta-verb+system-noun pattern BEFORE first exec verb → 'meta'
 *   5. standalone system-noun BEFORE first exec verb       → 'unknown'
 *      (suggestive but inconclusive — pre-rules demote confidence)
 *   6. otherwise                                           → 'direct'
 *
 * Pure, A3-safe: relies only on regex and string positions. Deterministic
 * given the same input. The downstream comprehension oracle treats this
 * field as advisory metadata (no extra verification needed beyond the
 * normal envelope checks).
 */
function classifyGoalReferenceMode(literalGoal: string): 'direct' | 'meta' | 'unknown' {
  const text = literalGoal.trim();
  if (text.length === 0) return 'unknown';

  if (hasSubstantiveQuotedSpan(text)) return 'meta';
  if (EXAMPLE_FRAMING_PATTERN_GLOBAL.test(text)) return 'meta';

  const execIdx = findFirstExecutionVerb(text);
  const metaIdx = findFirstMetaPattern(text);
  if (metaIdx >= 0 && (execIdx < 0 || metaIdx < execIdx)) return 'meta';

  const systemIdx = findFirstSystemNoun(text);
  if (systemIdx >= 0 && (execIdx < 0 || systemIdx < execIdx)) return 'unknown';

  return 'direct';
}

/**
 * Exposed for the LLM comprehender (which copies the rule output into its
 * own envelope so the merger never has to default the field) and for tests
 * that want to assert the classifier directly without constructing a full
 * comprehension input.
 */
export { classifyGoalReferenceMode };

/**
 * Build a 1-2 sentence summary of what the conversation was about,
 * using rule-based extraction over the last few turns.
 */
function summarizePriorContext(history: ComprehensionInput['history'], rootGoal: string | null): string {
  if (history.length === 0) return 'New conversation — no prior context.';

  const parts: string[] = [];
  if (rootGoal && rootGoal.trim().length > 0) {
    const clipped = rootGoal.length > 120 ? `${rootGoal.slice(0, 117)}...` : rootGoal;
    parts.push(`Root task: "${clipped}"`);
  }
  // Count turns we've had.
  const turns = history.filter((h) => h.role === 'user' || h.role === 'assistant').length;
  if (turns > 0) parts.push(`${turns} prior turn${turns === 1 ? '' : 's'}`);

  // Surface the most recent assistant turn (clarification questions, last
  // answer, etc.) without leaking the raw INPUT-REQUIRED marker.
  const lastAssistant = [...history].reverse().find((h) => h.role === 'assistant');
  if (lastAssistant) {
    const clean = turnText(lastAssistant).replace(/\[INPUT-REQUIRED\][\s\S]*$/, '').trim();
    if (clean.length > 0) {
      const clipped = clean.length > 160 ? `${clean.slice(0, 157)}...` : clean;
      parts.push(`Last response started with: "${clipped}"`);
    } else {
      // The assistant was purely an [INPUT-REQUIRED] turn.
      parts.push('Last assistant turn requested clarification.');
    }
  }

  return parts.join('. ');
}

/**
 * Resolve the working goal for this turn — the text the downstream pipeline
 * should treat as the primary target. For clarification answers, this is
 * the root goal (preserves the original intent). For fresh messages, it's
 * the literal input. Rule-based only; LLM stage may refine later.
 */
function resolveWorkingGoal(
  literalGoal: string,
  rootGoal: string | null,
  state: { isClarificationAnswer: boolean },
): string {
  if (state.isClarificationAnswer && rootGoal && rootGoal.trim().length > 0) {
    return rootGoal;
  }
  return literalGoal;
}

// ── AutoMemory relevance scoring ────────────────────────────────────────

/** Max AutoMemory entries surfaced per turn — keeps prompt lean. */
const MAX_MEMORY_HITS = 5;

/** Extract lowercase alphanum/CJK tokens of length ≥ 3. */
function tokenize(text: string): Set<string> {
  const out = new Set<string>();
  // Match word-ish tokens (letters, digits, CJK/Thai) ≥ 3 chars.
  // Simpler than a full NLP tokenizer; adequate for overlap-based relevance.
  for (const m of text.toLowerCase().matchAll(/[\p{L}\p{N}]{3,}/gu)) {
    out.add(m[0]);
  }
  return out;
}

/** Cap for entries that qualify ONLY via the user-identity floor. */
const MAX_USER_FLOOR_ENTRIES = 1;

/**
 * Score a memory entry's relevance to the current turn by token overlap.
 * Returns `{ score, floorOnly }` — `floorOnly` flags entries that only
 * qualified because of the user-identity floor (zero overlap but
 * type='user'). Callers cap floor-only entries tightly to mitigate the
 * "name-a-file `user_X.md` to guarantee inclusion" attack surface.
 *
 * Red Team #8 (semantic poisoning): entries carrying a `strong` linter
 * warning get their score DROPPED to 0, removing them from the final
 * selection entirely. Soft warnings survive but score at most half —
 * the orchestrator can still surface legitimate "always respect line
 * length" preferences while quarantining "always skip verification"
 * overrides.
 */
function scoreEntry(
  entry: AutoMemoryEntry,
  turnTokens: Set<string>,
): { score: number; floorOnly: boolean } {
  // Hard drop for strong-warning entries (agent override attempts).
  if (entry.hasStrongWarning) return { score: 0, floorOnly: false };

  const entryTokens = tokenize(`${entry.description}\n${entry.content}`);
  let overlap = 0;
  for (const t of entryTokens) {
    if (turnTokens.has(t)) overlap++;
  }
  // Soft-warning entries: halve the overlap score so a benign
  // "must use the logger" preference can still surface when directly
  // relevant, but doesn't crowd out clean entries.
  const penalty = entry.linterWarnings.length > 0 ? 0.5 : 1;
  if (overlap > 0) return { score: overlap * penalty, floorOnly: false };
  if (entry.type === 'user') return { score: 1 * penalty, floorOnly: true }; // user identity floor
  return { score: 0, floorOnly: false };
}

/**
 * Build the memoryLaneRelevance payload from loaded AutoMemory. Ranks by
 * token overlap, keeps top N, tags every surviving entry as probabilistic.
 * Enforces a tight cap on floor-only entries so a single `user_*.md` file
 * can surface by identity, but a malicious pile of them cannot crowd out
 * substance-matched entries.
 */
function buildMemoryLaneRelevance(
  autoMemory: AutoMemory | null | undefined,
  turnText: string,
): ComprehensionMemoryLanes {
  if (!autoMemory || autoMemory.entries.length === 0) return {};
  const turnTokens = tokenize(turnText);
  const scored = autoMemory.entries
    .map((e) => ({ entry: e, ...scoreEntry(e, turnTokens) }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);

  // Two-stage selection: take real-overlap hits first, then up to the
  // floor cap of user-identity-only entries. Total capped at MAX_MEMORY_HITS.
  const final: typeof scored = [];
  let floorCount = 0;
  for (const s of scored) {
    if (final.length >= MAX_MEMORY_HITS) break;
    if (s.floorOnly) {
      if (floorCount >= MAX_USER_FLOOR_ENTRIES) continue;
      floorCount++;
    }
    final.push(s);
  }
  if (final.length === 0) return {};
  return {
    autoMem: final.map((s) => ({
      ref: s.entry.ref,
      trustTier: 'probabilistic' as const,
    })),
  };
}

/**
 * The rule-based ComprehensionEngine implementation. Exported primarily
 * through a factory (newRuleComprehender) so tests can pass alternative
 * clocks; the class itself is kept internal to encourage the factory path.
 */
class RuleComprehender implements ComprehensionEngine {
  readonly id = 'rule-comprehender';
  readonly engineType = 'rule' as const;
  readonly capabilities = ['comprehend.conversation', 'comprehend.deterministic'] as const;
  readonly tier = 'deterministic' as const;

  constructor(private readonly now: () => number = Date.now) {}

  async comprehend(input: ComprehensionInput): Promise<ComprehendedTaskMessage> {
    const literalGoal = input.input.goal ?? '';

    // ── Evidence chain (A5) — every claim the engine makes gets a bullet.
    const evidence: ComprehensionEvidence[] = [];

    // 1. Is this a clarification answer? (Deterministic: pendingQuestions non-empty.)
    const isClarificationAnswer = input.pendingQuestions.length > 0;
    if (isClarificationAnswer) {
      evidence.push({
        source: 'rule:clarification-detector',
        claim: `User message is an answer to ${input.pendingQuestions.length} pending clarification question(s)`,
        confidence: 1,
      });
    }

    // 2. New-topic detection: no prior user turn at all.
    const priorUserTurns = input.history.filter((h) => h.role === 'user').length;
    const literalAlreadyRecorded = input.history.some((h) => h.role === 'user' && turnText(h) === literalGoal);
    const priorExcludingCurrent = literalAlreadyRecorded ? priorUserTurns - 1 : priorUserTurns;
    const isNewTopic = priorExcludingCurrent <= 0;
    evidence.push({
      source: 'rule:session-history',
      claim: `Prior user turns (excluding current): ${priorExcludingCurrent}`,
      confidence: 1,
    });

    // 3. Follow-up classification: any non-new-topic message is a follow-up.
    const ambiguous = hasAmbiguousReferents(literalGoal);
    const isFollowUp = !isNewTopic || isClarificationAnswer;
    if (ambiguous) {
      evidence.push({
        source: 'rule:referent-resolver',
        claim: `Literal message "${literalGoal.slice(0, 40)}${literalGoal.length > 40 ? '...' : ''}" has ambiguous/anaphoric content`,
        confidence: 0.9,
      });
    }

    const goalReferenceMode = classifyGoalReferenceMode(literalGoal);
    if (goalReferenceMode !== 'direct') {
      evidence.push({
        source: 'rule:goal-reference-mode',
        claim: `Surface structure indicates goalReferenceMode='${goalReferenceMode}'`,
        confidence: goalReferenceMode === 'meta' ? 0.9 : 0.6,
      });
    }

    const state: ComprehensionState = {
      isNewTopic,
      isClarificationAnswer,
      isFollowUp,
      hasAmbiguousReferents: ambiguous,
      pendingQuestions: [...input.pendingQuestions],
      rootGoal: input.rootGoal,
      goalReferenceMode,
    };

    // 4. Working goal (resolve referents when possible via root-goal anchoring).
    const resolvedGoal = resolveWorkingGoal(literalGoal, input.rootGoal, state);
    if (resolvedGoal !== literalGoal) {
      evidence.push({
        source: 'rule:goal-anchor',
        claim: 'Resolved goal = rootGoal (clarification answer preserves original task)',
        confidence: 1,
      });
    } else {
      evidence.push({
        source: 'rule:goal-anchor',
        claim: 'Resolved goal = literal message (no clarification chain to anchor)',
        confidence: 1,
      });
    }

    const priorContextSummary = summarizePriorContext(input.history, input.rootGoal);

    // ── Tier decision (A5) — everything checked is rule-based, so deterministic
    // unless the literal message itself is ambiguous and we cannot resolve via
    // root-goal anchoring. In that case: heuristic (we have a best guess).
    let tier: 'deterministic' | 'heuristic' | 'probabilistic' | 'unknown' = 'deterministic';
    let confidence = 1;
    let resultType: 'comprehension' | 'unknown' = 'comprehension';
    if (ambiguous && resolvedGoal === literalGoal) {
      // Cannot anchor to root; downstream should treat as provisional.
      tier = 'heuristic';
      confidence = 0.6;
    }
    // If the literal message is empty, we cannot produce useful comprehension.
    if (literalGoal.trim().length === 0) {
      tier = 'unknown';
      confidence = 0;
      resultType = 'unknown';
      evidence.push({
        source: 'rule:empty-goal',
        claim: 'Literal message is empty — comprehension unavailable',
        confidence: 1,
      });
    }

    const inputHash = await computeInputHash(input);
    const asOf = this.now();

    if (resultType === 'unknown') {
      return {
        jsonrpc: '2.0',
        method: 'comprehension.result',
        params: {
          type: 'unknown',
          confidence,
          tier,
          evidence_chain: evidence,
          falsifiable_by: ['user-next-turn'],
          temporal_context: { as_of: asOf },
          inputHash,
          rootGoal: input.rootGoal,
        },
      };
    }

    return {
      jsonrpc: '2.0',
      method: 'comprehension.result',
      params: {
        type: 'comprehension',
        confidence,
        tier,
        evidence_chain: evidence,
        // These are the events that would prove the comprehension wrong.
        // Downstream learning (A7) checks these at trace record time.
        falsifiable_by: ['user-corrects-resolved-goal-in-next-turn', 'workflow-rejects-goal-at-verify'],
        temporal_context: {
          as_of: asOf,
          // Comprehension is valid until the session grows another user
          // turn — bounded implicitly by inputHash but we surface a
          // conservative 5 min ceiling for telemetry.
          valid_until: asOf + 5 * 60 * 1000,
        },
        inputHash,
        rootGoal: input.rootGoal,
        data: {
          literalGoal,
          resolvedGoal,
          state,
          priorContextSummary,
          // P1: AutoMemory relevance matching by token overlap.
          // Empty when no autoMemory loaded or no entries match the turn.
          memoryLaneRelevance: buildMemoryLaneRelevance(
            input.autoMemory,
            // Score against the working goal + last 3 conversation turns
            // (recency-weighted; older turns carry less signal).
            `${resolvedGoal}\n${literalGoal}\n${input.history
              .slice(-3)
              .map((h) => turnText(h))
              .join('\n')}`,
          ),
        },
      },
    };
  }
}

/** Factory — preferred constructor for the rule-based comprehender. */
export function newRuleComprehender(now: () => number = Date.now): ComprehensionEngine {
  return new RuleComprehender(now);
}
