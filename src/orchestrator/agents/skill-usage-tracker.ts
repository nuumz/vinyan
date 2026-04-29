/**
 * SkillUsageTracker — Phase-11 producer for the overclaim detector (M1).
 *
 * The bid carries `loadedSkillIds` (skills loaded into the persona for the
 * task) and wins the auction by advertising `declaredCapabilityIds` derived
 * from those skills. If the LLM only references a fraction of the loaded
 * skills during execution, the auction was won under false pretenses —
 * **overclaim**. Phase-3 reserved an `overclaim_violations` counter on
 * `BidAccuracyRecord` for exactly this; Phase-11 ships the producer.
 *
 * Usage signal: `skill_view` tool calls. When the LLM invokes
 * `skill_view(skillId)` to fetch a skill's L1 detail, the tracker records
 * that skill as "viewed" for the task. After task completion, the
 * comparator counts viewed/loaded ratio and decides whether to emit
 * `bid:overclaim_detected`.
 *
 * Limitations (documented honestly):
 *   - The LLM may use a skill via L0 catalog without invoking `skill_view`.
 *     This produces false-positive overclaim. Mitigation: only flag when
 *     the ratio is genuinely low (≤ OVERCLAIM_RATIO_THRESHOLD).
 *   - Tasks with `loadedSkillIds.length === 1` are excluded — overclaim
 *     is meaningful only when there's surplus.
 *
 * Pure data — no IO, no clock, no LLM. A3 compliant.
 */

/**
 * View-coverage threshold below which a task's loadout is flagged as overclaim.
 * 0.5 means "must use at least half the declared skills" — generous so that
 * heuristic L0-only usage isn't punished.
 */
export const OVERCLAIM_RATIO_THRESHOLD = 0.5;

/**
 * Minimum loaded skill count for overclaim to be meaningful. With 1 skill
 * loaded, "viewed/loaded" is binary and noisy — skip evaluation.
 */
export const OVERCLAIM_MIN_LOADED_SKILLS = 2;

export class SkillUsageTracker {
  private readonly viewed = new Map<string, Set<string>>();

  /** Record that `skillId` was viewed during execution of `taskId`. */
  recordView(taskId: string, skillId: string): void {
    let set = this.viewed.get(taskId);
    if (!set) {
      set = new Set<string>();
      this.viewed.set(taskId, set);
    }
    set.add(skillId);
  }

  /** Snapshot the viewed-skill set for a task. Returns empty set when no views. */
  getViewed(taskId: string): ReadonlySet<string> {
    return this.viewed.get(taskId) ?? new Set();
  }

  /**
   * Drop the per-task entry. Call after the comparator has decided overclaim
   * vs non-overclaim — keeps memory bounded across long-running orchestrators.
   */
  clearTask(taskId: string): void {
    this.viewed.delete(taskId);
  }

  /** Drop everything. Tests use this to isolate fixtures. */
  reset(): void {
    this.viewed.clear();
  }
}

/**
 * Outcome of the per-task overclaim evaluation. Callers emit
 * `bid:overclaim_detected` only when `flagged` is true.
 */
export interface OverclaimEvaluation {
  flagged: boolean;
  declaredCount: number;
  viewedCount: number;
  viewedRatio: number;
  reason?: 'too-few-loaded' | 'no-skills' | 'evaluated';
}

/**
 * Compare loaded vs viewed skill ids. Returns enough info for the caller to
 * emit a structured bus event when `flagged === true`.
 *
 * Cases:
 *   - `loadedSkillIds.length === 0` → not flagged (legacy bid; no skills)
 *   - `loadedSkillIds.length < OVERCLAIM_MIN_LOADED_SKILLS` → not flagged
 *     (too few skills for overclaim to be meaningful)
 *   - `viewedRatio < OVERCLAIM_RATIO_THRESHOLD` → flagged
 */
export function evaluateOverclaim(
  loadedSkillIds: readonly string[],
  viewed: ReadonlySet<string>,
): OverclaimEvaluation {
  const declaredCount = loadedSkillIds.length;
  if (declaredCount === 0) {
    return { flagged: false, declaredCount: 0, viewedCount: 0, viewedRatio: 1, reason: 'no-skills' };
  }
  if (declaredCount < OVERCLAIM_MIN_LOADED_SKILLS) {
    return {
      flagged: false,
      declaredCount,
      viewedCount: countViewedAmongLoaded(loadedSkillIds, viewed),
      viewedRatio: 1,
      reason: 'too-few-loaded',
    };
  }
  const viewedCount = countViewedAmongLoaded(loadedSkillIds, viewed);
  const viewedRatio = viewedCount / declaredCount;
  return {
    flagged: viewedRatio < OVERCLAIM_RATIO_THRESHOLD,
    declaredCount,
    viewedCount,
    viewedRatio,
    reason: 'evaluated',
  };
}

/**
 * Count how many of the loaded skill ids appear in the viewed set. We
 * intersect specifically (rather than `viewed.size`) because the LLM may
 * also have viewed skills outside the persona's loadout — those don't
 * count toward the persona's usage of its own declared loadout.
 */
function countViewedAmongLoaded(loadedSkillIds: readonly string[], viewed: ReadonlySet<string>): number {
  let count = 0;
  for (const id of loadedSkillIds) if (viewed.has(id)) count++;
  return count;
}
