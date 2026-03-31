/**
 * Observability — system metrics for monitoring and Phase 3 evaluation.
 *
 * Computes aggregate statistics from trace, rule, skill, and pattern stores.
 * Used by CLI commands (vinyan status/metrics) and PH3.7 evaluation framework.
 *
 * Source of truth: vinyan-implementation-plan.md §P3.6
 */
import type { TraceStore } from "../db/trace-store.ts";
import type { RuleStore } from "../db/rule-store.ts";
import type { SkillStore } from "../db/skill-store.ts";
import type { PatternStore } from "../db/pattern-store.ts";
import type { ShadowStore } from "../db/shadow-store.ts";
import { checkDataGate, type DataGateStats, type DataGateThresholds } from "../orchestrator/data-gate.ts";
import { generatePhase3Report, type EvolutionMetrics } from "./phase3-report.ts";
import type { VinyanBus } from "../core/bus.ts";

export interface MetricsDeps {
  traceStore: TraceStore;
  ruleStore?: RuleStore;
  skillStore?: SkillStore;
  patternStore?: PatternStore;
  shadowStore?: ShadowStore;
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
  dataGates: {
    sleepCycle: boolean;
    skillFormation: boolean;
    evolutionEngine: boolean;
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
};

export function getSystemMetrics(deps: MetricsDeps): SystemMetrics {
  const { traceStore, ruleStore, skillStore, patternStore, shadowStore } = deps;

  // Trace stats
  const totalTraces = traceStore.count();
  const distinctTaskTypes = traceStore.countDistinctTaskTypes();
  const recentTraces = traceStore.findRecent(1000);

  const successCount = recentTraces.filter(t => t.outcome === "success").length;
  const successRate = recentTraces.length > 0 ? successCount / recentTraces.length : 0;

  const qualityScores = recentTraces
    .filter(t => t.qualityScore?.composite != null)
    .map(t => t.qualityScore!.composite);
  const avgQualityComposite = qualityScores.length > 0
    ? qualityScores.reduce((a, b) => a + b, 0) / qualityScores.length
    : 0;

  const routingDistribution: Record<number, number> = {};
  for (const t of recentTraces) {
    routingDistribution[t.routingLevel] = (routingDistribution[t.routingLevel] ?? 0) + 1;
  }

  // Rule stats
  const activeRules = ruleStore?.findActive() ?? [];
  const probationRules = ruleStore?.findByStatus("probation") ?? [];
  const retiredRules = ruleStore?.findByStatus("retired") ?? [];

  // Skill stats
  const activeSkills = skillStore?.findActive() ?? [];
  const probationSkills = skillStore?.findByStatus("probation") ?? [];
  const demotedSkills = skillStore?.findByStatus("demoted") ?? [];

  // Pattern / sleep cycle stats
  const totalPatterns = patternStore?.count() ?? 0;
  const sleepCyclesRun = patternStore?.countCycleRuns() ?? 0;

  // Shadow queue depth
  const shadowQueueDepth = shadowStore?.count() ?? 0;

  // Data gates
  const gateStats: DataGateStats = {
    traceCount: totalTraces,
    distinctTaskTypes,
    patternsExtracted: totalPatterns,
    activeSkills: activeSkills.length,
    sleepCyclesRun,
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
      total: (ruleStore?.count() ?? 0),
      active: activeRules.length,
      probation: probationRules.length,
      retired: retiredRules.length,
    },
    skills: {
      total: (skillStore?.count() ?? 0),
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
    dataGates: {
      sleepCycle: checkDataGate("sleep_cycle", gateStats, DEFAULT_GATE_THRESHOLDS).satisfied,
      skillFormation: checkDataGate("skill_formation", gateStats, DEFAULT_GATE_THRESHOLDS).satisfied,
      evolutionEngine: checkDataGate("evolution_engine", gateStats, DEFAULT_GATE_THRESHOLDS).satisfied,
    },
    evolution: generatePhase3Report({ traceStore, ruleStore, skillStore, patternStore }),
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
      bus.on("guardrail:injection_detected", () => this.inc("guardrail.injection")),
      bus.on("guardrail:bypass_detected", () => this.inc("guardrail.bypass")),
      bus.on("circuit:open", () => this.inc("circuit.open")),
      bus.on("selfmodel:calibration_error", () => this.inc("selfmodel.calibration_error")),
      bus.on("oracle:contradiction", () => this.inc("oracle.contradiction")),
      bus.on("decomposer:fallback", () => this.inc("decomposer.fallback")),
    ];
    return () => unsubs.forEach(fn => fn());
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
