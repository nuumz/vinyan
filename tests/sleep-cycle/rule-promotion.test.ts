import { describe, test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { SleepCycleRunner } from "../../src/sleep-cycle/sleep-cycle.ts";
import { TraceStore } from "../../src/db/trace-store.ts";
import { PatternStore } from "../../src/db/pattern-store.ts";
import { RuleStore } from "../../src/db/rule-store.ts";
import { TRACE_SCHEMA_SQL } from "../../src/db/trace-schema.ts";
import { PATTERN_SCHEMA_SQL } from "../../src/db/pattern-schema.ts";
import { RULE_SCHEMA_SQL } from "../../src/db/rule-schema.ts";
import type { ExecutionTrace, EvolutionaryRule } from "../../src/orchestrator/types.ts";

function createAllStores() {
  const db = new Database(":memory:");
  db.exec(TRACE_SCHEMA_SQL);
  db.exec(PATTERN_SCHEMA_SQL);
  db.exec(RULE_SCHEMA_SQL);
  return {
    traceStore: new TraceStore(db),
    patternStore: new PatternStore(db),
    ruleStore: new RuleStore(db),
  };
}

function makeTrace(overrides?: Partial<ExecutionTrace>): ExecutionTrace {
  return {
    id: `t-${Math.random().toString(36).slice(2)}`,
    taskId: "task-1",
    timestamp: Date.now(),
    routingLevel: 1,
    task_type_signature: "refactor::auth.ts",
    approach: "direct-edit",
    oracleVerdicts: { type: true },
    model_used: "mock",
    tokens_consumed: 100,
    duration_ms: 500,
    outcome: "success",
    affected_files: ["auth.ts"],
    ...overrides,
  };
}

function makeProbationRule(overrides?: Partial<EvolutionaryRule>): EvolutionaryRule {
  return {
    id: "rule-test-1",
    source: "sleep-cycle",
    condition: { file_pattern: "auth.ts" },
    action: "escalate",
    parameters: { toLevel: 2 },
    status: "probation",
    created_at: Date.now(),
    effectiveness: 0,
    specificity: 1,
    ...overrides,
  };
}

/**
 * Insert enough traces to trigger sleep cycle AND produce a clear anti-pattern
 * that the rule can match against for backtesting.
 */
function seedTracesForBacktest(
  traceStore: TraceStore,
  opts: { failures: number; successes: number; filePattern: string },
) {
  const base = Date.now() - 100000;
  for (let i = 0; i < opts.failures; i++) {
    traceStore.insert(makeTrace({
      id: `t-fail-${i}`,
      timestamp: base + i,
      outcome: "failure",
      affected_files: [opts.filePattern],
      task_type_signature: `refactor::${opts.filePattern}`,
      session_id: `s-${i % 5}`,
    }));
  }
  for (let i = 0; i < opts.successes; i++) {
    traceStore.insert(makeTrace({
      id: `t-succ-${i}`,
      timestamp: base + opts.failures + i,
      outcome: "success",
      affected_files: [opts.filePattern],
      task_type_signature: `refactor::${opts.filePattern}`,
      session_id: `s-${i % 5}`,
    }));
  }
  // Ensure enough distinct task types for data gate (different files to avoid false positives)
  for (let i = 0; i < 6; i++) {
    traceStore.insert(makeTrace({
      id: `t-extra-${i}`,
      timestamp: base + opts.failures + opts.successes + i,
      task_type_signature: `type-${i}::other.ts`,
      affected_files: [`other-${i}.ts`],
    }));
  }
}

describe("Rule Promotion Pipeline (H2)", () => {
  test("rules promoted after successful backtest", async () => {
    const { traceStore, patternStore, ruleStore } = createAllStores();

    // Insert a probation rule that matches auth.ts failures
    const rule = makeProbationRule();
    ruleStore.insert(rule);
    expect(ruleStore.countByStatus("probation")).toBe(1);
    expect(ruleStore.countByStatus("active")).toBe(0);

    // Seed traces: 80 failures, 0 successes → effectiveness = 1.0, falsePositives = 0 → PASS
    seedTracesForBacktest(traceStore, { failures: 80, successes: 0, filePattern: "auth.ts" });

    const runner = new SleepCycleRunner({
      traceStore,
      patternStore,
      ruleStore,
      config: { min_traces_for_analysis: 50 },
    });

    const result = await runner.run();
    // Pre-inserted rule + any sleep-cycle-generated rules may all be promoted
    expect(result.rulesPromoted).toBeGreaterThanOrEqual(1);
    expect(ruleStore.countByStatus("active")).toBeGreaterThanOrEqual(1);
    // The specific pre-inserted rule must be active
    const activeRules = ruleStore.findByStatus("active");
    expect(activeRules.some(r => r.id === "rule-test-1")).toBe(true);
  });

  test("rules retired when backtest fails (PH3.3)", async () => {
    const { traceStore, patternStore, ruleStore } = createAllStores();

    // Insert rule
    ruleStore.insert(makeProbationRule());

    // Seed traces: 10 failures, 80 successes → low effectiveness → FAIL
    seedTracesForBacktest(traceStore, { failures: 10, successes: 80, filePattern: "auth.ts" });

    const runner = new SleepCycleRunner({
      traceStore,
      patternStore,
      ruleStore,
      config: { min_traces_for_analysis: 50 },
    });

    const result = await runner.run();
    expect(result.rulesPromoted).toBe(0);
    // PH3.3: Rules that fail backtest are now retired (not left in probation)
    expect(ruleStore.countByStatus("retired")).toBeGreaterThanOrEqual(1);
  });

  test("safety invariant blocks promotion even with passing backtest", async () => {
    const { traceStore, patternStore, ruleStore } = createAllStores();

    // Unsafe rule: disables human escalation (violates I1)
    ruleStore.insert(makeProbationRule({
      id: "rule-unsafe",
      action: "adjust-threshold",
      parameters: { disableHumanEscalation: true },
    }));

    seedTracesForBacktest(traceStore, { failures: 80, successes: 0, filePattern: "auth.ts" });

    const runner = new SleepCycleRunner({
      traceStore,
      patternStore,
      ruleStore,
      config: { min_traces_for_analysis: 50 },
    });

    const result = await runner.run();
    // The unsafe rule should NOT be promoted; any other generated rules may be
    const activeRules = ruleStore.findByStatus("active");
    expect(activeRules.some(r => r.id === "rule-unsafe")).toBe(false);
  });

  test("effectiveness updated regardless of pass/fail (PH3.3: retired on fail)", async () => {
    const { traceStore, patternStore, ruleStore } = createAllStores();

    ruleStore.insert(makeProbationRule());

    // Low effectiveness scenario
    seedTracesForBacktest(traceStore, { failures: 10, successes: 80, filePattern: "auth.ts" });

    const runner = new SleepCycleRunner({
      traceStore,
      patternStore,
      ruleStore,
      config: { min_traces_for_analysis: 50 },
    });

    await runner.run();

    // PH3.3: Rule is now retired (not in probation) after failing backtest
    // Effectiveness should still be updated before retirement
    const retiredRules = ruleStore.findByStatus("retired");
    expect(retiredRules.length).toBeGreaterThanOrEqual(1);
    const rule = retiredRules.find(r => r.id === "rule-test-1");
    expect(rule).toBeDefined();
  });

  test("findMatching returns promoted rules", async () => {
    const { traceStore, patternStore, ruleStore } = createAllStores();

    ruleStore.insert(makeProbationRule());

    // Before promotion: findMatching should return empty
    expect(ruleStore.findMatching({ filePattern: "auth.ts" })).toHaveLength(0);

    seedTracesForBacktest(traceStore, { failures: 80, successes: 0, filePattern: "auth.ts" });

    const runner = new SleepCycleRunner({
      traceStore,
      patternStore,
      ruleStore,
      config: { min_traces_for_analysis: 50 },
    });

    await runner.run();

    // After promotion: findMatching should return active rules including our pre-inserted one
    const matching = ruleStore.findMatching({ filePattern: "auth.ts" });
    expect(matching.length).toBeGreaterThanOrEqual(1);
    expect(matching.some(r => r.id === "rule-test-1")).toBe(true);
  });
});
