/**
 * QualityScore — multi-phase quality computation.
 *
 * Phase 0 (2 dims): architecturalCompliance + efficiency
 * Phase 1 (3-4 dims): + simplificationGain + testMutationScore (heuristic)
 *
 * Composite weights adapt to available dimensions.
 * Source of truth: vinyan-tdd.md §10 D10
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { QualityScore, OracleVerdict } from "../core/types.ts";
import { computeCyclomaticComplexity } from "./complexity.ts";

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
  gateDuration_ms: number,
  latencyBudget_ms: number = 2000,
  complexityContext?: ComplexityContext,
  testContext?: TestContext,
  /** Map oracle name → tier string for A5 weighted scoring. */
  oracleTiers?: Record<string, string>,
): QualityScore {
  // Dimension 1: architecturalCompliance (A5 tier-weighted oracle pass ratio)
  const entries = Object.entries(oracleResults);
  let architecturalCompliance: number;
  if (entries.length === 0) {
    architecturalCompliance = 1.0;
  } else if (oracleTiers) {
    let weightedSum = 0;
    let totalWeight = 0;
    for (const [name, verdict] of entries) {
      const tier = oracleTiers[name] ?? "deterministic";
      const weight = TIER_WEIGHTS[tier] ?? 1.0;
      weightedSum += (verdict.verified ? 1 : 0) * weight;
      totalWeight += weight;
    }
    architecturalCompliance = totalWeight > 0 ? weightedSum / totalWeight : 1.0;
  } else {
    architecturalCompliance = entries.filter(([, v]) => v.verified).length / entries.length;
  }

  // Dimension 2: efficiency (latency vs budget)
  const efficiency = Math.max(0, Math.min(1, 1 - gateDuration_ms / latencyBudget_ms));

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

  // Dimension 4: testMutationScore (heuristic based on test existence + pass/fail)
  let testMutationScore: number | undefined;
  if (testContext) {
    if (testContext.testsExist && testContext.testsPassed) {
      testMutationScore = 0.7;
    } else if (testContext.testsExist && !testContext.testsPassed) {
      testMutationScore = 0.3;
    } else {
      testMutationScore = 0.4; // no tests
    }
  }

  // Composite — weights adapt to available dimensions
  const dims = 2 + (simplificationGain != null ? 1 : 0) + (testMutationScore != null ? 1 : 0);
  let composite: number;
  let phase: QualityScore["phase"];

  if (dims === 4) {
    composite =
      architecturalCompliance * 0.30 +
      efficiency * 0.20 +
      simplificationGain! * 0.25 +
      testMutationScore! * 0.25;
    phase = "phase1";
  } else if (dims === 3 && simplificationGain != null) {
    composite =
      architecturalCompliance * 0.35 +
      efficiency * 0.25 +
      simplificationGain * 0.40;
    phase = "phase1";
  } else if (dims === 3 && testMutationScore != null) {
    composite =
      architecturalCompliance * 0.35 +
      efficiency * 0.25 +
      testMutationScore * 0.40;
    phase = "phase1";
  } else {
    composite = architecturalCompliance * 0.6 + efficiency * 0.4;
    phase = "phase0";
  }

  return {
    architecturalCompliance,
    efficiency,
    ...(simplificationGain != null ? { simplificationGain } : {}),
    ...(testMutationScore != null ? { testMutationScore } : {}),
    composite,
    dimensions_available: dims,
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
      originals.push(readFileSync(join(workspace, m.file), "utf-8"));
    } catch {
      originals.push(""); // new file — neutral
    }
  }

  return {
    originalSource: originals.join("\n"),
    mutatedSource: mutated.join("\n"),
  };
}
