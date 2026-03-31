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
    duration_ms: 100,
  });
}

describe("computeQualityScore", () => {
  test("all oracles pass → compliance 1.0", () => {
    const results = {
      ast: makeVerdict(true),
      type: makeVerdict(true),
      dep: makeVerdict(true),
    };
    const qs = computeQualityScore(results, 100);
    expect(qs.architecturalCompliance).toBe(1.0);
    expect(qs.phase).toBe("phase0");
    expect(qs.dimensions_available).toBe(2);
  });

  test("mixed results → proportional compliance", () => {
    const results = {
      ast: makeVerdict(true),
      type: makeVerdict(false),
      dep: makeVerdict(true),
    };
    const qs = computeQualityScore(results, 100);
    expect(qs.architecturalCompliance).toBeCloseTo(2 / 3, 5);
  });

  test("all oracles fail → compliance 0.0", () => {
    const results = {
      type: makeVerdict(false),
    };
    const qs = computeQualityScore(results, 100);
    expect(qs.architecturalCompliance).toBe(0);
  });

  test("no oracles → compliance 1.0 (vacuously true)", () => {
    const qs = computeQualityScore({}, 100);
    expect(qs.architecturalCompliance).toBe(1.0);
  });

  test("fast gate → high efficiency", () => {
    const qs = computeQualityScore({ ast: makeVerdict(true) }, 100, 2000);
    expect(qs.efficiency).toBeCloseTo(0.95, 2);
  });

  test("slow gate → low efficiency", () => {
    const qs = computeQualityScore({ ast: makeVerdict(true) }, 1800, 2000);
    expect(qs.efficiency).toBeCloseTo(0.1, 2);
  });

  test("over-budget gate → efficiency clamped to 0", () => {
    const qs = computeQualityScore({ ast: makeVerdict(true) }, 3000, 2000);
    expect(qs.efficiency).toBe(0);
  });

  test("composite = compliance * 0.6 + efficiency * 0.4 (phase0)", () => {
    // Use non-trivial inputs to verify actual weight formula (not 1.0 * any_weight = 1.0)
    const results = {
      ast: makeVerdict(true),
      type: makeVerdict(false), // compliance = 1/2 = 0.5
    };
    // duration=400, budget=2000 → efficiency = 1 - 400/2000 = 0.8
    const qs = computeQualityScore(results, 400, 2000);
    expect(qs.architecturalCompliance).toBeCloseTo(0.5, 5);
    expect(qs.efficiency).toBeCloseTo(0.8, 5);
    // composite = 0.5 * 0.6 + 0.8 * 0.4 = 0.62
    expect(qs.composite).toBeCloseTo(0.62, 5);
  });

  // ── Phase 1 dimensions ──────────────────────────────────────────

  test("simplificationGain computed from complexity reduction", () => {
    const original = `function f(x: number) { if (x > 0) { if (x > 10) { return "big"; } return "small"; } return "zero"; }`;
    const mutated = `function f(x: number) { return x > 0 ? "positive" : "zero"; }`;
    const qs = computeQualityScore(
      { ast: makeVerdict(true) }, 100, 2000,
      { originalSource: original, mutatedSource: mutated },
    );
    expect(qs.simplificationGain).toBeDefined();
    expect(qs.simplificationGain!).toBeGreaterThan(0);
    expect(qs.simplificationGain!).toBeLessThanOrEqual(1);
    expect(qs.dimensions_available).toBe(3);
    expect(qs.phase).toBe("phase1");
  });

  test("no complexity change → simplificationGain = 0", () => {
    const source = `function f() { return 1; }`;
    const qs = computeQualityScore(
      { ast: makeVerdict(true) }, 100, 2000,
      { originalSource: source, mutatedSource: source },
    );
    expect(qs.simplificationGain).toBe(0);
  });

  test("complexity increase → simplificationGain = 0 (clamped)", () => {
    const simple = `function f() { return 1; }`;
    const complex = `function f(x: number) { if (x > 0) { for (let i = 0; i < x; i++) {} } return 1; }`;
    const qs = computeQualityScore(
      { ast: makeVerdict(true) }, 100, 2000,
      { originalSource: simple, mutatedSource: complex },
    );
    expect(qs.simplificationGain).toBe(0);
  });

  test("new file (empty original) → simplificationGain = 0.5", () => {
    const qs = computeQualityScore(
      { ast: makeVerdict(true) }, 100, 2000,
      { originalSource: "", mutatedSource: `function f() { return 1; }` },
    );
    expect(qs.simplificationGain).toBe(0.5);
  });

  test("testMutationScore heuristic: tests exist + pass → 0.7", () => {
    const qs = computeQualityScore(
      { ast: makeVerdict(true) }, 100, 2000,
      undefined,
      { testsExist: true, testsPassed: true },
    );
    expect(qs.testMutationScore).toBe(0.7);
    expect(qs.dimensions_available).toBe(3);
    expect(qs.phase).toBe("phase1");
  });

  test("testMutationScore heuristic: tests exist + fail → 0.3", () => {
    const qs = computeQualityScore(
      { ast: makeVerdict(true) }, 100, 2000,
      undefined,
      { testsExist: true, testsPassed: false },
    );
    expect(qs.testMutationScore).toBe(0.3);
  });

  test("testMutationScore heuristic: no tests → 0.4", () => {
    const qs = computeQualityScore(
      { ast: makeVerdict(true) }, 100, 2000,
      undefined,
      { testsExist: false },
    );
    expect(qs.testMutationScore).toBe(0.4);
  });

  test("4 dimensions: composite uses phase1 weights", () => {
    const original = `function f(x: number) { if (x > 0) { if (x > 10) { return "big"; } return "small"; } return "zero"; }`;
    const mutated = `function f(x: number) { return x > 0 ? "positive" : "zero"; }`;
    const qs = computeQualityScore(
      { ast: makeVerdict(true) }, 0, 2000,
      { originalSource: original, mutatedSource: mutated },
      { testsExist: true, testsPassed: true },
    );
    expect(qs.dimensions_available).toBe(4);
    expect(qs.phase).toBe("phase1");
    // Verify composite = arch*0.30 + eff*0.20 + simp*0.25 + test*0.25
    const expected =
      qs.architecturalCompliance * 0.30 +
      qs.efficiency * 0.20 +
      qs.simplificationGain! * 0.25 +
      qs.testMutationScore! * 0.25;
    expect(qs.composite).toBeCloseTo(expected, 5);
  });

  test("no extra context → backward compatible phase0", () => {
    const qs = computeQualityScore({ ast: makeVerdict(true) }, 100, 2000);
    expect(qs.dimensions_available).toBe(2);
    expect(qs.phase).toBe("phase0");
    expect(qs.simplificationGain).toBeUndefined();
    expect(qs.testMutationScore).toBeUndefined();
  });
});
