/**
 * Turn Importance Classifier — pure, stateless, no LLM.
 *
 * Phase 1 (long-session memory): classifies conversation turns into importance
 * tiers so the session-manager compaction path can preserve decisive turns
 * verbatim and bias the token budget toward high-signal context.
 *
 * A3 compliance: rule-based regex + heuristics only. No network / LLM calls.
 *
 * Duck-typed over `{ role, content, toolsUsed?, thinking? }` so both
 * `ConversationEntry` (session-manager path) and `HistoryMessage`
 * (compressHistory path) can be classified with the same function.
 *
 * Signal-score model (threshold >= 2 for "decision", except the zero-regex
 * shortcut for clarification replies passed via hint flag):
 *   +1 imperative decision verb in first 120 chars (EN + TH)
 *   +1 negation + alternative ("not use X", "ไม่ใช่ X")
 *   +1 assistant plan preamble (`^(I'll|Going to|Plan:|Let me)`)
 *   +2 hint flag: user turn immediately after an [INPUT-REQUIRED] assistant
 *
 * `clarification` is set when content contains `[INPUT-REQUIRED]` or a
 * `needsUserInput…true` snippet (for HistoryMessage payloads).
 *
 * `tool_result` is set when the entry carries tool calls or thinking — those
 * turns are intrinsically informative context even if their text is terse.
 */

export type TurnImportance = 'decision' | 'clarification' | 'tool_result' | 'normal';

export interface ClassifiableTurn {
  role: string;
  content: string;
  toolsUsed?: string[];
  thinking?: string | null;
}

export interface ClassifyOptions {
  /**
   * Set true when the caller knows this user turn immediately follows an
   * assistant `[INPUT-REQUIRED]` block — the reply is a decision by
   * construction, no regex needed. Session-manager already pairs these
   * messages in `getConversationHistoryCompacted`, so it can forward the
   * hint at zero cost.
   */
  precededByInputRequired?: boolean;
}

// Imperative decision verbs. First-120-char scope prevents doc quotes that
// merely *mention* these words from flipping the signal.
// EN: "use", "let's use", "going with", "go with", "pick", "choose",
//     "switch to", "instead of", "scratch that", "actually",
//     "I'll go with".
// TH: "ใช้", "เอา", "เปลี่ยนเป็น", "ไปทาง", "เลือก".
const DECISION_VERB_EN =
  /\b(use|let's use|going with|go with|pick|choose|switch to|instead of|scratch that|actually|i'll go with)\b/i;
const DECISION_VERB_TH = /(ใช้|เอา|เปลี่ยนเป็น|ไปทาง|เลือก)/;

// Adversarial guard: "use case", "use cases", "in use", "end-user", "user" —
// substrings that can trip the /\buse\b/ match without actually being a
// decision. The guard is applied ONLY to the English verb "use" because
// Thai verbs have cleaner word boundaries.
const USE_CASE_GUARD = /\buse\s+case(s)?\b/i;

// Negation + alternative (EN + TH). Captures "not use X" / "ไม่ใช่ X แต่ใช้ Y".
//
// JS regex word boundaries (`\b`) only work around ASCII word characters;
// Thai characters aren't word characters, so wrapping the alternative in
// `\b` would reject TH matches (e.g. "not redis, ใช้ postgres"). We keep
// the left-side boundary to suppress partial-word matches like "cannot"
// (EN) but allow the right-hand verb to land anywhere (EN verbs still
// have their own guard in DECISION_VERB_EN).
const NEGATION_ALT = /\b(not|ไม่ใช่|ไม่เอา)\b.{0,30}(use|do|ใช้|เอา)/i;

// Assistant plan preamble. Only meaningful when role=assistant.
//
// `Plan:` ends in `:` (non-word) followed by whitespace (non-word) so a
// trailing `\b` would fail — allow either a word boundary OR the literal
// colon+whitespace to close the prefix match.
const ASSISTANT_PLAN = /^(I'll|Going to|Plan:|Let me)(\b|:|\s)/i;

// Clarification markers.
const INPUT_REQUIRED_TAG = /\[INPUT-REQUIRED\]/;
const NEEDS_USER_INPUT_JSON = /needsUserInput["\s:]{0,10}true/i;

// Doc-quote suppressor: a line beginning with `> ` or wrapped in a fenced
// code block is almost certainly quoting upstream material, not issuing a
// decision. We look only at the first 120 chars (same scope as the verb
// match) for the quote/code start so the guard fails fast.
const LEADING_QUOTE_OR_FENCE = /^(\s*>|\s*```)/;

/**
 * Classify a conversation turn by importance.
 *
 * Pure: same input always yields the same output. Zero side effects.
 */
export function classifyTurn(entry: ClassifiableTurn, options: ClassifyOptions = {}): TurnImportance {
  const content = entry.content ?? '';
  const role = entry.role;

  // `tool_result` has precedence over `clarification` / `decision` because a
  // turn that carries tool output or inner thinking is load-bearing regardless
  // of prose.
  const hasTools = Array.isArray(entry.toolsUsed) && entry.toolsUsed.length > 0;
  const hasThinking = typeof entry.thinking === 'string' && entry.thinking.length > 0;
  if (hasTools || hasThinking) {
    return 'tool_result';
  }

  // `clarification`: any [INPUT-REQUIRED] block or JSON needsUserInput flag.
  if (INPUT_REQUIRED_TAG.test(content) || NEEDS_USER_INPUT_JSON.test(content)) {
    return 'clarification';
  }

  // Zero-regex shortcut — user turn directly answering an IR block is a
  // decision by construction.
  if (options.precededByInputRequired && role === 'user') {
    return 'decision';
  }

  const head = content.slice(0, 120);

  // Suppress decision signals on quoted / fenced prose to avoid false positives
  // on documentation snippets and pasted commit bodies.
  if (LEADING_QUOTE_OR_FENCE.test(head)) {
    return 'normal';
  }

  let score = 0;

  // Imperative decision verb.
  const matchEn = head.match(DECISION_VERB_EN);
  if (matchEn) {
    // Guard against "use case" false positives — only suppresses when the EN
    // verb would have been the sole English signal.
    const isUseCase = /\buse\b/i.test(matchEn[0]) && USE_CASE_GUARD.test(head);
    if (!isUseCase) score += 1;
  }
  if (DECISION_VERB_TH.test(head)) score += 1;

  // Negation + alternative phrase.
  if (NEGATION_ALT.test(head)) score += 1;

  // Assistant-stated plan preamble — worth 2 points because a structural
  // "I'll / Plan: / Let me …" prefix reliably fronts a committed approach.
  if (role === 'assistant' && ASSISTANT_PLAN.test(head)) score += 2;

  if (score >= 2) return 'decision';

  return 'normal';
}
