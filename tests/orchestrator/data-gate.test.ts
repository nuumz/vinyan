import { describe, test, expect } from "bun:test";
import { checkDataGate, checkAllDataGates } from "../../src/orchestrator/data-gate.ts";
import type { DataGateStats, DataGateThresholds } from "../../src/orchestrator/data-gate.ts";

const DEFAULT_THRESHOLDS: DataGateThresholds = {
  sleep_cycle_min_traces: 100,
  sleep_cycle_min_task_types: 5,
  skill_min_patterns: 1,
  skill_min_sleep_cycles: 1,
  evolution_min_traces: 200,
  evolution_min_active_skills: 1,
  evolution_min_sleep_cycles: 3,
  fleet_min_active_workers: 2,
  fleet_min_worker_trace_diversity: 2,
};

function makeStats(overrides?: Partial<DataGateStats>): DataGateStats {
  return {
    traceCount: 0,
    distinctTaskTypes: 0,
    patternsExtracted: 0,
    activeSkills: 0,
    sleepCyclesRun: 0,
    activeWorkers: 0,
    workerTraceDiversity: 0,
    ...overrides,
  };
}

describe("checkDataGate", () => {
  test("sleep_cycle gate not satisfied with zero data", () => {
    const gate = checkDataGate("sleep_cycle", makeStats(), DEFAULT_THRESHOLDS);
    expect(gate.feature).toBe("sleep_cycle");
    expect(gate.satisfied).toBe(false);
    expect(gate.conditions).toHaveLength(2);
  });

  test("sleep_cycle gate satisfied when thresholds met", () => {
    const gate = checkDataGate(
      "sleep_cycle",
      makeStats({ traceCount: 100, distinctTaskTypes: 5 }),
      DEFAULT_THRESHOLDS,
    );
    expect(gate.satisfied).toBe(true);
  });

  test("sleep_cycle gate not satisfied when only traces met", () => {
    const gate = checkDataGate(
      "sleep_cycle",
      makeStats({ traceCount: 200, distinctTaskTypes: 3 }),
      DEFAULT_THRESHOLDS,
    );
    expect(gate.satisfied).toBe(false);
  });

  test("evolution_engine gate requires all three conditions", () => {
    const gate = checkDataGate(
      "evolution_engine",
      makeStats({ traceCount: 200, activeSkills: 1, sleepCyclesRun: 3 }),
      DEFAULT_THRESHOLDS,
    );
    expect(gate.satisfied).toBe(true);
    expect(gate.conditions).toHaveLength(3);
  });

  test("evolution_engine gate fails with insufficient skills", () => {
    const gate = checkDataGate(
      "evolution_engine",
      makeStats({ traceCount: 200, activeSkills: 0, sleepCyclesRun: 3 }),
      DEFAULT_THRESHOLDS,
    );
    expect(gate.satisfied).toBe(false);
  });

  test("unknown feature returns unsatisfied with empty conditions", () => {
    const gate = checkDataGate("nonexistent", makeStats(), DEFAULT_THRESHOLDS);
    expect(gate.satisfied).toBe(false);
    expect(gate.conditions).toHaveLength(0);
  });

  test("conditions include current values and thresholds", () => {
    const gate = checkDataGate(
      "sleep_cycle",
      makeStats({ traceCount: 50, distinctTaskTypes: 2 }),
      DEFAULT_THRESHOLDS,
    );
    expect(gate.conditions[0]!.metric).toBe("trace_count");
    expect(gate.conditions[0]!.current).toBe(50);
    expect(gate.conditions[0]!.threshold).toBe(100);
  });
});

describe("checkAllDataGates", () => {
  test("returns gates for all known features", () => {
    const gates = checkAllDataGates(makeStats(), DEFAULT_THRESHOLDS);
    expect(gates).toHaveLength(4);
    expect(gates.map(g => g.feature).sort()).toEqual(["evolution_engine", "fleet_routing", "skill_formation", "sleep_cycle"]);
  });

  test("all gates satisfied with enough data", () => {
    const gates = checkAllDataGates(
      makeStats({
        traceCount: 200, distinctTaskTypes: 5, patternsExtracted: 1,
        activeSkills: 1, sleepCyclesRun: 3,
        activeWorkers: 2, workerTraceDiversity: 2,
      }),
      DEFAULT_THRESHOLDS,
    );
    expect(gates.every(g => g.satisfied)).toBe(true);
  });
});
