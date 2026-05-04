/**
 * ThinkingPolicy Compiler — deterministic 2D routing grid.
 *
 * Maps (risk × uncertainty) → ThinkingProfile → ThinkingPolicy.
 * Pure function: no LLM in the governance path (A3).
 *
 * Source of truth: docs/design/extensible-thinking-system-design.md §4.2
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { ThinkingConfig } from '../types.ts';
import type {
  ThinkingPolicy,
  ThinkingPolicyCompiler,
  ThinkingPolicyInput,
  ThinkingProfileId,
} from './thinking-policy.ts';

// ── Profile Definitions (4 profiles × 2D grid) ──────────────────────────

interface ProfileSpec {
  thinking: ThinkingConfig;
  oraclePriority: string[];
  baseBudget: number;
}

const PROFILE_DEFINITIONS: Record<ThinkingProfileId, ProfileSpec> = {
  A: {
    // Low-risk, Low-uncertainty → L0 reflex
    thinking: { type: 'disabled' },
    oraclePriority: [],
    baseBudget: 0,
  },
  B: {
    // Low-risk, High-uncertainty → Deep think, light verify
    thinking: { type: 'adaptive', effort: 'high', display: 'summarized' },
    oraclePriority: ['ast', 'lint'],
    baseBudget: 60_000,
  },
  C: {
    // High-risk, Low-uncertainty → Light think, deep verify
    thinking: { type: 'adaptive', effort: 'low', display: 'omitted' },
    oraclePriority: ['ast', 'type', 'dep', 'lint', 'test'],
    baseBudget: 10_000,
  },
  D: {
    // High-risk, High-uncertainty → Deep think + deep verify
    thinking: { type: 'adaptive', effort: 'max', display: 'summarized' },
    oraclePriority: ['ast', 'type', 'dep', 'lint', 'test'],
    baseBudget: 100_000,
  },
};

// ── Exported for testing ─────────────────────────────────────────────────

export { PROFILE_DEFINITIONS };

// ── Profile Selection (deterministic, gap-free — per EA-1 fix) ──────────

export function selectProfile(
  risk: number,
  uncertainty: number,
  thresholds: { riskBoundary: number; uncertaintyBoundary: number },
): ThinkingProfileId {
  const highRisk = risk >= thresholds.riskBoundary;
  const highUncertainty = uncertainty >= thresholds.uncertaintyBoundary;
  if (!highRisk && !highUncertainty) return 'A';
  if (!highRisk && highUncertainty) return 'B';
  if (highRisk && !highUncertainty) return 'C';
  return 'D';
}

// ── Confidence Decay Ceiling (P7 + P9 + A2 fix) ────────────────────────

export function computeThinkingCeiling(
  profileId: ThinkingProfileId,
  confidence: number,
  auditSampleRate = 0.05,
  rng: () => number = Math.random,
): number | undefined {
  if (confidence < 0.4) return undefined; // cold start: no ceiling
  const base = PROFILE_DEFINITIONS[profileId].baseBudget;
  if (base === 0) return 0; // Profile A: no thinking anyway
  if (confidence >= 0.85) {
    // A2 fix: retain 10% budget floor + audit sampling
    return rng() < auditSampleRate
      ? base // audit sample: full budget
      : Math.ceil(base * 0.1); // minimal reinvestigation
  }
  return Math.ceil(base * (1 - confidence));
}

// ── Content-Addressed Observation Key (A4 fix) ──────────────────────────

async function hashFileContent(filePath: string): Promise<string> {
  try {
    const content = await readFile(filePath);
    return createHash('sha256').update(content).digest('hex').slice(0, 16);
  } catch {
    return 'missing';
  }
}

export async function buildObservationKey(taskTypeSignature: string, targetFiles: string[]): Promise<string> {
  if (targetFiles.length === 0) {
    const hash = createHash('sha256').update(taskTypeSignature).digest('hex').slice(0, 16);
    return `${taskTypeSignature}:${hash}`;
  }
  const targetHashes = await Promise.all(targetFiles.map(hashFileContent));
  const contentHash = createHash('sha256').update(targetHashes.sort().join(';')).digest('hex').slice(0, 16);
  return `${taskTypeSignature}:${contentHash}`;
}

// ── Main Compiler Function ──────────────────────────────────────────────

/**
 * T3 (Yinyan kernel activation): when `multiHypothesisEnabled === true`
 * and Profile-D is selected, the compiler emits the multi-hypothesis
 * config that activates the dormant kernel from PR #44. Default-false
 * preserves byte-identical pre-T3 behavior; the calibrator (T5) is the
 * eventual decision-maker that flips this on per task type.
 */
export interface CompilerActivationOptions {
  /** Read from ParameterStore by `DefaultThinkingPolicyCompiler`. */
  multiHypothesisEnabled?: boolean;
  /**
   * T5 (Yinyan per-task-type calibration): snapshot of the
   * `thinking.budget_table` parameter at compile time. Keyed by
   * `${taskTypeSignature}:adaptive:${effort}`. Values are token budgets.
   * When an entry exists for the active `(taskType, mode)` pair the
   * compiler overrides the confidence-decay ceiling with the entry's
   * value. Absent → ceiling falls through to the legacy heuristic.
   */
  budgetTable?: Readonly<Record<string, number>>;
}

export async function compileThinkingPolicy(
  input: ThinkingPolicyInput & { auditSampleRate?: number; activation?: CompilerActivationOptions },
): Promise<ThinkingPolicy> {
  const { riskScore, uncertaintySignal, taskTypeSignature } = input;
  const confidence = input.selfModelConfidence ?? 0.0;
  const thresholds = input.thresholds ?? { riskBoundary: 0.35, uncertaintyBoundary: 0.5 };

  // 1. Select profile from 2D grid (configurable thresholds)
  const profileId = selectProfile(riskScore, uncertaintySignal.score, thresholds);
  const profile = PROFILE_DEFINITIONS[profileId];

  // 2. Apply confidence decay ceiling (10% floor, audit sampling rate from config)
  const ceiling = computeThinkingCeiling(profileId, confidence, input.auditSampleRate);

  // 3. Build content-addressed observation key (A4)
  const observationKey = await buildObservationKey(taskTypeSignature, input.taskInput.targetFiles ?? []);

  // 4. T3 — multi-hypothesis activation. ONLY for Profile-D (highRisk +
  // highUncertainty) AND ONLY when the kill-switch parameter is true. The
  // kernel is wired through PR #44; this branch is what makes it actually
  // fire in production. Other profiles continue with their adaptive /
  // disabled config unchanged.
  let thinking: ThinkingPolicy['thinking'] = profile.thinking;
  if (profileId === 'D' && input.activation?.multiHypothesisEnabled) {
    thinking = {
      type: 'multi-hypothesis',
      branches: 3,
      diversityConstraint: 'different-resources',
      selectionRule: 'highest-oracle-confidence',
      allFailBehavior: 'escalate-level',
      tieBreaker: 'lowest-token-cost',
    };
  }

  // 5. T5 — per-task-type budget table override. When the calibrator has
  // promoted a `(taskType, mode)` entry, that value supersedes the
  // confidence-decay ceiling computed in step 2. The compiler always
  // honors the table because the calibrator's walk-forward backtest +
  // monotonicity guard already enforced safety; the kernel cannot make
  // a more conservative choice here without re-running the backtest.
  // When no entry exists for this `(taskType, mode)` pair the ceiling
  // from step 2 stands unchanged — pre-T5 behavior preserved.
  let calibratedCeiling: number | undefined;
  if (input.activation?.budgetTable && thinking.type === 'adaptive') {
    const key = `${taskTypeSignature}:adaptive:${thinking.effort}`;
    const v = input.activation.budgetTable[key];
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) {
      calibratedCeiling = v;
    }
  }

  return {
    policyBasis: calibratedCeiling !== undefined ? 'calibrated' : confidence >= 0.4 ? 'calibrated' : 'default',
    thinking,
    profileId,
    uncertaintyScore: uncertaintySignal.score,
    riskScore,
    selfModelConfidence: confidence,
    observationKey,
    // T5 wins when the calibrator has a verified per-task-type entry —
    // that ceiling carries the walk-forward + monotonicity guarantees
    // the confidence-decay heuristic cannot replicate.
    thinkingCeiling: calibratedCeiling ?? ceiling,
    taskTypeCalibration: {
      taskTypeSignature,
      minObservationCount: 0,
      basis:
        calibratedCeiling !== undefined
          ? 'calibrated'
          : confidence >= 0.85
            ? 'calibrated'
            : confidence >= 0.4
              ? 'emerging'
              : 'insufficient',
    },
  };
}

// ── Compiler class (implements ThinkingPolicyCompiler interface) ─────────

export class DefaultThinkingPolicyCompiler implements ThinkingPolicyCompiler {
  private readonly thresholds?: { riskBoundary: number; uncertaintyBoundary: number };
  private readonly auditSampleRate?: number;
  /**
   * T3 — when supplied, the compiler reads
   * `thinking.multi_hypothesis_enabled` from this store on every compile
   * and gates Profile-D's `multi-hypothesis` emission on the result. When
   * absent, the kill-switch defaults to OFF — Profile-D continues to emit
   * the legacy `adaptive` config and the kernel stays dormant.
   */
  private readonly parameterStore?: import('../adaptive-params/parameter-store.ts').ParameterStore;

  constructor(config?: {
    thresholds?: { riskBoundary: number; uncertaintyBoundary: number };
    auditSampleRate?: number;
    parameterStore?: import('../adaptive-params/parameter-store.ts').ParameterStore;
  }) {
    this.thresholds = config?.thresholds;
    this.auditSampleRate = config?.auditSampleRate;
    this.parameterStore = config?.parameterStore;
  }

  compile(input: ThinkingPolicyInput): Promise<ThinkingPolicy> {
    // Merge config-level thresholds as defaults (input can still override)
    const multiHypothesisEnabled = this.parameterStore?.getBoolean('thinking.multi_hypothesis_enabled') ?? false;
    // T5 — budget table snapshot. Empty record when no calibrator has run
    // yet (default registry value). The compiler treats absence as
    // "no override" and falls through to the legacy ceiling heuristic.
    const budgetTable = this.parameterStore?.getRecord('thinking.budget_table');
    const merged = {
      ...input,
      thresholds: input.thresholds ?? this.thresholds,
      auditSampleRate: this.auditSampleRate,
      activation: { multiHypothesisEnabled, budgetTable },
    };
    return compileThinkingPolicy(merged);
  }
}
