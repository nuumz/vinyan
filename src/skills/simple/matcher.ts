/**
 * Simple skill matcher — Jaccard token-set similarity between a user task and
 * skill descriptions.
 *
 * Why Jaccard, not embeddings:
 *   - Deterministic. The same query always picks the same skills (A3).
 *   - No LLM call (A1: matching is part of the dispatch path; LLM-in-the-loop
 *     would create a self-evaluation loophole).
 *   - Cheap. O(N skills × M tokens) per task — fine for libraries < 1,000 skills.
 *   - Good enough for description-driven invocation. Claude Code's skill picker
 *     is also keyword-leaning under the hood.
 *
 * Future: when `LLMProviderRegistry` exposes embeddings, swap this matcher for
 * a cosine-similarity variant. The interface stays the same.
 *
 * Tokenization rules:
 *   - Lowercase, split on non-alphanumeric.
 *   - Drop English stopwords + 1-char tokens.
 *   - No stemming — keeps the implementation deterministic and predictable.
 */

import type { SimpleSkill } from './loader.ts';

export const DEFAULT_THRESHOLD = 0.15;
export const DEFAULT_TOP_K = 3;

/** Stopword list — kept short on purpose; over-aggressive filtering hurts recall. */
const STOPWORDS = new Set([
  'a',
  'an',
  'the',
  'and',
  'or',
  'but',
  'if',
  'of',
  'to',
  'in',
  'on',
  'at',
  'by',
  'for',
  'with',
  'as',
  'is',
  'was',
  'are',
  'were',
  'be',
  'been',
  'being',
  'this',
  'that',
  'these',
  'those',
  'it',
  'its',
  'i',
  'you',
  'we',
  'they',
  'me',
  'my',
  'your',
  'our',
  'their',
  'do',
  'does',
  'did',
  'have',
  'has',
  'had',
  'will',
  'would',
  'should',
  'can',
  'could',
  'may',
  'might',
  'must',
  'use',
  'when',
]);

export interface MatchResult {
  readonly skill: SimpleSkill;
  readonly score: number;
}

export interface MatchOptions {
  readonly threshold?: number;
  readonly topK?: number;
}

/**
 * Tokenize text into a deduped set of lowercase content tokens.
 * Exported for tests and for prompt-section caching.
 */
export function tokenize(text: string): Set<string> {
  const tokens = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 2) continue;
    if (STOPWORDS.has(raw)) continue;
    tokens.add(raw);
  }
  return tokens;
}

/**
 * Jaccard similarity between two token sets — |A ∩ B| / |A ∪ B|.
 * Empty sets → 0 (avoids divide-by-zero and means "no shared content").
 */
export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersect = 0;
  for (const token of a) {
    if (b.has(token)) intersect += 1;
  }
  const union = a.size + b.size - intersect;
  if (union === 0) return 0;
  return intersect / union;
}

/**
 * Match a task query against a skill list. Returns matches above the threshold,
 * sorted by score desc, capped at `topK`.
 *
 * The `name + description` is the matcher target — body content is intentionally
 * NOT considered. Bodies are loaded lazily on match; if the description doesn't
 * tell the matcher when to use the skill, the skill is mis-authored.
 */
export function matchSkillsForTask(
  query: string,
  skills: readonly SimpleSkill[],
  opts: MatchOptions = {},
): readonly MatchResult[] {
  const threshold = opts.threshold ?? DEFAULT_THRESHOLD;
  const topK = opts.topK ?? DEFAULT_TOP_K;

  const queryTokens = tokenize(query);
  if (queryTokens.size === 0) return [];

  const scored: MatchResult[] = [];
  for (const skill of skills) {
    const skillTokens = tokenize(`${skill.name} ${skill.description}`);
    const score = jaccard(queryTokens, skillTokens);
    if (score >= threshold) {
      scored.push({ skill, score });
    }
  }
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.skill.name.localeCompare(b.skill.name);
  });
  return scored.slice(0, topK);
}

/**
 * Detect explicit skill invocation in the query — `/<name>` syntax.
 * Returns the skill that matches the bare name, or null. Explicit invocation
 * always wins over similarity-based matching.
 */
export function detectExplicitInvocation(
  query: string,
  skills: readonly SimpleSkill[],
): SimpleSkill | null {
  const match = query.match(/^\s*\/([\w\-./]+)/);
  if (!match) return null;
  const wanted = match[1]!;
  return skills.find((s) => s.name === wanted) ?? null;
}
