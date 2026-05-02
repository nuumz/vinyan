/**
 * Trend feed — Phase C interface for the smart-clarification gate.
 *
 * The gate's LLM ranking pass enriches deterministic-template options with
 * a `trendingHint?: string` per option (e.g. "Lifestyle vlogs +47% week",
 * "Lo-fi study tracks dominant on Spotify charts"). Those hints come from
 * a `ClarificationTrendProvider` registered alongside the orchestrator.
 *
 * Lifecycle (Phase C scope):
 *   - Interface only. v1 ships with NO concrete implementation.
 *   - The smart gate accepts the provider as an optional dep and degrades
 *     gracefully when absent (no `trendingHint` populated → LLM ranker is
 *     instructed to NOT invent one).
 *   - Concrete adapters (TikTok-API, Suno-trends, RSS feeds, manual JSON
 *     file) land in a future phase.
 *
 * Design constraint: the provider returns DOMAIN-keyed hints, not goal-text
 * pattern matching. We pass the inferred `creativeDomain` + a coarse query
 * map (genre/audience/etc.) — the provider returns whatever subset it has
 * data for. This keeps the contract narrow: providers don't need to parse
 * goal text.
 *
 * No I/O in this module — just types. Concrete providers may do I/O
 * (HTTP, file read) but must enforce their own timeouts.
 */

import type { CreativeDomain } from '../understanding/clarification-templates.ts';

/**
 * What the smart-clarification gate asks for. The provider may consult
 * each field — none are required to use. Empty / undefined means "no
 * extra context, return whatever you have for the domain".
 */
export interface ClarificationTrendQuery {
  /** Inferred from `inferCreativeDomain(goal)`. */
  creativeDomain: CreativeDomain;
  /** Free-form goal text — providers can grep for hashtags / brand names. */
  goal: string;
  /**
   * Coarse known-fields the user has already supplied (or session memory
   * has carried). Lets the provider tighten its hint set — e.g. when
   * audience is already 'teen', don't surface adult-targeted trends.
   */
  knownAnswers?: Partial<Record<TrendQuestionKey, string>>;
}

/**
 * Question slots the gate tracks. Mirrors the `TemplateId` union in
 * clarification-templates.ts but kept independent here so the trend
 * provider doesn't import the templates module.
 */
export type TrendQuestionKey = 'genre' | 'audience' | 'tone' | 'length' | 'platform' | 'specialist';

/**
 * One per-option hint. Returned by the provider keyed by question +
 * option-id. The gate's LLM ranker reads this and may surface the
 * `text` verbatim under the option, plus use the `score` to bias
 * the suggestedDefault choice.
 */
export interface ClarificationTrendHint {
  /** Short user-facing text — keep under 80 chars. */
  text: string;
  /**
   * 0..1 confidence the provider has in this hint. The gate ranker uses
   * this to weight `suggestedDefault`. Optional — when absent, the gate
   * treats it as ~0.5 (informational, not decision-driving).
   */
  score?: number;
  /** Optional source attribution for the hint (e.g. "TikTok Trending API 2026-05-02"). */
  source?: string;
}

/**
 * Provider response — sparse map keyed by `(questionId)::(optionId)`.
 * The gate iterates registered options and looks up hints by composite
 * key. Providers are free to omit options they have no data for.
 *
 * Map keys MUST follow the pattern `${questionId}::${optionId}`. Using
 * `:` as the separator avoids collision with Vinyan ids that may
 * contain dots (e.g. `runway-gen-4.5`).
 */
export type ClarificationTrendHintMap = ReadonlyMap<string, ClarificationTrendHint>;

/**
 * Provider contract. Mirrors the shape of `KnowledgeProvider` in
 * `capabilities/knowledge-acquisition.ts` so wiring is consistent across
 * orchestrator dependency surfaces.
 */
export interface ClarificationTrendProvider {
  /** Stable id used in observability events / traces. */
  readonly id: string;
  /**
   * Fetch hints for the given query. Implementations MUST:
   *   - Honour their own timeout (the gate caps at 1s by default).
   *   - Return empty Map on miss / failure rather than throwing.
   *   - Never invent hints when no data is available — the LLM ranker
   *     trusts the absence of a key as "no signal".
   */
  fetch(query: ClarificationTrendQuery): Promise<ClarificationTrendHintMap> | ClarificationTrendHintMap;
}

/**
 * Helper for constructing the composite hint key — keeps the format
 * consistent across producers and consumers.
 */
export function trendHintKey(questionId: TrendQuestionKey, optionId: string): string {
  return `${questionId}::${optionId}`;
}

/**
 * No-op provider — useful for tests + as the default when no real
 * provider is wired. Returns an empty map for every query so the gate's
 * LLM ranker gets the "no trend signal" branch consistently.
 */
export const NULL_TREND_PROVIDER: ClarificationTrendProvider = {
  id: 'null-trend-provider',
  fetch(): ClarificationTrendHintMap {
    return new Map();
  },
};
