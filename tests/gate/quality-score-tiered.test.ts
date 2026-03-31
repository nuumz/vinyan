import { describe, test, expect } from "bun:test";
import { computeQualityScore } from "../../src/gate/quality-score.ts";
import { buildVerdict } from "../../src/core/index.ts";

function makeVerdict(verified: boolean) {
  return buildVerdict({
    verified,
    type: verified ? "known" : "unknown",
    confidence: verified ? 1.0 : 0,
    evidence: [],
    fileHashes: {},
    duration_ms: 10,
  });
}

describe("computeQualityScore — tiered trust (A5)", () => {
  test("deterministic oracle gets higher weight than heuristic in compliance", () => {
    const results = {
      ast: makeVerdict(true),   // deterministic, passes
      lint: makeVerdict(false), // heuristic, fails
    };
    const tiers = { ast: "deterministic", lint: "heuristic" };

    const tiered = computeQualityScore(results, 100, 2000, undefined, undefined, tiers);
    // weighted: (1*1.0 + 0*0.7) / (1.0 + 0.7) = 1.0 / 1.7 ≈ 0.588
    expect(tiered.architecturalCompliance).toBeCloseTo(1.0 / 1.7, 5);
  });

  test("deterministic passing + heuristic failing → compliance > 0.5", () => {
    const results = {
      type: makeVerdict(true),  // deterministic
      lint: makeVerdict(false), // heuristic
    };
    const tiers = { type: "deterministic", lint: "heuristic" };

    const qs = computeQualityScore(results, 100, 2000, undefined, undefined, tiers);
    expect(qs.architecturalCompliance).toBeGreaterThan(0.5);
  });

  test("backward compat: no oracleTiers uses equal weight", () => {
    const results = {
      ast: makeVerdict(true),
      type: makeVerdict(false),
    };

    const withoutTiers = computeQualityScore(results, 100);
    // Equal weight: 1 pass / 2 total = 0.5
    expect(withoutTiers.architecturalCompliance).toBe(0.5);
  });

  test("equal-weight result matches no-tiers result when all tiers are same", () => {
    const results = {
      ast: makeVerdict(true),
      type: makeVerdict(true),
      dep: makeVerdict(false),
    };
    const tiers = { ast: "deterministic", type: "deterministic", dep: "deterministic" };

    const withTiers = computeQualityScore(results, 100, 2000, undefined, undefined, tiers);
    const withoutTiers = computeQualityScore(results, 100);
    // Same weights → same compliance
    expect(withTiers.architecturalCompliance).toBeCloseTo(withoutTiers.architecturalCompliance, 5);
  });

  test("mixed tiers with all passing → compliance 1.0 regardless of tier", () => {
    const results = {
      ast: makeVerdict(true),
      lint: makeVerdict(true),
    };
    const tiers = { ast: "deterministic", lint: "speculative" };

    const qs = computeQualityScore(results, 100, 2000, undefined, undefined, tiers);
    expect(qs.architecturalCompliance).toBe(1.0);
  });
});
