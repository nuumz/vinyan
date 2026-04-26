/**
 * Token-budget enforcement for progressive disclosure (Decision 20).
 *
 * Per-level token budgets keep L0 listings cheap, L1 summaries focused, and
 * L2 file reads bounded — so the orchestrator pays a predictable prompt cost
 * when surfacing SKILL.md content to a worker.
 *
 * This module is deliberately tokenizer-free: the estimator uses a cheap
 * char/word heuristic (4 chars ≈ 1 token for English, with a word-count
 * sanity floor). It's not accurate enough for billing, but is monotonic and
 * stable enough for truncation decisions. The sibling Memory retrieval path
 * uses the same approximation.
 *
 * Axiom anchor: A3 Deterministic Governance — the truncation rule is purely
 * rule-based and never calls an LLM to decide what stays.
 */

/** L0 listing budget — compact skill cards for catalog views. */
export const L0_BUDGET_TOKENS = 3_000;

/** L1 summary budget — single skill's frontmatter + body without file contents. */
export const L1_BUDGET_TOKENS = 6_000;

/** L2 file budget — one whitelisted companion file read. */
export const L2_BUDGET_TOKENS = 12_000;

/**
 * Cheap token estimator. ≈ ceil(max(chars/4, words*0.75)). Monotonic in both
 * character count and word count so longer text always estimates larger.
 */
export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  const words = text.split(/\s+/).filter((w) => w.length > 0).length;
  const byChars = text.length / 4;
  const byWords = words * 0.75;
  return Math.ceil(Math.max(byChars, byWords));
}

/**
 * Truncate `text` so its estimated token count does not exceed `maxTokens`.
 * When a truncation happens, a terminal `… [truncated]` marker is appended.
 */
export function truncateToTokenBudget(text: string, maxTokens: number): { text: string; truncated: boolean } {
  if (maxTokens <= 0) return { text: '', truncated: text.length > 0 };
  if (estimateTokens(text) <= maxTokens) {
    return { text, truncated: false };
  }
  const marker = '\n… [truncated]';
  // Binary-search the cut point so the final string's estimate stays ≤ maxTokens.
  // Upper bound is the char budget (maxTokens * 4 - marker). Since estimateTokens
  // is monotonic in text length, binary search converges cleanly.
  let lo = 0;
  let hi = Math.max(0, maxTokens * 4 - marker.length);
  hi = Math.min(hi, text.length);
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    const candidate = text.slice(0, mid) + marker;
    if (estimateTokens(candidate) <= maxTokens) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  let cut = text.slice(0, lo);
  // Prefer to cut at a line boundary if one is within the last 200 chars.
  const lastNewline = cut.lastIndexOf('\n');
  if (lastNewline > lo - 200 && lastNewline > 0) {
    cut = cut.slice(0, lastNewline);
  }
  return { text: `${cut}${marker}`, truncated: true };
}
