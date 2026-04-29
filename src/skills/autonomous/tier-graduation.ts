/**
 * Skill tier graduation — Phase-15 (Item 4) decision rule.
 *
 * Reads `SkillOutcomeStore` rows and decides which skills should change
 * `confidence_tier` based on Wilson lower bound on observed success rate.
 * Pure function — no IO, no clock other than `currentRun`. Applier
 * (`tier-graduation-applier.ts`) handles disk + ledger.
 *
 * Decision rule (deterministic, A3):
 *   - Wilson LB ≥ WILSON_LB_PROMOTE AND trials ≥ MIN_TRIALS_PROMOTE → promote
 *     one rung up (`speculative → probabilistic → pragmatic → heuristic →
 *     deterministic`). Clamp at `deterministic`.
 *   - Wilson LB < WILSON_LB_DEMOTE AND trials ≥ MIN_TRIALS_DEMOTE → demote
 *     one rung down. At `speculative` floor, demote becomes a status flip
 *     to `quarantined` (the floor is not a tier change but a status change
 *     — `speculative` is already the bottom tier).
 *
 * Cooldown: a skill that just graduated waits at least `MIN_COOLDOWN_RUNS`
 * before re-evaluating, so a single run can't ratchet a skill across multiple
 * rungs and so demote-after-promote requires fresh evidence.
 */
import { CONFIDENCE_TIERS, type ConfidenceTier } from '../../core/confidence-tier.ts';
import type { SkillOutcomeRecord } from '../../db/skill-outcome-store.ts';
import { wilsonLowerBound } from '../../sleep-cycle/wilson.ts';

export const MIN_TRIALS_PROMOTE = 30;
export const MIN_TRIALS_DEMOTE = 20;
export const WILSON_LB_PROMOTE = 0.85;
export const WILSON_LB_DEMOTE = 0.4;
export const MIN_COOLDOWN_RUNS = 3;

export type GraduationAction = 'promote' | 'demote' | 'quarantine';

export interface GraduationDecision {
  readonly skillId: string;
  readonly personaId: string;
  readonly taskSignature: string;
  readonly action: GraduationAction;
  readonly fromTier: ConfidenceTier;
  /** New tier after graduation. `null` for quarantine (status change, not tier). */
  readonly toTier: ConfidenceTier | null;
  readonly wilsonLB: number;
  readonly trials: number;
  readonly successes: number;
  readonly failures: number;
}

export interface DecideTierGraduationsInput {
  readonly rows: readonly SkillOutcomeRecord[];
  /**
   * Current `confidence_tier` per skillId, looked up by the applier (read
   * from the artifact store). Skills not in this map are skipped — the
   * decision function cannot infer current tier from outcomes alone.
   */
  readonly currentTierBySkill: ReadonlyMap<string, ConfidenceTier>;
  /**
   * Cooldown state: skillId → currentRun on which the last graduation was
   * applied. Skills are eligible again when `currentRun - lastRun ≥ MIN_COOLDOWN_RUNS`.
   */
  readonly cooldownState: ReadonlyMap<string, number>;
  readonly currentRun: number;
}

/**
 * Returns at most one decision per `(persona, skill, taskSig)` row that
 * qualifies. Multiple rows for the same skillId — even with conflicting
 * verdicts — are evaluated independently; the applier dedupes on skillId
 * to keep one tier change per cycle.
 */
export function decideTierGraduations(input: DecideTierGraduationsInput): GraduationDecision[] {
  const decisions: GraduationDecision[] = [];
  for (const row of input.rows) {
    const trials = row.successes + row.failures;
    if (trials === 0) continue;

    const fromTier = input.currentTierBySkill.get(row.skillId);
    if (!fromTier) continue;

    // Cooldown: skip if the last graduation for this skill is too recent.
    const lastRun = input.cooldownState.get(row.skillId);
    if (lastRun !== undefined && input.currentRun - lastRun < MIN_COOLDOWN_RUNS) continue;

    const lb = wilsonLowerBound(row.successes, trials);

    if (lb >= WILSON_LB_PROMOTE && trials >= MIN_TRIALS_PROMOTE) {
      const next = nextTierUp(fromTier);
      if (next === null) continue; // already at deterministic floor — no further promotion possible
      decisions.push({
        skillId: row.skillId,
        personaId: row.personaId,
        taskSignature: row.taskSignature,
        action: 'promote',
        fromTier,
        toTier: next,
        wilsonLB: lb,
        trials,
        successes: row.successes,
        failures: row.failures,
      });
      continue;
    }

    if (lb < WILSON_LB_DEMOTE && trials >= MIN_TRIALS_DEMOTE) {
      const next = nextTierDown(fromTier);
      if (next === null) {
        // Already at speculative — demote becomes a status change to quarantined.
        decisions.push({
          skillId: row.skillId,
          personaId: row.personaId,
          taskSignature: row.taskSignature,
          action: 'quarantine',
          fromTier,
          toTier: null,
          wilsonLB: lb,
          trials,
          successes: row.successes,
          failures: row.failures,
        });
      } else {
        decisions.push({
          skillId: row.skillId,
          personaId: row.personaId,
          taskSignature: row.taskSignature,
          action: 'demote',
          fromTier,
          toTier: next,
          wilsonLB: lb,
          trials,
          successes: row.successes,
          failures: row.failures,
        });
      }
    }
  }
  // Dedupe on skillId: the applier wants one tier change per cycle. Prefer
  // the strongest evidence — highest |lb - 0.5| absolute deviation from
  // neutral so the most decisive row wins.
  const bestBySkill = new Map<string, GraduationDecision>();
  for (const d of decisions) {
    const existing = bestBySkill.get(d.skillId);
    if (!existing || Math.abs(d.wilsonLB - 0.5) > Math.abs(existing.wilsonLB - 0.5)) {
      bestBySkill.set(d.skillId, d);
    }
  }
  return [...bestBySkill.values()];
}

/** Return the next-up tier, or null when already at the top. */
export function nextTierUp(tier: ConfidenceTier): ConfidenceTier | null {
  const idx = CONFIDENCE_TIERS.indexOf(tier);
  if (idx <= 0) return null; // 0 is `deterministic` (top); -1 means unknown
  return CONFIDENCE_TIERS[idx - 1] ?? null;
}

/** Return the next-down tier, or null when already at the bottom (`speculative`). */
export function nextTierDown(tier: ConfidenceTier): ConfidenceTier | null {
  const idx = CONFIDENCE_TIERS.indexOf(tier);
  if (idx === -1) return null;
  if (idx >= CONFIDENCE_TIERS.length - 1) return null;
  return CONFIDENCE_TIERS[idx + 1] ?? null;
}
