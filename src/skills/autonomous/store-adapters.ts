/**
 * Structural adapter types for AutonomousSkillCreator dependencies.
 *
 * The creator does NOT import the concrete `SkillStore` / `PredictionLedger`
 * classes — it consumes a minimal structural surface so:
 *   1. Tests can substitute in-memory fakes without a real SQLite database.
 *   2. The creator stays decoupled from schema-level changes in either store.
 *
 * Both adapters are satisfied by the production classes as-is; the types
 * here are narrowing views, not competing contracts.
 */
import type { CachedSkill } from '../../orchestrator/types.ts';

/**
 * Subset of `SkillStore` the creator needs. `CachedSkillLike` mirrors the
 * production `CachedSkill` shape — the alias preserves that coupling
 * structurally without forcing consumers to import `orchestrator/types`.
 */
export type CachedSkillLike = CachedSkill;

export interface SkillStoreLike {
  findBySignature(taskSignature: string, agentId?: string): CachedSkillLike | null;
  insert(skill: CachedSkillLike): void;
}

/**
 * Subset of `PredictionLedger` we read from during drafting.
 *
 * The production `PredictionLedger` satisfies this surface because it exposes
 * per-task-type aggregations via `getPercentiles` + `getFileOutcomeStats`.
 * SK4 only requires the count hook today; listed here so future draft-time
 * enrichment (e.g. "representative prior run") has a place to plug in
 * without touching the creator signature.
 */
export interface PredictionLedgerLike {
  /** Total recorded predictions — sanity check for the gate's data-sufficiency. */
  getPredictionCount?(): number;
  /** Trace-count hook (optional) — useful for dashboards. */
  getTraceCount?(): number;
}
