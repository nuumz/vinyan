/**
 * Data Gate — progressive feature activation based on data sufficiency.
 *
 * Pure function: compares live stats against configured thresholds.
 * Phase 2 features (Sleep Cycle, Evolution Engine) activate only when
 * enough trace data has been accumulated.
 *
 * Source of truth: spec/tdd.md §12B (Data Gates)
 */
import type { DataGate, DataGateMetric } from './types.ts';

export interface DataGateStats {
  traceCount: number;
  distinctTaskTypes: number;
  patternsExtracted: number;
  activeSkills: number;
  sleepCyclesRun: number;
  activeWorkers: number; // Phase 4: registered active worker profiles
  workerTraceDiversity: number; // Phase 4: distinct worker_ids in recent traces
  thinkingTraceCount: number; // Extensible Thinking: traces with thinking_mode set
  thinkingDistinctTaskTypes: number; // Extensible Thinking: distinct task types with thinking data
}

export interface DataGateThresholds {
  sleep_cycle_min_traces: number;
  sleep_cycle_min_task_types: number;
  skill_min_patterns: number;
  skill_min_sleep_cycles: number;
  evolution_min_traces: number;
  evolution_min_active_skills: number;
  evolution_min_sleep_cycles: number;
  fleet_min_active_workers: number; // Phase 4: minimum active worker profiles
  fleet_min_worker_trace_diversity: number; // Phase 4: minimum distinct workers in traces
  thinking_calibration_min_traces: number; // Extensible Thinking: minimum traces for calibration
  thinking_uncertainty_min_traces: number; // Extensible Thinking: minimum traces for uncertainty signals
  thinking_uncertainty_min_task_types: number; // Extensible Thinking: minimum task types for uncertainty
}

const METRIC_TO_STAT: Record<DataGateMetric, keyof DataGateStats> = {
  trace_count: 'traceCount',
  distinct_task_types: 'distinctTaskTypes',
  patterns_extracted: 'patternsExtracted',
  active_skills: 'activeSkills',
  sleep_cycles_run: 'sleepCyclesRun',
  active_workers: 'activeWorkers',
  worker_trace_diversity: 'workerTraceDiversity',
  thinking_trace_count: 'thinkingTraceCount',
  thinking_distinct_task_types: 'thinkingDistinctTaskTypes',
};

const FEATURE_CONDITIONS: Record<string, Array<{ metric: DataGateMetric; thresholdKey: keyof DataGateThresholds }>> = {
  sleep_cycle: [
    { metric: 'trace_count', thresholdKey: 'sleep_cycle_min_traces' },
    { metric: 'distinct_task_types', thresholdKey: 'sleep_cycle_min_task_types' },
  ],
  skill_formation: [
    { metric: 'patterns_extracted', thresholdKey: 'skill_min_patterns' },
    { metric: 'sleep_cycles_run', thresholdKey: 'skill_min_sleep_cycles' },
  ],
  evolution_engine: [
    { metric: 'trace_count', thresholdKey: 'evolution_min_traces' },
    { metric: 'active_skills', thresholdKey: 'evolution_min_active_skills' },
    { metric: 'sleep_cycles_run', thresholdKey: 'evolution_min_sleep_cycles' },
  ],
  fleet_routing: [
    { metric: 'active_workers', thresholdKey: 'fleet_min_active_workers' },
    { metric: 'worker_trace_diversity', thresholdKey: 'fleet_min_worker_trace_diversity' },
  ],
  thinking_calibration: [
    { metric: 'thinking_trace_count', thresholdKey: 'thinking_calibration_min_traces' },
  ],
  uncertainty_signal: [
    { metric: 'thinking_trace_count', thresholdKey: 'thinking_uncertainty_min_traces' },
    { metric: 'thinking_distinct_task_types', thresholdKey: 'thinking_uncertainty_min_task_types' },
  ],
};

/**
 * Check whether a Phase 2 feature has enough data to activate.
 */
export function checkDataGate(feature: string, stats: DataGateStats, thresholds: DataGateThresholds): DataGate {
  const conditionDefs = FEATURE_CONDITIONS[feature];
  if (!conditionDefs) {
    return { feature, conditions: [], satisfied: false };
  }

  const conditions = conditionDefs.map(({ metric, thresholdKey }) => {
    const current = stats[METRIC_TO_STAT[metric]];
    const threshold = thresholds[thresholdKey];
    return { metric, threshold, current };
  });

  const satisfied = conditions.every((c) => c.current >= c.threshold);
  return { feature, conditions, satisfied };
}

/**
 * Check all known data gates and return their status.
 */
export function checkAllDataGates(stats: DataGateStats, thresholds: DataGateThresholds): DataGate[] {
  return Object.keys(FEATURE_CONDITIONS).map((feature) => checkDataGate(feature, stats, thresholds));
}
