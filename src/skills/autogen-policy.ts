/**
 * Adaptive autogenerator policy — computes the success-streak
 * threshold from observed proposal-queue health.
 *
 * Why adaptive: a fixed `threshold = 3` was conservative but blind.
 * Two failure modes a fixed value can't avoid:
 *
 *   - **Flooded queue** — when traffic is high and operators are slow
 *     to triage, every successful pattern produces a proposal,
 *     drowning the queue. Raise the threshold so we only propose the
 *     more confident patterns.
 *   - **Starved queue** — when traffic is low or operators approve
 *     everything that comes through, a fixed threshold of 3 may
 *     never fire on slowly-recurring patterns. Lower it so we catch
 *     real signal.
 *
 * The policy reads three deterministic signals from
 * `SkillProposalStore`:
 *
 *   1. `pendingCount` — current quarantine + pending depth.
 *   2. `acceptanceRate` — approved / decided. High → operators
 *      trust the queue, room to lower threshold.
 *   3. `quarantineRate` — quarantined / created. High → safety
 *      scanner is firing often, raise threshold so weaker patterns
 *      don't pile up unsafe drafts.
 *
 * Formula (deterministic, A3):
 *
 *     base = 3
 *     base += clamp(pendingCount / 10, 0, 2)        // queue pressure
 *     base += quarantineRate >= 0.4 ? 1 : 0          // safety pressure
 *     base -= acceptanceRate >= 0.7 && pendingCount < 3 ? 1 : 0
 *     threshold = clamp(base, MIN, MAX)
 *
 * Floor / ceiling: `[MIN_THRESHOLD = 2, MAX_THRESHOLD = 8]`. The
 * floor of 2 keeps the system honest even when operators are eager
 * — a single emission is never enough to autogen.
 *
 * Cooldown / debounce: a separate concern handled by
 * `SkillAutogenStateStore.recordEmit`. The policy only owns the
 * threshold value.
 *
 * Feature flag: `enabled = false` reverts to the static
 * `staticThreshold` value for instant rollback. Persisted via the
 * adaptive parameter ledger so the rollback itself is auditable.
 */

import type { ParameterLedger } from '../orchestrator/adaptive-params/parameter-ledger.ts';
import type { SkillProposalStore } from '../db/skill-proposal-store.ts';

export const MIN_THRESHOLD = 2;
export const MAX_THRESHOLD = 8;
export const STATIC_THRESHOLD_FALLBACK = 3;
const PARAM_NAME = 'skill_autogen_threshold';
const OWNER_MODULE = 'skill-autogen-policy';

export interface AutogenPolicyConfig {
  /** When false the policy returns `staticThreshold`. Default: true. */
  readonly enabled?: boolean;
  /** Threshold used when `enabled` is false. Default: 3. */
  readonly staticThreshold?: number;
  /** Min floor. Defaults to MIN_THRESHOLD. */
  readonly min?: number;
  /** Max ceiling. Defaults to MAX_THRESHOLD. */
  readonly max?: number;
}

export interface AutogenPolicySnapshot {
  readonly threshold: number;
  readonly enabled: boolean;
  readonly staticThreshold: number;
  readonly min: number;
  readonly max: number;
  readonly signals: {
    readonly pendingCount: number;
    readonly acceptanceRate: number;
    readonly quarantineRate: number;
    readonly totalCreated: number;
    readonly totalDecided: number;
    readonly totalQuarantined: number;
  };
  /** When the snapshot was computed. */
  readonly computedAt: number;
  /** ISO reason string explaining why the threshold landed at its value. */
  readonly explanation: string;
}

/**
 * Snapshot the proposal queue and compute the adaptive threshold.
 * Pure of side-effects; the ledger write is a separate call.
 */
export function computeAdaptiveThreshold(
  store: SkillProposalStore,
  profile: string,
  config: AutogenPolicyConfig = {},
): AutogenPolicySnapshot {
  const enabled = config.enabled ?? true;
  const staticThreshold = clamp(
    config.staticThreshold ?? STATIC_THRESHOLD_FALLBACK,
    config.min ?? MIN_THRESHOLD,
    config.max ?? MAX_THRESHOLD,
  );

  const all = store.list(profile, { limit: 1000 });
  const pendingCount = all.filter((p) => p.status === 'pending' || p.status === 'quarantined').length;
  const totalCreated = all.length;
  const totalQuarantined = all.filter((p) => p.status === 'quarantined').length;
  const totalDecided = all.filter((p) => p.status === 'approved' || p.status === 'rejected').length;
  const totalApproved = all.filter((p) => p.status === 'approved').length;

  const acceptanceRate = totalDecided > 0 ? totalApproved / totalDecided : 0;
  const quarantineRate = totalCreated > 0 ? totalQuarantined / totalCreated : 0;

  let threshold: number;
  let explanation: string;
  if (!enabled) {
    threshold = staticThreshold;
    explanation = `policy disabled — using staticThreshold=${staticThreshold}`;
  } else {
    let base = STATIC_THRESHOLD_FALLBACK;
    const queuePressure = clamp(Math.floor(pendingCount / 10), 0, 2);
    const safetyPressure = quarantineRate >= 0.4 ? 1 : 0;
    const eagerOperator = acceptanceRate >= 0.7 && pendingCount < 3 ? 1 : 0;
    base += queuePressure;
    base += safetyPressure;
    base -= eagerOperator;
    threshold = clamp(base, config.min ?? MIN_THRESHOLD, config.max ?? MAX_THRESHOLD);
    const parts: string[] = [`base=${STATIC_THRESHOLD_FALLBACK}`];
    if (queuePressure > 0) parts.push(`+${queuePressure} (queue depth ${pendingCount})`);
    if (safetyPressure > 0) parts.push(`+1 (quarantineRate ${(quarantineRate * 100).toFixed(0)}% >= 40%)`);
    if (eagerOperator > 0) parts.push(`-1 (acceptanceRate ${(acceptanceRate * 100).toFixed(0)}% >= 70% & low pending)`);
    explanation = `${parts.join(' ')} → clamp[${config.min ?? MIN_THRESHOLD}, ${config.max ?? MAX_THRESHOLD}] = ${threshold}`;
  }

  return {
    threshold,
    enabled,
    staticThreshold,
    min: config.min ?? MIN_THRESHOLD,
    max: config.max ?? MAX_THRESHOLD,
    signals: {
      pendingCount,
      acceptanceRate,
      quarantineRate,
      totalCreated,
      totalDecided,
      totalQuarantined,
    },
    computedAt: Date.now(),
    explanation,
  };
}

/**
 * Append a parameter-ledger row when the threshold changes. Called
 * by the autogenerator after `computeAdaptiveThreshold` to persist
 * provenance for the change. No-op when the threshold stayed the
 * same — the ledger is a delta log, not a heartbeat.
 */
export function recordThresholdChange(
  ledger: ParameterLedger,
  oldThreshold: number,
  snapshot: AutogenPolicySnapshot,
  reason: string,
): boolean {
  if (snapshot.threshold === oldThreshold) return false;
  ledger.append({
    paramName: PARAM_NAME,
    oldValue: oldThreshold,
    newValue: snapshot.threshold,
    reason: `${reason} | ${snapshot.explanation}`,
    ownerModule: OWNER_MODULE,
  });
  return true;
}

/**
 * Read the most-recent threshold value from the ledger. Returns null
 * when no row exists — caller falls back to a fresh
 * `computeAdaptiveThreshold`.
 */
export function readPersistedThreshold(ledger: ParameterLedger): number | null {
  const latest = ledger.latest(PARAM_NAME);
  if (!latest) return null;
  const value = typeof latest.newValue === 'number' ? latest.newValue : Number(latest.newValue);
  if (!Number.isFinite(value)) return null;
  return clamp(value, MIN_THRESHOLD, MAX_THRESHOLD);
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, value));
}

export const AUTOGEN_THRESHOLD_PARAM_NAME = PARAM_NAME;
export const AUTOGEN_THRESHOLD_OWNER_MODULE = OWNER_MODULE;
