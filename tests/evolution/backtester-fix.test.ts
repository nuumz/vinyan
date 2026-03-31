import { describe, test, expect } from "bun:test";
import { backtestRule } from "../../src/evolution/backtester.ts";
import type { EvolutionaryRule, ExecutionTrace } from "../../src/orchestrator/types.ts";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeTrace(
  i: number,
  overrides?: Partial<ExecutionTrace>,
): ExecutionTrace {
  return {
    id: `t-${i}`,
    taskId: `task-${i}`,
    timestamp: 1000 + i * 100,
    routingLevel: 1,
    approach: "default",
    oracleVerdicts: { type: true },
    model_used: "mock",
    tokens_consumed: 100,
    duration_ms: 500,
    outcome: "success",
    affected_files: ["src/foo.ts"],
    ...overrides,
  };
}

function makeGlobRule(filePattern: string): EvolutionaryRule {
  return {
    id: "test-rule",
    source: "sleep-cycle",
    condition: { file_pattern: filePattern },
    action: "escalate",
    parameters: { toLevel: 2 },
    effectiveness: 0.5,
    specificity: 1,
    status: "probation",
    created_at: Date.now(),
  };
}

// Build a set of N traces sorted by timestamp, with the last 20% as failures
// that the rule will match.
function makeTraceSet(n: number, affectedFiles: string[]): ExecutionTrace[] {
  const splitIdx = Math.floor(n * 0.8);
  return Array.from({ length: n }, (_, i) => {
    const isValidationFailure = i >= splitIdx;
    return makeTrace(i, {
      outcome: isValidationFailure ? "failure" : "success",
      affected_files: affectedFiles,
    });
  });
}

// ── Anti-lookahead tests ──────────────────────────────────────────────────────

describe("backtestRule — anti-lookahead", () => {
  test("traces with duplicate timestamps at the split boundary are filtered from validation set", () => {
    // Build 10 traces where traces 8 and 9 share the same timestamp as trace 7
    // (the last training trace). After filtering, validation should be empty → pass: false.
    const sharedTimestamp = 1700;
    const traces: ExecutionTrace[] = [];

    // Traces 0–7: training set with distinct timestamps
    for (let i = 0; i < 8; i++) {
      traces.push(makeTrace(i, { timestamp: 1000 + i * 100, outcome: "success" }));
    }
    // Traces 8–9: same timestamp as trace 7 (the boundary) → should be filtered
    traces.push(makeTrace(8, { timestamp: sharedTimestamp, outcome: "failure" }));
    traces.push(makeTrace(9, { timestamp: sharedTimestamp, outcome: "failure" }));

    // Confirm trace 7 has the sharedTimestamp
    traces[7]!.timestamp = sharedTimestamp;

    const rule = makeGlobRule("*.ts");
    const result = backtestRule(rule, traces);

    // All validation traces share timestamp with training max → filtered out → validationSize=0 → pass=false
    expect(result.pass).toBe(false);
    expect(result.validationSize).toBe(0);
  });

  test("if all validation traces have same timestamp as training max, returns pass: false", () => {
    const commonTimestamp = 9999;
    const traces: ExecutionTrace[] = [];

    // 8 training traces with increasing timestamps
    for (let i = 0; i < 8; i++) {
      traces.push(makeTrace(i, { timestamp: 1000 + i * 100, outcome: "success" }));
    }
    // The last training trace has the same timestamp we'll use for validation
    traces[7]!.timestamp = commonTimestamp;

    // 2 validation traces with same timestamp as training max
    traces.push(makeTrace(8, { timestamp: commonTimestamp, outcome: "failure" }));
    traces.push(makeTrace(9, { timestamp: commonTimestamp, outcome: "failure" }));

    const rule = makeGlobRule("*.ts");
    const result = backtestRule(rule, traces);

    expect(result.pass).toBe(false);
    expect(result.validationSize).toBe(0);
  });
});

// ── Glob anchoring tests ──────────────────────────────────────────────────────

describe("backtestRule — glob anchoring", () => {
  test("pattern src/*.ts does NOT match bad-src/foo.ts", () => {
    // Build enough traces (≥5) so the backtester runs
    // All validation failures have bad-src/foo.ts — the rule should NOT apply → prevented=0 → pass=false
    const traces = makeTraceSet(10, ["bad-src/foo.ts"]);
    const rule = makeGlobRule("src/*.ts");
    const result = backtestRule(rule, traces);

    // The glob should not match bad-src/foo.ts, so no failures are prevented
    expect(result.prevented).toBe(0);
    // pass=false because effectiveness < 0.5
    expect(result.pass).toBe(false);
  });

  test("pattern src/*.ts DOES match src/foo.ts", () => {
    // Build enough traces (≥5) with files matching the pattern
    // All validation failures have src/foo.ts — the rule should apply → prevented > 0
    const traces = makeTraceSet(10, ["src/foo.ts"]);
    const rule = makeGlobRule("src/*.ts");
    const result = backtestRule(rule, traces);

    // The glob matches src/foo.ts
    expect(result.prevented).toBeGreaterThan(0);
  });
});
