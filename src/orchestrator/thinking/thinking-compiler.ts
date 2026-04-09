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
  A: { // Low-risk, Low-uncertainty → L0 reflex
    thinking: { type: 'disabled' },
    oraclePriority: [],
    baseBudget: 0,
  },
  B: { // Low-risk, High-uncertainty → Deep think, light verify
    thinking: { type: 'adaptive', effort: 'high', display: 'summarized' },
    oraclePriority: ['ast', 'lint'],
    baseBudget: 60_000,
  },
  C: { // High-risk, Low-uncertainty → Light think, deep verify
    thinking: { type: 'adaptive', effort: 'low', display: 'omitted' },
    oraclePriority: ['ast', 'type', 'dep', 'lint', 'test'],
    baseBudget: 10_000,
  },
  D: { // High-risk, High-uncertainty → Deep think + deep verify
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
      ? base                           // audit sample: full budget
      : Math.ceil(base * 0.10);       // minimal reinvestigation
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

export async function buildObservationKey(
  taskTypeSignature: string,
  targetFiles: string[],
): Promise<string> {
  if (targetFiles.length === 0) {
    const hash = createHash('sha256').update(taskTypeSignature).digest('hex').slice(0, 16);
    return `${taskTypeSignature}:${hash}`;
  }
  const targetHashes = await Promise.all(targetFiles.map(hashFileContent));
  const contentHash = createHash('sha256')
    .update(targetHashes.sort().join(';'))
    .digest('hex')
    .slice(0, 16);
  return `${taskTypeSignature}:${contentHash}`;
}

// ── Main Compiler Function ──────────────────────────────────────────────

export async function compileThinkingPolicy(
  input: ThinkingPolicyInput & { auditSampleRate?: number },
): Promise<ThinkingPolicy> {
  const { riskScore, uncertaintySignal, taskTypeSignature } = input;
  const confidence = input.selfModelConfidence ?? 0.0;
  const thresholds = input.thresholds ?? { riskBoundary: 0.35, uncertaintyBoundary: 0.50 };

  // 1. Select profile from 2D grid (configurable thresholds)
  const profileId = selectProfile(riskScore, uncertaintySignal.score, thresholds);
  const profile = PROFILE_DEFINITIONS[profileId];

  // 2. Apply confidence decay ceiling (10% floor, audit sampling rate from config)
  const ceiling = computeThinkingCeiling(profileId, confidence, input.auditSampleRate);

  // 3. Build content-addressed observation key (A4)
  const observationKey = await buildObservationKey(
    taskTypeSignature, input.taskInput.targetFiles ?? [],
  );

  return {
    policyBasis: confidence >= 0.4 ? 'calibrated' : 'default',
    thinking: profile.thinking,
    profileId,
    uncertaintyScore: uncertaintySignal.score,
    riskScore,
    selfModelConfidence: confidence,
    observationKey,
    thinkingCeiling: ceiling,
    taskTypeCalibration: {
      taskTypeSignature,
      minObservationCount: 0,
      basis: confidence >= 0.85 ? 'calibrated'
        : confidence >= 0.4 ? 'emerging' : 'insufficient',
    },
  };
}

// ── Compiler class (implements ThinkingPolicyCompiler interface) ─────────

export class DefaultThinkingPolicyCompiler implements ThinkingPolicyCompiler {
  private readonly thresholds?: { riskBoundary: number; uncertaintyBoundary: number };
  private readonly auditSampleRate?: number;

  constructor(config?: {
    thresholds?: { riskBoundary: number; uncertaintyBoundary: number };
    auditSampleRate?: number;
  }) {
    this.thresholds = config?.thresholds;
    this.auditSampleRate = config?.auditSampleRate;
  }

  compile(input: ThinkingPolicyInput): Promise<ThinkingPolicy> {
    // Merge config-level thresholds as defaults (input can still override)
    const merged = {
      ...input,
      thresholds: input.thresholds ?? this.thresholds,
      auditSampleRate: this.auditSampleRate,
    };
    return compileThinkingPolicy(merged);
  }
}
