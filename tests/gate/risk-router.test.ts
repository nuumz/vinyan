import { describe, test, expect } from "bun:test";
import {
  calculateRiskScore,
  routeByRisk,
  getIrreversibilityScore,
  detectEnvironment,
} from "../../src/gate/risk-router.ts";
import type { RiskFactors } from "../../src/orchestrator/types.ts";

function makeFactors(overrides: Partial<RiskFactors> = {}): RiskFactors {
  return {
    blastRadius: 1,
    dependencyDepth: 1,
    testCoverage: 0.8,
    fileVolatility: 5,
    irreversibility: 0.0,
    hasSecurityImplication: false,
    environmentType: "development",
    ...overrides,
  };
}

describe("calculateRiskScore", () => {
  test("minimal input → low score (near 0)", () => {
    const score = calculateRiskScore(makeFactors({
      blastRadius: 0,
      dependencyDepth: 0,
      testCoverage: 1.0,
      fileVolatility: 0,
      irreversibility: 0,
    }));
    expect(score).toBeCloseTo(0, 1);
    expect(score).toBeGreaterThanOrEqual(0);
  });

  test("maximal input → high score (near 1.0)", () => {
    const score = calculateRiskScore(makeFactors({
      blastRadius: 50,
      dependencyDepth: 10,
      testCoverage: 0,
      fileVolatility: 30,
      irreversibility: 1.0,
      hasSecurityImplication: true,
      environmentType: "production",
    }));
    expect(score).toBe(1.0);
  });

  test("production + irreversibility > 0.5 → guardrail floor 0.9", () => {
    const score = calculateRiskScore(makeFactors({
      blastRadius: 1,
      dependencyDepth: 1,
      testCoverage: 1.0,
      fileVolatility: 0,
      irreversibility: 0.6,
      environmentType: "production",
    }));
    expect(score).toBeGreaterThanOrEqual(0.9);
  });

  test("production + irreversibility <= 0.5 → no guardrail", () => {
    const score = calculateRiskScore(makeFactors({
      irreversibility: 0.4,
      environmentType: "production",
    }));
    // Should be normal weighted sum, not forced to 0.9
    expect(score).toBeLessThan(0.9);
  });

  test("blast radius weight contribution", () => {
    const low = calculateRiskScore(makeFactors({ blastRadius: 0 }));
    const high = calculateRiskScore(makeFactors({ blastRadius: 50 }));
    expect(high - low).toBeCloseTo(0.25, 2); // 0.25 weight
  });

  test("irreversibility weight contribution", () => {
    const low = calculateRiskScore(makeFactors({ irreversibility: 0 }));
    const high = calculateRiskScore(makeFactors({ irreversibility: 1.0 }));
    expect(high - low).toBeCloseTo(0.20, 2); // 0.20 weight
  });

  test("test coverage inversely correlates with risk", () => {
    const covered = calculateRiskScore(makeFactors({ testCoverage: 1.0 }));
    const uncovered = calculateRiskScore(makeFactors({ testCoverage: 0 }));
    expect(uncovered).toBeGreaterThan(covered);
    expect(uncovered - covered).toBeCloseTo(0.15, 2); // 0.15 weight
  });

  test("security flag adds 0.10", () => {
    const noSec = calculateRiskScore(makeFactors({ hasSecurityImplication: false }));
    const sec = calculateRiskScore(makeFactors({ hasSecurityImplication: true }));
    expect(sec - noSec).toBeCloseTo(0.10, 2);
  });

  test("score clamped to [0, 1]", () => {
    const score = calculateRiskScore(makeFactors({
      blastRadius: 999,
      dependencyDepth: 999,
      testCoverage: 0,
      fileVolatility: 999,
      irreversibility: 1.0,
      hasSecurityImplication: true,
      environmentType: "production",
    }));
    expect(score).toBeLessThanOrEqual(1.0);
    expect(score).toBeGreaterThanOrEqual(0);
  });
});

describe("routeByRisk", () => {
  test("score ≤ 0.2 → L0", () => {
    const decision = routeByRisk(0.1, 1);
    expect(decision.level).toBe(0);
    expect(decision.model).toBeNull();
  });

  test("score 0.2-0.4 → L1", () => {
    const decision = routeByRisk(0.3, 1);
    expect(decision.level).toBe(1);
  });

  test("score 0.4-0.7 → L2", () => {
    const decision = routeByRisk(0.5, 1);
    expect(decision.level).toBe(2);
  });

  test("score > 0.7 → L3", () => {
    const decision = routeByRisk(0.8, 1);
    expect(decision.level).toBe(3);
  });

  test("boundary: exactly 0.2 → L0", () => {
    expect(routeByRisk(0.2, 1).level).toBe(0);
  });

  test("boundary: exactly 0.4 → L1", () => {
    expect(routeByRisk(0.4, 1).level).toBe(1);
  });

  test("boundary: exactly 0.7 → L2", () => {
    expect(routeByRisk(0.7, 1).level).toBe(2);
  });

  test("hard floor: blast radius > 1 → minimum L1", () => {
    const decision = routeByRisk(0.1, 5); // Would be L0 but blast > 1
    expect(decision.level).toBe(1);
  });

  test("hard floor: blast radius = 1 → no floor", () => {
    const decision = routeByRisk(0.1, 1);
    expect(decision.level).toBe(0);
  });

  test("custom thresholds", () => {
    const decision = routeByRisk(0.3, 1, {
      l0_max_risk: 0.5,
      l1_max_risk: 0.6,
      l2_max_risk: 0.8,
    });
    expect(decision.level).toBe(0); // 0.3 ≤ 0.5
  });

  test("routing decision includes budget", () => {
    const d = routeByRisk(0.5, 1);
    expect(d.budgetTokens).toBeGreaterThan(0);
    expect(d.latencyBudget_ms).toBeGreaterThan(0);
  });
});

describe("getIrreversibilityScore", () => {
  test("file write → 0.0", () => {
    expect(getIrreversibilityScore("write_file")).toBe(0.0);
  });

  test("delete_file → 0.3", () => {
    expect(getIrreversibilityScore("delete_file")).toBe(0.3);
  });

  test("run_terminal_command → 0.5", () => {
    expect(getIrreversibilityScore("run_terminal_command")).toBe(0.5);
  });

  test("unknown tool → 0.5 (conservative)", () => {
    expect(getIrreversibilityScore("unknown_tool")).toBe(0.5);
  });
});

describe("detectEnvironment", () => {
  test("returns development by default", () => {
    const original = process.env.NODE_ENV;
    delete process.env.NODE_ENV;
    delete process.env.VINYAN_ENV;
    expect(detectEnvironment()).toBe("development");
    if (original) process.env.NODE_ENV = original;
  });
});
