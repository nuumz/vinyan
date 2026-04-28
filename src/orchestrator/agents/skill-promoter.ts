/**
 * Skill promoter — Phase-6 acquired→bound proposer (offline helper).
 *
 * Reads `SkillOutcomeStore` and proposes promotions for (persona, skill)
 * pairs whose Wilson lower bound on success rate has cleared a threshold
 * across enough trials. Promotion = upgrade scope from acquired/runtime to
 * `bound` (persisted to `.vinyan/agents/<id>/skills.json`), so the skill
 * loads automatically on the next session without re-acquisition.
 *
 * This module is sleep-cycle wiring's natural consumer, but it is also
 * standalone usable: the helper takes a store, registry, and workspace
 * path, returns a proposal list, and (optionally) applies the promotions
 * to disk. Sleep-cycle integration is deferred to Phase 7 — keeping the
 * helper invocable directly lets a CLI command or test fixture demonstrate
 * the loop end-to-end today.
 *
 * Promotion gates (all must hold):
 *   1. `total >= MIN_TRIALS_FOR_PROMOTION` outcomes recorded
 *   2. Wilson LB on success rate ≥ `WILSON_LB_FOR_PROMOTION`
 *   3. Skill not already bound to the persona (idempotency)
 */

import type { SkillOutcomeStore } from '../../db/skill-outcome-store.ts';
import { wilsonLowerBound } from '../../sleep-cycle/wilson.ts';
import type { SkillRef } from '../types.ts';
import { loadBoundSkills, saveBoundSkills } from './persona-skill-loader.ts';
import type { AgentRegistry } from './registry.ts';

/**
 * Minimum number of recorded outcomes before a promotion is considered.
 * Mirrors the `WILSON_FLOOR_MIN_TRIALS` from `capability-trust.ts` so the
 * cold-start neutral does not falsely promote a 3/3 streak.
 */
export const MIN_TRIALS_FOR_PROMOTION = 10;
/**
 * Wilson LB threshold for promotion. 0.65 matches `agent-proposal-store`'s
 * existing promotion threshold for capability claims, keeping skill and
 * agent-claim promotion criteria consistent.
 */
export const WILSON_LB_FOR_PROMOTION = 0.65;

export interface PromotionProposal {
  personaId: string;
  skillId: string;
  /** Aggregate success/failure across all task signatures for this (persona, skill). */
  successes: number;
  failures: number;
  wilsonLB: number;
  /** Best task signature observed (highest LB). Documented for trace/audit. */
  evidenceTaskSignature: string;
}

/**
 * Aggregate per-(persona, skill) outcomes from the store and propose
 * promotions whose evidence clears the gates. Pure read — does not mutate
 * `.vinyan/agents/<id>/skills.json`. Pair with `applyPromotions` to persist.
 *
 * Aggregation note: outcomes are stored per-(persona, skill, taskSig). For
 * promotion decisions we sum across task signatures to get a coarser
 * persona+skill success rate. The `evidenceTaskSignature` field surfaces the
 * task family with the strongest LB so reviewers can spot-check.
 */
export function proposeAcquiredToBoundPromotions(
  store: SkillOutcomeStore,
  registry: AgentRegistry,
  workspace: string,
): PromotionProposal[] {
  const proposals: PromotionProposal[] = [];

  for (const persona of registry.listAgents()) {
    const rows = store.listForPersona(persona.id);
    if (rows.length === 0) continue;

    // Aggregate across task signatures: sum successes/failures, keep best LB
    // signature for evidence reference.
    const bySkill = new Map<string, { successes: number; failures: number; bestLB: number; bestSig: string }>();
    for (const row of rows) {
      const total = row.successes + row.failures;
      const lb = total > 0 ? wilsonLowerBound(row.successes, total) : 0;
      const existing = bySkill.get(row.skillId);
      if (!existing) {
        bySkill.set(row.skillId, {
          successes: row.successes,
          failures: row.failures,
          bestLB: lb,
          bestSig: row.taskSignature,
        });
      } else {
        existing.successes += row.successes;
        existing.failures += row.failures;
        if (lb > existing.bestLB) {
          existing.bestLB = lb;
          existing.bestSig = row.taskSignature;
        }
      }
    }

    const alreadyBound = new Set<string>(loadBoundSkills(workspace, persona.id).map((r) => r.id));

    for (const [skillId, agg] of bySkill) {
      const total = agg.successes + agg.failures;
      if (total < MIN_TRIALS_FOR_PROMOTION) continue;
      // Aggregate Wilson LB on the persona+skill grand total.
      const aggregateLB = wilsonLowerBound(agg.successes, total);
      if (aggregateLB < WILSON_LB_FOR_PROMOTION) continue;
      if (alreadyBound.has(skillId)) continue;
      proposals.push({
        personaId: persona.id,
        skillId,
        successes: agg.successes,
        failures: agg.failures,
        wilsonLB: aggregateLB,
        evidenceTaskSignature: agg.bestSig,
      });
    }
  }

  return proposals;
}

/**
 * Apply promotion proposals to disk. Adds the skill to the persona's
 * `bound` list (`.vinyan/agents/<id>/skills.json`) without overwriting
 * existing bindings. Idempotent: re-applying the same proposals is a no-op.
 *
 * Returns the proposals that were actually applied (skipping any whose
 * skill id already appears in the bound list — a defensive double-check
 * because `proposeAcquiredToBoundPromotions` already filtered).
 */
export function applyPromotions(workspace: string, proposals: readonly PromotionProposal[]): PromotionProposal[] {
  const applied: PromotionProposal[] = [];
  // Group by persona so we read/write each persona's skills.json once.
  const byPersona = new Map<string, PromotionProposal[]>();
  for (const p of proposals) {
    const list = byPersona.get(p.personaId) ?? [];
    list.push(p);
    byPersona.set(p.personaId, list);
  }
  for (const [personaId, list] of byPersona) {
    const existing = loadBoundSkills(workspace, personaId);
    const existingIds = new Set(existing.map((r) => r.id));
    const additions: SkillRef[] = [];
    for (const proposal of list) {
      if (existingIds.has(proposal.skillId)) continue;
      additions.push({ id: proposal.skillId });
      applied.push(proposal);
    }
    if (additions.length === 0) continue;
    saveBoundSkills(workspace, personaId, [...existing, ...additions]);
  }
  return applied;
}
