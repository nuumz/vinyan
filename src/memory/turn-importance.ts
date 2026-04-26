/**
 * Turn-aware importance classifier — pure, stateless, no LLM.
 *
 * Companion to `src/api/turn-importance.ts` (feature/main's Phase 1
 * classifier) that consumes the Anthropic-native `Turn` shape
 * (ContentBlock[]) instead of the flat ConversationEntry-like duck-type.
 *
 * Responsibilities:
 *   - Flatten a turn's blocks to a single visible-text string
 *   - Derive `hasTools` / `hasThinking` from block types
 *   - Apply the same score-based heuristic (regex patterns ported
 *     WHOLESALE from feature/main to preserve the Thai word-boundary
 *     workaround, the "use case" false-positive guard, and the
 *     0–30-char negation scope — all non-obvious)
 *
 * A3 compliance: rule-based regex + heuristics only. No network, no LLM.
 *
 * Used by `src/memory/summary-ladder.ts` to emit inline KEY-DECISION
 * lines when summarizing turns that fall outside the retriever's
 * recent / semantic / pins bundle.
 */

import type { ContentBlock, Turn } from '../orchestrator/types.ts';

export type TurnImportance = 'decision' | 'clarification' | 'tool_result' | 'normal';

export interface ClassifyOptions {
  /**
   * Set true when the caller knows this user turn immediately follows an
   * assistant `[INPUT-REQUIRED]` block — the reply is a decision by
   * construction, no regex needed. The summary-ladder walk tracks this
   * state and forwards it at zero cost.
   */
  precededByInputRequired?: boolean;
}

// ── Regex library (ported wholesale from src/api/turn-importance.ts) ──

const DECISION_VERB_EN =
  /\b(use|let's use|going with|go with|pick|choose|switch to|instead of|scratch that|actually|i'll go with)\b/i;
const DECISION_VERB_TH = /(ใช้|เอา|เปลี่ยนเป็น|ไปทาง|เลือก)/;
const USE_CASE_GUARD = /\buse\s+case(s)?\b/i;
// `\b` only applies to the English alternatives — Thai characters have no
// ASCII word-boundary. See the feature/main comment for the rationale.
const NEGATION_ALT = /(\bnot\b|ไม่ใช่|ไม่เอา).{0,30}(\buse\b|\bdo\b|ใช้|เอา)/i;
const ASSISTANT_PLAN = /^(I'll|Going to|Plan:|Let me)(\b|:|\s)/i;
const INPUT_REQUIRED_TAG = /\[INPUT-REQUIRED\]/;
const NEEDS_USER_INPUT_JSON = /needsUserInput["\s:]{0,10}true/i;
const LEADING_QUOTE_OR_FENCE = /^(\s*>|\s*```)/;

/**
 * Flatten a Turn's visible blocks into a single string for regex matching.
 *
 * Mirrors `summary-ladder.ts::flattenVisibleText` but kept local so this
 * module stays I/O-free and has zero external runtime dependencies beyond
 * the Turn / ContentBlock types.
 */
function flattenVisibleText(blocks: readonly ContentBlock[]): string {
  const parts: string[] = [];
  for (const block of blocks) {
    if (block.type === 'text') parts.push(block.text);
    else if (block.type === 'tool_use') parts.push(`[tool:${block.name}] ${JSON.stringify(block.input)}`);
    else if (block.type === 'tool_result') parts.push(`[result] ${block.content}`);
  }
  return parts.join('\n');
}

/**
 * Classify a turn by importance. Pure: same input always yields same output.
 *
 * Precedence: `tool_result` > `clarification` > `decision` > `normal`.
 *   - `tool_result` when any `tool_use` / `tool_result` / `thinking` block
 *     is present (these carry load-bearing context regardless of text)
 *   - `clarification` when flattened text contains `[INPUT-REQUIRED]` or
 *     `needsUserInput:true`
 *   - `decision` when the zero-regex shortcut fires (user reply to IR via
 *     `precededByInputRequired`) OR the scoring heuristic reaches >= 2
 *   - `normal` otherwise
 */
export function classifyTurn(turn: Turn, options: ClassifyOptions = {}): TurnImportance {
  // tool_result has highest precedence: tool-use / tool-result / thinking
  // blocks all signal intrinsically informative context, irrespective of
  // the prose in any accompanying text block.
  const hasTools = turn.blocks.some((b) => b.type === 'tool_use' || b.type === 'tool_result');
  const hasThinking = turn.blocks.some((b) => b.type === 'thinking');
  if (hasTools || hasThinking) {
    return 'tool_result';
  }

  const content = flattenVisibleText(turn.blocks);

  // clarification: any [INPUT-REQUIRED] block or JSON needsUserInput flag.
  if (INPUT_REQUIRED_TAG.test(content) || NEEDS_USER_INPUT_JSON.test(content)) {
    return 'clarification';
  }

  // Zero-regex shortcut — user turn directly answering an IR block is a
  // decision by construction.
  if (options.precededByInputRequired && turn.role === 'user') {
    return 'decision';
  }

  const head = content.slice(0, 120);

  // Suppress decision signals on quoted / fenced prose to avoid false
  // positives on documentation snippets and pasted commit bodies.
  if (LEADING_QUOTE_OR_FENCE.test(head)) {
    return 'normal';
  }

  let score = 0;

  const matchEn = head.match(DECISION_VERB_EN);
  if (matchEn) {
    // Guard against "use case" false positives — only suppresses when the
    // EN verb would have been the sole English signal.
    const isUseCase = /\buse\b/i.test(matchEn[0]) && USE_CASE_GUARD.test(head);
    if (!isUseCase) score += 1;
  }
  if (DECISION_VERB_TH.test(head)) score += 1;

  if (NEGATION_ALT.test(head)) score += 1;

  // Assistant-stated plan preamble — worth 2 points because a structural
  // "I'll / Plan: / Let me …" prefix reliably fronts a committed approach.
  if (turn.role === 'assistant' && ASSISTANT_PLAN.test(head)) score += 2;

  if (score >= 2) return 'decision';
  return 'normal';
}
