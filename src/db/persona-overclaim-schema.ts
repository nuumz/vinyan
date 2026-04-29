/**
 * `persona_overclaim` table — Phase-14 persistence for the per-persona
 * overclaim ledger that drives auction `overclaimPenalty` (Phase 12).
 *
 * Distinct from `bid_accuracy.overclaim_violations` (provider-keyed,
 * deliberately untouched per Phase-12 design): persona-keyed, mirrors the
 * `PersonaOverclaimTracker` in-memory shape verbatim. Per-record writes are
 * fine — the producer fires at most once per executeTask completion that
 * crossed the OVERCLAIM_MIN_LOADED_SKILLS threshold.
 *
 * `persona_id` is the natural primary key — there is at most one row per
 * persona at any time. `last_updated` powers cold-start eviction policy
 * if/when one is added; not used by the current penalty math.
 */
export const PERSONA_OVERCLAIM_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS persona_overclaim (
  persona_id   TEXT    NOT NULL PRIMARY KEY,
  observations INTEGER NOT NULL DEFAULT 0,
  overclaims   INTEGER NOT NULL DEFAULT 0,
  last_updated INTEGER NOT NULL
);
`;
