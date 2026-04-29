/**
 * Prometheus text exposition format renderer.
 *
 * Converts SystemMetrics + event counters into the standard Prometheus
 * text format for scraping by monitoring infrastructure.
 *
 * Source of truth: WP-5 Observability Extension (Phase 5.15)
 */
import type { SystemMetrics } from './metrics.ts';
import type { DegradationStatusSnapshot } from './degradation-status.ts';

export interface PrometheusMetric {
  name: string;
  help: string;
  type: 'counter' | 'gauge' | 'histogram' | 'summary';
  value: number | Record<string, number>; // Record for label-based metrics
}

/** Histogram bucket boundaries for task duration (seconds) */
const DURATION_BUCKETS = [0.1, 0.5, 1, 5, 10, 30, 60];

function renderMetric(name: string, help: string, type: string, value: number): string {
  return `# HELP ${name} ${help}\n# TYPE ${name} ${type}\n${name} ${value}\n`;
}

function renderLabeledMetric(name: string, help: string, type: string, labels: Record<string, number>): string {
  const lines = [`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`];
  for (const [label, value] of Object.entries(labels)) {
    lines.push(`${name}{${label}} ${value}`);
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Render SystemMetrics and event counters into Prometheus text exposition format.
 *
 * @param degradationSnapshot Optional A9/T4 live status snapshot. When supplied,
 *   `vinyan_degradation_active` and `vinyan_degradation_active_by_severity` are
 *   emitted as gauges so dashboards can alert on currently-degraded components.
 */
export function renderPrometheus(
  metrics: SystemMetrics,
  eventCounters: Record<string, number>,
  degradationSnapshot?: DegradationStatusSnapshot,
): string {
  const parts: string[] = [];

  // vinyan_tasks_total (counter)
  parts.push(renderMetric('vinyan_tasks_total', 'Total tasks processed', 'counter', metrics.traces.total));

  // vinyan_task_success_rate (gauge)
  parts.push(
    renderMetric('vinyan_task_success_rate', 'Task success rate (0.0-1.0)', 'gauge', metrics.traces.successRate),
  );

  // vinyan_task_duration_seconds (histogram) — expose bucket boundaries with avg as +Inf
  // Since we don't have per-task duration distribution, expose average as a summary-style gauge
  // and the bucket structure for future integration
  const avgDuration = computeAvgDuration(metrics);
  const bucketLines: string[] = [
    `# HELP vinyan_task_duration_seconds Task duration in seconds`,
    `# TYPE vinyan_task_duration_seconds histogram`,
  ];
  for (const bound of DURATION_BUCKETS) {
    // All tasks with avg <= bound count as in that bucket
    const count = avgDuration <= bound ? metrics.traces.total : 0;
    bucketLines.push(`vinyan_task_duration_seconds_bucket{le="${bound}"} ${count}`);
  }
  bucketLines.push(`vinyan_task_duration_seconds_bucket{le="+Inf"} ${metrics.traces.total}`);
  bucketLines.push(`vinyan_task_duration_seconds_sum ${avgDuration * metrics.traces.total}`);
  bucketLines.push(`vinyan_task_duration_seconds_count ${metrics.traces.total}`);
  parts.push(`${bucketLines.join('\n')}\n`);

  // vinyan_oracle_verdicts_total (counter)
  parts.push(
    renderMetric(
      'vinyan_oracle_verdicts_total',
      'Total oracle verdicts issued',
      'counter',
      eventCounters['oracle.verdict'] ?? 0,
    ),
  );

  // vinyan_rules_active (gauge)
  parts.push(renderMetric('vinyan_rules_active', 'Number of active evolutionary rules', 'gauge', metrics.rules.active));

  // vinyan_rules_probation (gauge)
  parts.push(renderMetric('vinyan_rules_probation', 'Number of rules in probation', 'gauge', metrics.rules.probation));

  // vinyan_skills_active (gauge)
  parts.push(renderMetric('vinyan_skills_active', 'Number of active cached skills', 'gauge', metrics.skills.active));

  // vinyan_skills_probation (gauge)
  parts.push(
    renderMetric('vinyan_skills_probation', 'Number of skills in probation', 'gauge', metrics.skills.probation),
  );

  // vinyan_shadow_queue_depth (gauge)
  parts.push(
    renderMetric('vinyan_shadow_queue_depth', 'Shadow validation queue depth', 'gauge', metrics.shadow.queueDepth),
  );

  // vinyan_workers_active (gauge)
  parts.push(renderMetric('vinyan_workers_active', 'Number of active workers', 'gauge', metrics.workers.active));

  // vinyan_guardrail_detections_total (counter, labeled by type)
  parts.push(
    renderLabeledMetric('vinyan_guardrail_detections_total', 'Total guardrail detections by type', 'counter', {
      'type="injection"': eventCounters['guardrail.injection'] ?? 0,
      'type="bypass"': eventCounters['guardrail.bypass'] ?? 0,
    }),
  );

  // vinyan_circuit_breaker_opens_total (counter)
  parts.push(
    renderMetric(
      'vinyan_circuit_breaker_opens_total',
      'Total circuit breaker open events',
      'counter',
      eventCounters['circuit.open'] ?? 0,
    ),
  );

  parts.push(
    renderMetric(
      'vinyan_degradations_total',
      'Total runtime degradation events triggered by A9 policy',
      'counter',
      eventCounters['degradation.triggered'] ?? 0,
    ),
  );

  parts.push(
    renderLabeledMetric('vinyan_degradations_by_failure_total', 'Runtime degradations by failure type', 'counter', {
      'failure_type="oracle-unavailable"': eventCounters['degradation.failure.oracle-unavailable'] ?? 0,
      'failure_type="llm-provider-failure"': eventCounters['degradation.failure.llm-provider-failure'] ?? 0,
      'failure_type="tool-timeout"': eventCounters['degradation.failure.tool-timeout'] ?? 0,
      'failure_type="tool-failure"': eventCounters['degradation.failure.tool-failure'] ?? 0,
      'failure_type="rate-limit"': eventCounters['degradation.failure.rate-limit'] ?? 0,
      'failure_type="peer-unavailable"': eventCounters['degradation.failure.peer-unavailable'] ?? 0,
      'failure_type="trace-store-write-failure"':
        eventCounters['degradation.failure.trace-store-write-failure'] ?? 0,
      'failure_type="budget-pressure"': eventCounters['degradation.failure.budget-pressure'] ?? 0,
      'failure_type="economy-accounting-failure"':
        eventCounters['degradation.failure.economy-accounting-failure'] ?? 0,
      'failure_type="session-persistence-failure"':
        eventCounters['degradation.failure.session-persistence-failure'] ?? 0,
      'failure_type="mutation-apply-failure"': eventCounters['degradation.failure.mutation-apply-failure'] ?? 0,
    }),
  );

  parts.push(
    renderLabeledMetric('vinyan_degradations_by_severity_total', 'Runtime degradations by severity', 'counter', {
      'severity="info"': eventCounters['degradation.severity.info'] ?? 0,
      'severity="warning"': eventCounters['degradation.severity.warning'] ?? 0,
      'severity="critical"': eventCounters['degradation.severity.critical'] ?? 0,
    }),
  );

  if (degradationSnapshot) {
    parts.push(
      renderMetric(
        'vinyan_degradation_active',
        'Number of components currently in degraded state (A9 status tracker)',
        'gauge',
        degradationSnapshot.total,
      ),
    );
    parts.push(
      renderMetric(
        'vinyan_degradation_fail_closed_active',
        'Number of components currently fail-closed (partial outage)',
        'gauge',
        degradationSnapshot.failClosedCount,
      ),
    );
    const bySeverity: Record<string, number> = {
      'severity="info"': 0,
      'severity="warning"': 0,
      'severity="critical"': 0,
    };
    for (const entry of degradationSnapshot.entries) {
      const key = `severity="${entry.severity}"`;
      bySeverity[key] = (bySeverity[key] ?? 0) + 1;
    }
    parts.push(
      renderLabeledMetric(
        'vinyan_degradation_active_by_severity',
        'Active degraded components grouped by severity',
        'gauge',
        bySeverity,
      ),
    );
  }

  // vinyan_data_gate_satisfied (gauge, labeled by gate)
  parts.push(
    renderLabeledMetric('vinyan_data_gate_satisfied', 'Whether a data gate is satisfied (0 or 1)', 'gauge', {
      'gate="sleep_cycle"': metrics.dataGates.sleepCycle ? 1 : 0,
      'gate="skill_formation"': metrics.dataGates.skillFormation ? 1 : 0,
      'gate="evolution_engine"': metrics.dataGates.evolutionEngine ? 1 : 0,
      'gate="fleet_routing"': metrics.dataGates.fleetRouting ? 1 : 0,
    }),
  );

  return parts.join('\n');
}

/** Derive average task duration in seconds from routing distribution */
function computeAvgDuration(metrics: SystemMetrics): number {
  // Use routing distribution as a proxy: L0~0.1s, L1~2s, L2~10s, L3~60s
  const levelDurations: Record<number, number> = { 0: 0.1, 1: 2, 2: 10, 3: 60 };
  const dist = metrics.traces.routingDistribution;
  let totalDuration = 0;
  let totalTasks = 0;
  for (const [level, count] of Object.entries(dist)) {
    totalDuration += (levelDurations[Number(level)] ?? 5) * count;
    totalTasks += count;
  }
  return totalTasks > 0 ? totalDuration / totalTasks : 0;
}
