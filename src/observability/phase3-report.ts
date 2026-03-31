/**
 * Phase 3 Report — PH3.7 Evaluation Framework.
 *
 * Answers the meta-question: "Is the Evolution Engine actually making Vinyan better?"
 * Computes EvolutionMetrics from all Phase 3 stores, including quality trends,
 * rule effectiveness, skill hit rates, and Phase 4 readiness gate.
 *
 * Source of truth: vinyan-implementation-plan.md §PH3.7
 */
import type { TraceStore } from "../db/trace-store.ts";
import type { RuleStore } from "../db/rule-store.ts";
import type { SkillStore } from "../db/skill-store.ts";
import type { PatternStore } from "../db/pattern-store.ts";

// ── Types ──────────────────────────────────────────────────────────────

export interface Phase3ReportDeps {
  traceStore: TraceStore;
  ruleStore?: RuleStore;
  skillStore?: SkillStore;
  patternStore?: PatternStore;
}

export interface EvolutionMetrics {
  selfModel: {
    globalAccuracy: number;
    basisDistribution: Record<string, number>;
  };
  evolutionEngine: {
    rulesTotal: number;
    rulesActive: number;
    rulesRetired: number;
    activeRuleAvgEffectiveness: number;
    backtestPassRate: number;
  };
  skillFormation: {
    total: number;
    active: number;
    demoted: number;
    hitRate: number;
  };
  overall: {
    qualityTrend: number;
    routingEfficiency: number;
    escalationRate: number;
  };
  phase4Readiness: Phase4ReadinessGate;
}

export interface Phase4ReadinessGate {
  ready: boolean;
  conditions: {
    activeRulesEffective: { current: number; threshold: number; met: boolean };
    activeSkillsHighPerf: { current: number; threshold: number; met: boolean };
    globalAccuracy: { current: number; threshold: number; met: boolean };
    sleepCycles: { current: number; threshold: number; met: boolean };
  };
}

// ── Public API ─────────────────────────────────────────────────────────

export function generatePhase3Report(deps: Phase3ReportDeps): EvolutionMetrics {
  const { traceStore, ruleStore, skillStore, patternStore } = deps;

  // ── Overall quality metrics from traces ──
  const recentTraces = traceStore.queryRecentTraces(200);
  // queryRecentTraces returns DESC — reverse to get chronological order for trend
  const chronological = [...recentTraces].reverse();
  const qualityTrend = computeQualityTrend(
    chronological
      .filter(t => t.qualityScore?.composite != null)
      .map(t => t.qualityScore!.composite),
  );

  // Routing efficiency: % resolved without escalation
  const taskOutcomes = new Map<string, { initial: number; final: number; escalated: boolean }>();
  for (const t of chronological) {
    const existing = taskOutcomes.get(t.taskId);
    if (!existing) {
      taskOutcomes.set(t.taskId, {
        initial: t.routingLevel,
        final: t.routingLevel,
        escalated: t.outcome === "escalated",
      });
    } else {
      existing.final = t.routingLevel;
      if (t.outcome === "escalated") existing.escalated = true;
    }
  }
  const totalTasks = taskOutcomes.size;
  const resolvedAtInitial = [...taskOutcomes.values()].filter(t => t.initial === t.final && !t.escalated).length;
  const escalatedCount = [...taskOutcomes.values()].filter(t => t.escalated).length;
  const routingEfficiency = totalTasks > 0 ? resolvedAtInitial / totalTasks : 0;
  const escalationRate = totalTasks > 0 ? escalatedCount / totalTasks : 0;

  // ── Rule metrics ──
  const activeRules = ruleStore?.findActive() ?? [];
  const retiredRules = ruleStore?.findByStatus("retired") ?? [];
  const allRulesCount = ruleStore?.count() ?? 0;
  const activeRuleAvgEffectiveness = activeRules.length > 0
    ? activeRules.reduce((s, r) => s + r.effectiveness, 0) / activeRules.length
    : 0;
  const activePlusRetired = activeRules.length + retiredRules.length;
  const backtestPassRate = activePlusRetired > 0
    ? activeRules.length / activePlusRetired
    : 0;

  // Effective rules: active with effectiveness > 0.3
  const effectiveRules = activeRules.filter(r => r.effectiveness > 0.3);

  // ── Skill metrics ──
  const activeSkills = skillStore?.findActive() ?? [];
  const demotedSkills = skillStore?.findByStatus("demoted") ?? [];
  const totalSkills = skillStore?.count() ?? 0;
  const highPerfSkills = activeSkills.filter(s => s.successRate > 0.7);

  // Skill hit rate: approximated from traces with matched skills
  // (we can't directly measure this without bus events, so use active count / task count)
  const skillHitRate = totalTasks > 0 && activeSkills.length > 0
    ? Math.min(1, activeSkills.reduce((s, sk) => s + sk.usageCount, 0) / Math.max(1, traceStore.count()))
    : 0;

  // ── Self-Model metrics ──
  // Global accuracy from prediction errors in recent traces
  const tracesWithPredError = recentTraces.filter(t => t.predictionError);
  const globalAccuracy = tracesWithPredError.length > 0
    ? tracesWithPredError.filter(t => {
        const err = t.predictionError!;
        return err.error.composite < 0.3;
      }).length / tracesWithPredError.length
    : 0;

  // ── Sleep cycle metrics ──
  const sleepCyclesRun = patternStore?.countCycleRuns() ?? 0;

  // ── Phase 4 readiness gate ──
  const phase4Readiness = computePhase4Readiness({
    effectiveRuleCount: effectiveRules.length,
    highPerfSkillCount: highPerfSkills.length,
    globalAccuracy,
    sleepCyclesRun,
  });

  return {
    selfModel: {
      globalAccuracy,
      basisDistribution: {}, // Would need self-model access for full breakdown
    },
    evolutionEngine: {
      rulesTotal: allRulesCount,
      rulesActive: activeRules.length,
      rulesRetired: retiredRules.length,
      activeRuleAvgEffectiveness,
      backtestPassRate,
    },
    skillFormation: {
      total: totalSkills,
      active: activeSkills.length,
      demoted: demotedSkills.length,
      hitRate: skillHitRate,
    },
    overall: {
      qualityTrend,
      routingEfficiency,
      escalationRate,
    },
    phase4Readiness,
  };
}

// ── Helpers ────────────────────────────────────────────────────────────

/**
 * Simple linear regression slope on an array of quality scores.
 * Positive = improving, negative = degrading, 0 = flat.
 */
export function computeQualityTrend(scores: number[]): number {
  const n = scores.length;
  if (n < 2) return 0;

  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
  for (let i = 0; i < n; i++) {
    sumX += i;
    sumY += scores[i]!;
    sumXY += i * scores[i]!;
    sumX2 += i * i;
  }

  const denominator = n * sumX2 - sumX * sumX;
  if (denominator === 0) return 0;

  return (n * sumXY - sumX * sumY) / denominator;
}

function computePhase4Readiness(stats: {
  effectiveRuleCount: number;
  highPerfSkillCount: number;
  globalAccuracy: number;
  sleepCyclesRun: number;
}): Phase4ReadinessGate {
  const conditions = {
    activeRulesEffective: {
      current: stats.effectiveRuleCount,
      threshold: 3,
      met: stats.effectiveRuleCount >= 3,
    },
    activeSkillsHighPerf: {
      current: stats.highPerfSkillCount,
      threshold: 2,
      met: stats.highPerfSkillCount >= 2,
    },
    globalAccuracy: {
      current: stats.globalAccuracy,
      threshold: 0.7,
      met: stats.globalAccuracy >= 0.7,
    },
    sleepCycles: {
      current: stats.sleepCyclesRun,
      threshold: 10,
      met: stats.sleepCyclesRun >= 10,
    },
  };

  return {
    ready: Object.values(conditions).every(c => c.met),
    conditions,
  };
}
