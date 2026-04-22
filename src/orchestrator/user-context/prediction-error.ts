/**
 * Prediction-error metric for USER.md sections.
 *
 * The dialectic user-model compares a section's `predicted_response`
 * against observed user turns assigned to that section. Per-turn "distance"
 * feeds the rolling-window rule in `dialectic.ts`.
 *
 * ## MVP metric: token-set Jaccard distance
 *
 * Given two strings:
 *   - Lowercase + trim.
 *   - Split on whitespace + punctuation → token multiset.
 *   - `distance = 1 - |A ∩ B| / |A ∪ B|`, computed over **unique tokens** (sets).
 *   - Return `1.0` when either side is empty (maximum disagreement — no overlap
 *     is possible) except the degenerate case where both are empty, where we
 *     return `0.0` (definitionally identical).
 *
 * This is deliberately coarse — it compares surface token overlap, not meaning.
 * A future PR can swap the implementation for an embedding-based cosine
 * distance that the MemoryProvider's vector column already supports. For the
 * MVP the goal is only to ledger errors and drive rule-based decisions; the
 * metric quality improves later without changing the rule surface.
 *
 * Properties guaranteed by the Jaccard metric:
 *   - Range: [0, 1].
 *   - Symmetric: `computeSectionDelta(a, b) === computeSectionDelta(b, a)`.
 *   - Identity: `computeSectionDelta(x, x) === 0` for any non-empty x.
 *   - Monotonic on overlap: more shared tokens → lower distance.
 *
 * Axiom anchor: A7 (prediction-error as learning signal).
 */

// Tokenization: split on any run of non-alphanumeric characters. Keeps the
// metric language-agnostic enough for English + Thai token-level overlap
// (Thai words without spaces will be lumped together — acceptable for MVP;
// real Thai tokenization would require dictionary segmentation).
const TOKEN_SPLIT = /[^\p{L}\p{N}]+/u;

function tokenize(text: string): Set<string> {
  if (text.length === 0) return new Set();
  const tokens = text
    .toLowerCase()
    .trim()
    .split(TOKEN_SPLIT)
    .filter((t) => t.length > 0);
  return new Set(tokens);
}

/**
 * Compute the Jaccard distance between two strings. Returns a number in [0, 1]:
 *   - `0` means perfect token-set overlap (or both empty).
 *   - `1` means no overlap (or exactly one side empty).
 */
export function computeSectionDelta(predicted: string, observed: string): number {
  const p = tokenize(predicted);
  const o = tokenize(observed);

  // Both empty → nothing to disagree about.
  if (p.size === 0 && o.size === 0) return 0;
  // Exactly one side empty → maximum disagreement.
  if (p.size === 0 || o.size === 0) return 1;

  let intersection = 0;
  for (const token of p) {
    if (o.has(token)) intersection++;
  }
  const union = p.size + o.size - intersection;
  if (union === 0) return 0; // defensive; unreachable given size checks above.
  return 1 - intersection / union;
}

/**
 * Rolling-window mean of deltas. Callers typically pass the `windowSize`
 * most recent observations for a section; returns `0` when empty.
 */
export function rollingMean(deltas: ReadonlyArray<number>): number {
  if (deltas.length === 0) return 0;
  let sum = 0;
  for (const d of deltas) sum += d;
  return sum / deltas.length;
}
