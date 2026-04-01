/**
 * Approach similarity — Jaccard-based clustering for LLM-generated approach strings.
 *
 * Solves: exact-match groupByApproach destroys learning signal because
 * semantically identical approaches with different wording never cluster.
 *
 * Axiom: A7 (prediction error as learning signal — clean clustering enables meaningful patterns)
 */

const STOP_WORDS = new Set([
  'the',
  'a',
  'an',
  'to',
  'from',
  'into',
  'for',
  'of',
  'with',
  'in',
  'on',
  'by',
  'as',
  'and',
  'or',
  'is',
  'are',
  'was',
  'were',
  'be',
  'been',
  'being',
  'that',
  'this',
  'it',
  'its',
  'at',
  'but',
  'not',
  'so',
  'if',
  'then',
]);

/**
 * Tokenize and normalize an approach string into a comparable token set.
 * Lowercase, split on whitespace/punctuation, remove stop words, sort.
 */
export function normalizeApproach(approach: string): string[] {
  return approach
    .toLowerCase()
    .split(/[\s\-_.,;:!?()[\]{}"'`/\\|+=<>@#$%^&*~]+/)
    .filter((token) => token.length > 1 && !STOP_WORDS.has(token))
    .sort();
}

/**
 * Jaccard similarity between two token sets.
 * Returns intersection / union (0-1).
 */
export function jaccardSimilarity(tokensA: string[], tokensB: string[]): number {
  const setA = new Set(tokensA);
  const setB = new Set(tokensB);

  if (setA.size === 0 && setB.size === 0) return 1.0;
  if (setA.size === 0 || setB.size === 0) return 0;

  let intersection = 0;
  for (const token of setA) {
    if (setB.has(token)) intersection++;
  }

  const union = new Set([...setA, ...setB]).size;
  return intersection / union;
}

/** Default clustering threshold — approaches above this are considered equivalent. */
export const APPROACH_SIMILARITY_THRESHOLD = 0.6;

/**
 * Cluster items by approach similarity using single-linkage clustering.
 * Each item is assigned to the first cluster whose representative has
 * Jaccard similarity >= threshold. If none match, a new cluster is created.
 *
 * Returns a Map where keys are representative approach strings and values
 * are arrays of the original items.
 */
export function clusterByApproach<T>(
  items: T[],
  getApproach: (item: T) => string,
  threshold = APPROACH_SIMILARITY_THRESHOLD,
): Map<string, T[]> {
  const clusters: Array<{ representative: string; tokens: string[]; items: T[] }> = [];

  for (const item of items) {
    const approach = getApproach(item);
    const tokens = normalizeApproach(approach);

    let matched = false;
    for (const cluster of clusters) {
      if (jaccardSimilarity(tokens, cluster.tokens) >= threshold) {
        cluster.items.push(item);
        matched = true;
        break;
      }
    }

    if (!matched) {
      clusters.push({ representative: approach, tokens, items: [item] });
    }
  }

  const result = new Map<string, T[]>();
  for (const cluster of clusters) {
    result.set(cluster.representative, cluster.items);
  }
  return result;
}
