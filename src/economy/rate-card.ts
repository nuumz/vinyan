/**
 * Rate Card — provider model → $/token pricing.
 *
 * Pure functions. No side effects. A3 compliant (deterministic).
 * Glob matching on model strings; first match wins.
 *
 * Source of truth: Economy OS plan §E1.2
 */
import { simpleGlobMatch } from '../core/glob.ts';
import type { RateCardEntry } from './economy-config.ts';

export interface RateCard {
  modelPattern: string;
  input_per_mtok: number;
  output_per_mtok: number;
  cache_read_per_mtok: number;
  cache_create_per_mtok: number;
}

/**
 * Default rate cards — built-in pricing for common models.
 * Overridable via economy.rate_cards config.
 * Prices as of 2026-04 — update as providers change pricing.
 */
export const DEFAULT_RATE_CARDS: RateCard[] = [
  {
    modelPattern: '*claude-opus*',
    input_per_mtok: 15.0,
    output_per_mtok: 75.0,
    cache_read_per_mtok: 1.5,
    cache_create_per_mtok: 18.75,
  },
  {
    modelPattern: '*claude-sonnet*',
    input_per_mtok: 3.0,
    output_per_mtok: 15.0,
    cache_read_per_mtok: 0.3,
    cache_create_per_mtok: 3.75,
  },
  {
    modelPattern: '*claude-haiku*',
    input_per_mtok: 0.25,
    output_per_mtok: 1.25,
    cache_read_per_mtok: 0.025,
    cache_create_per_mtok: 0.3,
  },
  {
    modelPattern: '*gemini-2.0-flash*',
    input_per_mtok: 0.1,
    output_per_mtok: 0.4,
    cache_read_per_mtok: 0.025,
    cache_create_per_mtok: 0.0,
  },
  {
    modelPattern: '*gpt-4o*',
    input_per_mtok: 2.5,
    output_per_mtok: 10.0,
    cache_read_per_mtok: 1.25,
    cache_create_per_mtok: 0.0,
  },
  {
    modelPattern: '*gpt-4o-mini*',
    input_per_mtok: 0.15,
    output_per_mtok: 0.6,
    cache_read_per_mtok: 0.075,
    cache_create_per_mtok: 0.0,
  },
];

/**
 * Resolve a model string to a rate card.
 * Config rate_cards (exact key match) checked first, then DEFAULT_RATE_CARDS (glob).
 * Returns null if no match (caller should use cost_tier: 'estimated').
 */
export function resolveRateCard(model: string, configCards: Record<string, RateCardEntry> = {}): RateCard | null {
  // Config cards: exact key match (highest priority)
  const configEntry = configCards[model];
  if (configEntry) {
    return {
      modelPattern: model,
      input_per_mtok: configEntry.input_per_mtok,
      output_per_mtok: configEntry.output_per_mtok,
      cache_read_per_mtok: configEntry.cache_read_per_mtok,
      cache_create_per_mtok: configEntry.cache_create_per_mtok,
    };
  }

  // Default cards: glob match (first match wins)
  for (const card of DEFAULT_RATE_CARDS) {
    if (simpleGlobMatch(card.modelPattern, model)) {
      return card;
    }
  }

  return null;
}
