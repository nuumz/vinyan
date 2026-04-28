/**
 * Observability — system metrics for monitoring and Phase 3 evaluation.
 *
 * Computes aggregate statistics from trace, rule, skill, and pattern stores.
 * Used by CLI commands (vinyan status/metrics) and PH3.7 evaluation framework.
 *
 * Source of truth: design/implementation-plan.md §P3.6
 */

import type { VinyanBus } from '../core/bus.ts';
import type { PatternStore } from '../db/pattern-store.ts';
import type { RuleStore } from '../db/rule-store.ts';
import type { ShadowStore } from '../db/shadow-store.ts';
import type { SkillStore } from '../db/skill-store.ts';
import type { TraceStore } from '../db/trace-store.ts';
import type { WorkerStore } from '../db/worker-store.ts';
import { checkDataGate, type DataGateStats, type DataGateThresholds } from '../orchestrator/data-gate.ts';
import { type EvolutionMetrics, generateEvolutionReport } from './phase3-report.ts';

export interface MetricsDeps {
  traceStore: TraceStore;
  ruleStore?: RuleStore;
  skillStore?: SkillStore;
  patternStore?: PatternStore;
  shadowStore?: ShadowStore;
  workerStore?: WorkerStore;
}

export interface SystemMetrics {
  traces: {
    total: number;
    distinctTaskTypes: number;
    successRate: number;
    avgQualityComposite: number;
    routingDistribution: Record<number, number>;
  };
  rules: {
    total: number;
    active: number;
    probation: number;
    retired: number;
  };
  skills: {
    total: number;
    active: number;
    probation: number;
    demoted: number;
  };
  patterns: {
    total: number;
    sleepCyclesRun: number;
  };
  shadow: {
    queueDepth: number;
  };
  workers: {
    total: number;
    active: number;
    probation: number;
    demoted: number;
    retired: number;
    /** Distinct engines observed across recent traces. */
    traceDiversity: number;
    /** Gini coefficient (0–1) of trace counts per engine — 0 = perfectly balanced, →1 = concentrated. */
    fleetGini: number;
  };
  dataGates: {
    sleepCycle: boolean;
    skillFormation: boolean;
    evolutionEngine: boolean;
    fleetRouting: boolean;
  };
  evolution?: EvolutionMetrics;
}

const DEFAULT_GATE_THRESHOLDS: DataGateThresholds = {
  sleep_cycle_min_traces: 100,
  sleep_cycle_min_task_types: 5,
  skill_min_patterns: 1,
  skill_min_sleep_cycles: 1,
  evolution_min_traces: 200,
  evolution_min_active_skills: 1,
  evolution_min_sleep_cycles: 3,
  fleet_min_active_workers: 2,
  fleet_min_worker_trace_diversity: 2,
  thinking_calibration_min_traces: 50,
  thinking_uncertainty_min_traces: 30,
  thinking_uncertainty_min_task_types: 3,
};

export function getSystemMetrics(deps: MetricsDeps, skipEvolution = false): SystemMetrics {
  const { traceStore, ruleStore, skillStore, patternStore, shadowStore, workerStore } = deps;

  // Trace stats — cap at 100 rows; larger sample doesn't meaningfully improve success rate
  const totalTraces = traceStore.count();
  const distinctTaskTypes = traceStore.countDistinctTaskTypes();
  const recentTraces = traceStore.findRecent(100);

  const successCount = recentTraces.filter((t) => t.outcome === 'success').length;
  const successRate = recentTraces.length > 0 ? successCount / recentTraces.length : 0;

  const qualityScores = recentTraces
    .filter((t) => t.qualityScore?.composite != null)
    .map((t) => t.qualityScore!.composite);
  const avgQualityComposite =
    qualityScores.length > 0 ? qualityScores.reduce((a, b) => a + b, 0) / qualityScores.length : 0;

  const routingDistribution: Record<number, number> = {};
  for (const t of recentTraces) {
    routingDistribution[t.routingLevel] = (routingDistribution[t.routingLevel] ?? 0) + 1;
  }

  // Rule stats
  const activeRules = ruleStore?.findActive() ?? [];
  const probationRules = ruleStore?.findByStatus('probation') ?? [];
  const retiredRules = ruleStore?.findByStatus('retired') ?? [];

  // Skill stats
  const activeSkills = skillStore?.findActive() ?? [];
  const probationSkills = skillStore?.findByStatus('probation') ?? [];
  const demotedSkills = skillStore?.findByStatus('demoted') ?? [];

  // Pattern / sleep cycle stats
  const totalPatterns = patternStore?.count() ?? 0;
  const sleepCyclesRun = patternStore?.countCycleRuns() ?? 0;

  // Shadow queue depth
  const shadowQueueDepth = shadowStore?.count() ?? 0;

  // Worker stats (Phase 4)
  const workerTotal = workerStore?.count() ?? 0;
  const workerActive = workerStore?.countActive() ?? 0;
  const workerProbation = workerStore?.countByStatus('probation') ?? 0;
  const workerDemoted = workerStore?.countByStatus('demoted') ?? 0;
  const workerRetired = workerStore?.countByStatus('retired') ?? 0;
  const workerTraceCounts = workerStore?.getTraceCountsByWorker() ?? [];
  const workerTraceDiversity = workerTraceCounts.length;
  const fleetGini = computeGini(workerTraceCounts.map((w) => w.count));

  // Data gates
  const gateStats: DataGateStats = {
    traceCount: totalTraces,
    distinctTaskTypes,
    patternsExtracted: totalPatterns,
    activeSkills: activeSkills.length,
    sleepCyclesRun,
    activeWorkers: workerActive,
    workerTraceDiversity,
    thinkingTraceCount: traceStore.countWithThinking(),
    thinkingDistinctTaskTypes: traceStore.countDistinctThinkingTaskTypes(),
  };

  return {
    traces: {
      total: totalTraces,
      distinctTaskTypes,
      successRate,
      avgQualityComposite,
      routingDistribution,
    },
    rules: {
      total: ruleStore?.count() ?? 0,
      active: activeRules.length,
      probation: probationRules.length,
      retired: retiredRules.length,
    },
    skills: {
      total: skillStore?.count() ?? 0,
      active: activeSkills.length,
      probation: probationSkills.length,
      demoted: demotedSkills.length,
    },
    patterns: {
      total: totalPatterns,
      sleepCyclesRun,
    },
    shadow: {
      queueDepth: shadowQueueDepth,
    },
    workers: {
      total: workerTotal,
      active: workerActive,
      probation: workerProbation,
      demoted: workerDemoted,
      retired: workerRetired,
      traceDiversity: workerTraceDiversity,
      fleetGini,
    },
    dataGates: {
      sleepCycle: checkDataGate('sleep_cycle', gateStats, DEFAULT_GATE_THRESHOLDS).satisfied,
      skillFormation: checkDataGate('skill_formation', gateStats, DEFAULT_GATE_THRESHOLDS).satisfied,
      evolutionEngine: checkDataGate('evolution_engine', gateStats, DEFAULT_GATE_THRESHOLDS).satisfied,
      fleetRouting: checkDataGate('fleet_routing', gateStats, DEFAULT_GATE_THRESHOLDS).satisfied,
    },
    evolution: skipEvolution ? undefined : generateEvolutionReport({ traceStore, ruleStore, skillStore, patternStore }),
  };
}

// ── Real-time event counter metrics (A7: learning signal) ───────────────

/**
 * MetricsCollector — listens to bus events and maintains real-time counters.
 * Complementary to getSystemMetrics() which queries stores for aggregate data.
 */
export class MetricsCollector {
  private counters = new Map<string, number>();

  /** Attach to a bus and start counting events. Returns detach function. */
  attach(bus: VinyanBus): () => void {
    const unsubs = [
      bus.on('guardrail:injection_detected', () => this.inc('guardrail.injection')),
      bus.on('guardrail:bypass_detected', () => this.inc('guardrail.bypass')),
      bus.on('circuit:open', () => this.inc('circuit.open')),
      bus.on('selfmodel:calibration_error', () => this.inc('selfmodel.calibration_error')),
      bus.on('oracle:contradiction', () => this.inc('oracle.contradiction')),
      bus.on('decomposer:fallback', () => this.inc('decomposer.fallback')),
      bus.on('degradation:triggered', ({ failureType, action }) => {
        this.inc('degradation.triggered');
        this.inc(`degradation.failure.${failureType}`);
        this.inc(`degradation.action.${action}`);
      }),
      // Phase 5: Observability, API, and GAP-H events (G3)
      bus.on('observability:alert', () => this.inc('observability.alert')),
      bus.on('memory:eviction_warning', () => this.inc('memory.eviction')),
      bus.on('context:verdict_omitted', () => this.inc('context.verdict_omitted')),
      bus.on('selfmodel:systematic_miscalibration', () => this.inc('selfmodel.miscalibration')),
      bus.on('api:request', () => this.inc('api.request')),
      bus.on('session:created', () => this.inc('session.created')),
      bus.on('oracle:verdict', () => this.inc('oracle.verdict')),
      // STU: Semantic Task Understanding
      bus.on('understanding:layer0_complete', () => this.inc('understanding.layer0')),
      bus.on('understanding:layer1_complete', () => this.inc('understanding.layer1')),
      bus.on('understanding:layer2_complete', () => this.inc('understanding.layer2')),
      bus.on('understanding:claims_verified', () => this.inc('understanding.verified')),
      bus.on('understanding:calibration', () => this.inc('understanding.calibration')),
    ];
    return () => {
      for (const fn of unsubs) fn();
    };
  }

  inc(key: string): void {
    this.counters.set(key, (this.counters.get(key) ?? 0) + 1);
  }

  get(key: string): number {
    return this.counters.get(key) ?? 0;
  }

  getCounters(): Record<string, number> {
    return Object.fromEntries(this.counters);
  }

  reset(): void {
    this.counters.clear();
  }
}

// Gini coefficient on a non-negative distribution. 0 = perfectly equal, →1 = concentrated.
// Returns 0 for empty input or all-zero distribution.
function computeGini(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  const sum = sorted.reduce((a, b) => a + b, 0);
  if (sum === 0) return 0;
  let weighted = 0;
  for (let i = 0; i < n; i++) {
    weighted += (2 * (i + 1) - n - 1) * sorted[i]!;
  }
  return weighted / (n * sum);
}
