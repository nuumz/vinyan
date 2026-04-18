/**
 * QualityScore — multi-phase quality computation.
 *
 * Phase 0 (2 dims): architecturalCompliance + efficiency
 * Phase 1 (3-4 dims): + simplificationGain + testMutationScore (heuristic)
 *
 * Composite weights adapt to available dimensions.
 * Source of truth: spec/tdd.md §10 D10
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { OracleVerdict, QualityScore } from '../core/types.ts';
import { computeCyclomaticComplexity } from './complexity.ts';

export interface ComplexityContext {
  originalSource?: string;
  mutatedSource?: string;
}

export interface TestContext {
  testsExist: boolean;
  testsPassed?: boolean;
}

/** A5: Tiered trust weights — deterministic evidence outweighs heuristic/probabilistic. */
const TIER_WEIGHTS: Record<string, number> = {
  deterministic: 1.0,
  heuristic: 0.7,
  probabilistic: 0.4,
  speculative: 0.2,
};

export function computeQualityScore(
  oracleResults: Record<string, OracleVerdict>,
  gateDurationMs: number,
  latencyBudgetMs: number = 2000,
  complexityContext?: ComplexityContext,
  testContext?: TestContext,
  /** Map oracle name → tier string for A5 weighted scoring. */
  oracleTiers?: Record<string, string>,
  /** Phase 4.10: SL projected probability override for architecturalCompliance. */
  fusedConfidence?: number,
): QualityScore {
  // Dimension 1: architecturalCompliance (A5 tier-weighted oracle pass ratio)
  const entries = Object.entries(oracleResults);

  // Dimension 2: efficiency (latency vs budget) — computed early for zero-oracle exit path.
  const efficiency = Math.max(0, Math.min(1, 1 - gateDurationMs / latencyBudgetMs));

  let architecturalCompliance: number;
  if (entries.length === 0) {
    // Zero oracle verdicts — either no mutations (trivially safe) or all oracles abstained.
    // unverified: true preserves the signal that no structural oracle ran.
    // Composite capped at 0.5 to prevent inflated quality for unverified tasks.
    // Without oracle evidence, quality is epistemically unknown — we report the latency signal
    // but cap composite so it doesn't feed misleading A7 calibration signals.
    return {
      architecturalCompliance: 0.5,
      efficiency,
      composite: Math.min(0.5, efficiency * 0.4 + 0.5 * 0.1),
      dimensionsAvailable: 1,
      phase: 'basic',
      unverified: true,
    };
  } else if (oracleTiers) {
    let weightedSum = 0;
    let totalWeight = 0;
    for (const [name, verdict] of entries) {
      const tier = oracleTiers[name] ?? 'deterministic';
      const weight = TIER_WEIGHTS[tier] ?? 1.0;
      weightedSum += (verdict.verified ? 1 : 0) * weight;
      totalWeight += weight;
    }
    architecturalCompliance = totalWeight > 0 ? weightedSum / totalWeight : 1.0;
  } else {
    architecturalCompliance = entries.filter(([, v]) => v.verified).length / entries.length;
  }

  // Phase 4.10: Override architecturalCompliance with SL projected probability when available
  if (fusedConfidence != null && !Number.isNaN(fusedConfidence)) {
    architecturalCompliance = fusedConfidence;
  }

  // Dimension 3: simplificationGain (cyclomatic complexity reduction)
  let simplificationGain: number | undefined;
  if (complexityContext?.originalSource != null && complexityContext?.mutatedSource != null) {
    if (!complexityContext.originalSource.trim()) {
      simplificationGain = 0.5; // new file — neutral
    } else {
      const before = computeCyclomaticComplexity(complexityContext.originalSource);
      const after = computeCyclomaticComplexity(complexityContext.mutatedSource);
      simplificationGain = Math.max(0, Math.min(1, 1 - after / before));
    }
  }

  // Dimension 4: testPresenceHeuristic (heuristic based on test existence + pass/fail)
  let testPresenceHeuristic: number | undefined;
  if (testContext) {
    if (testContext.testsExist && testContext.testsPassed) {
      testPresenceHeuristic = 0.7;
    } else if (testContext.testsExist && !testContext.testsPassed) {
      testPresenceHeuristic = 0.3;
    } else {
      testPresenceHeuristic = 0.4; // no tests
    }
  }

  // Composite — weights adapt to available dimensions
  const dims = 2 + (simplificationGain != null ? 1 : 0) + (testPresenceHeuristic != null ? 1 : 0);
  let composite: number;
  let phase: QualityScore['phase'];

  if (dims === 4) {
    composite =
      architecturalCompliance * 0.3 + efficiency * 0.2 + simplificationGain! * 0.25 + testPresenceHeuristic! * 0.25;
    phase = 'extended';
  } else if (dims === 3 && simplificationGain != null) {
    composite = architecturalCompliance * 0.35 + efficiency * 0.25 + simplificationGain * 0.4;
    phase = 'extended';
  } else if (dims === 3 && testPresenceHeuristic != null) {
    composite = architecturalCompliance * 0.35 + efficiency * 0.25 + testPresenceHeuristic * 0.4;
    phase = 'extended';
  } else {
    composite = architecturalCompliance * 0.6 + efficiency * 0.4;
    phase = 'basic';
  }

  return {
    architecturalCompliance,
    efficiency,
    ...(simplificationGain != null ? { simplificationGain } : {}),
    ...(testPresenceHeuristic != null ? { testPresenceHeuristic } : {}),
    composite,
    dimensionsAvailable: dims,
    phase,
  };
}

/**
 * Build ComplexityContext from worker mutations by reading original files.
 * Returns undefined if no mutations or files are unreadable.
 */
export function buildComplexityContext(
  mutations: Array<{ file: string; content: string }>,
  workspace: string,
): ComplexityContext | undefined {
  if (mutations.length === 0) return undefined;

  const originals: string[] = [];
  const mutated: string[] = [];

  for (const m of mutations) {
    mutated.push(m.content);
    try {
      originals.push(readFileSync(join(workspace, m.file), 'utf-8'));
    } catch {
      originals.push(''); // new file — neutral
    }
  }

  return {
    originalSource: originals.join('\n'),
    mutatedSource: mutated.join('\n'),
  };
}

// ── Pipeline-split helpers (DE4) ────────────────────────────────────

/**
 * Compute architecturalCompliance directly from oracle verdicts.
 * Extracted from computeQualityScore Dimension 1 for reuse in post-fusion recalibration.
 */
export function computeFromVerdicts(
  oracleResults: Record<string, OracleVerdict>,
  oracleTiers?: Record<string, string>,
): number {
  const entries = Object.entries(oracleResults);
  if (entries.length === 0) return 0.5; // unknown = maximum uncertainty (A2)

  if (oracleTiers) {
    let weightedSum = 0;
    let totalWeight = 0;
    for (const [name, verdict] of entries) {
      const tier = oracleTiers[name] ?? 'deterministic';
      const weight = TIER_WEIGHTS[tier] ?? 1.0;
      weightedSum += (verdict.verified ? 1 : 0) * weight;
      totalWeight += weight;
    }
    return totalWeight > 0 ? weightedSum / totalWeight : 0.5;
  }

  return entries.filter(([, v]) => v.verified).length / entries.length;
}

/**
 * Recalibrate a QualityScore with SL fused probability (post-conflict-resolution).
 * Replaces architecturalCompliance with fusedConfidence and recomputes composite.
 * DE4: Quality score reflects epistemic state after fusion, not just raw pass/fail ratios.
 */
export function recalibrateWithFusion(
  score: QualityScore,
  fusedConfidence: number,
): QualityScore {
  const architecturalCompliance = fusedConfidence;
  const dims = score.dimensionsAvailable;

  let composite: number;
  if (dims === 4) {
    composite =
      architecturalCompliance * 0.3 +
      score.efficiency * 0.2 +
      (score.simplificationGain ?? 0) * 0.25 +
      (score.testPresenceHeuristic ?? 0) * 0.25;
  } else if (dims === 3 && score.simplificationGain != null) {
    composite = architecturalCompliance * 0.35 + score.efficiency * 0.25 + score.simplificationGain * 0.4;
  } else if (dims === 3 && score.testPresenceHeuristic != null) {
    composite = architecturalCompliance * 0.35 + score.efficiency * 0.25 + score.testPresenceHeuristic * 0.4;
  } else {
    composite = architecturalCompliance * 0.6 + score.efficiency * 0.4;
  }

  return {
    ...score,
    architecturalCompliance,
    composite,
  };
}
