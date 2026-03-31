import { describe, test, expect } from "bun:test";
import { renderPrometheus } from "../../src/observability/prometheus.ts";
import type { SystemMetrics } from "../../src/observability/metrics.ts";

function makeMetrics(overrides?: Partial<SystemMetrics>): SystemMetrics {
  return {
    traces: {
      total: 42,
      distinctTaskTypes: 5,
      successRate: 0.85,
      avgQualityComposite: 0.78,
      routingDistribution: { 0: 10, 1: 20, 2: 10, 3: 2 },
    },
    rules: { total: 8, active: 5, probation: 2, retired: 1 },
    skills: { total: 6, active: 3, probation: 2, demoted: 1 },
    patterns: { total: 15, sleepCyclesRun: 3 },
    shadow: { queueDepth: 4 },
    workers: { total: 5, active: 3, probation: 1, demoted: 1, retired: 0, traceDiversity: 4 },
    dataGates: {
      sleepCycle: true,
      skillFormation: false,
      evolutionEngine: false,
      fleetRouting: true,
    },
    ...overrides,
  };
}

describe("renderPrometheus", () => {
  test("outputs valid Prometheus text exposition format", () => {
    const output = renderPrometheus(makeMetrics(), {});
    // Each metric block starts with # HELP and # TYPE
    expect(output).toContain("# HELP vinyan_tasks_total");
    expect(output).toContain("# TYPE vinyan_tasks_total counter");
    expect(output).toContain("vinyan_tasks_total 42");
  });

  test("exposes all required metric names", () => {
    const output = renderPrometheus(makeMetrics(), {});
    const requiredMetrics = [
      "vinyan_tasks_total",
      "vinyan_task_success_rate",
      "vinyan_task_duration_seconds",
      "vinyan_oracle_verdicts_total",
      "vinyan_rules_active",
      "vinyan_rules_probation",
      "vinyan_skills_active",
      "vinyan_skills_probation",
      "vinyan_shadow_queue_depth",
      "vinyan_workers_active",
      "vinyan_guardrail_detections_total",
      "vinyan_circuit_breaker_opens_total",
      "vinyan_data_gate_satisfied",
    ];
    for (const name of requiredMetrics) {
      expect(output).toContain(name);
    }
  });

  test("renders gauge values from metrics struct", () => {
    const output = renderPrometheus(makeMetrics(), {});
    expect(output).toContain("vinyan_task_success_rate 0.85");
    expect(output).toContain("vinyan_rules_active 5");
    expect(output).toContain("vinyan_rules_probation 2");
    expect(output).toContain("vinyan_skills_active 3");
    expect(output).toContain("vinyan_skills_probation 2");
    expect(output).toContain("vinyan_shadow_queue_depth 4");
    expect(output).toContain("vinyan_workers_active 3");
  });

  test("renders counter values from event counters", () => {
    const counters = {
      "oracle.verdict": 100,
      "guardrail.injection": 3,
      "guardrail.bypass": 1,
      "circuit.open": 2,
    };
    const output = renderPrometheus(makeMetrics(), counters);
    expect(output).toContain("vinyan_oracle_verdicts_total 100");
    expect(output).toContain('vinyan_guardrail_detections_total{type="injection"} 3');
    expect(output).toContain('vinyan_guardrail_detections_total{type="bypass"} 1');
    expect(output).toContain("vinyan_circuit_breaker_opens_total 2");
  });

  test("defaults missing event counters to 0", () => {
    const output = renderPrometheus(makeMetrics(), {});
    expect(output).toContain("vinyan_oracle_verdicts_total 0");
    expect(output).toContain('vinyan_guardrail_detections_total{type="injection"} 0');
    expect(output).toContain("vinyan_circuit_breaker_opens_total 0");
  });

  test("renders labeled data gate metrics with 0 or 1", () => {
    const output = renderPrometheus(makeMetrics(), {});
    expect(output).toContain('vinyan_data_gate_satisfied{gate="sleep_cycle"} 1');
    expect(output).toContain('vinyan_data_gate_satisfied{gate="skill_formation"} 0');
    expect(output).toContain('vinyan_data_gate_satisfied{gate="evolution_engine"} 0');
    expect(output).toContain('vinyan_data_gate_satisfied{gate="fleet_routing"} 1');
  });

  test("renders histogram bucket boundaries for task duration", () => {
    const output = renderPrometheus(makeMetrics(), {});
    expect(output).toContain('vinyan_task_duration_seconds_bucket{le="0.1"}');
    expect(output).toContain('vinyan_task_duration_seconds_bucket{le="0.5"}');
    expect(output).toContain('vinyan_task_duration_seconds_bucket{le="1"}');
    expect(output).toContain('vinyan_task_duration_seconds_bucket{le="5"}');
    expect(output).toContain('vinyan_task_duration_seconds_bucket{le="10"}');
    expect(output).toContain('vinyan_task_duration_seconds_bucket{le="30"}');
    expect(output).toContain('vinyan_task_duration_seconds_bucket{le="60"}');
    expect(output).toContain('vinyan_task_duration_seconds_bucket{le="+Inf"}');
    expect(output).toContain("vinyan_task_duration_seconds_sum");
    expect(output).toContain("vinyan_task_duration_seconds_count 42");
  });

  test("handles zero traces gracefully", () => {
    const emptyMetrics = makeMetrics({
      traces: {
        total: 0,
        distinctTaskTypes: 0,
        successRate: 0,
        avgQualityComposite: 0,
        routingDistribution: {},
      },
    });
    const output = renderPrometheus(emptyMetrics, {});
    expect(output).toContain("vinyan_tasks_total 0");
    expect(output).toContain("vinyan_task_success_rate 0");
    expect(output).toContain("vinyan_task_duration_seconds_count 0");
    expect(output).toContain("vinyan_task_duration_seconds_sum 0");
  });
});
