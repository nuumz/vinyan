/**
 * QualityScore — multi-phase quality computation.
 *
 * Phase 0 (2 dims): architecturalCompliance + efficiency
 * Phase 1 (3-4 dims): + simplificationGain + testMutationScore (heuristic)
 *
 * Composite weights adapt to available dimensions.
 * Source of truth: vinyan-tdd.md §10 D10
 */
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

export function computeQualityScore(
  oracleResults: Record<string, OracleVerdict>,
  gateDuration_ms: number,
  latencyBudget_ms: number = 2000,
  complexityContext?: ComplexityContext,
  testContext?: TestContext,
): QualityScore {
  // Dimension 1: architecturalCompliance (oracle pass ratio)
  const entries = Object.values(oracleResults);
  const architecturalCompliance =
    entries.length > 0 ? entries.filter((v) => v.verified).length / entries.length : 1.0;

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
