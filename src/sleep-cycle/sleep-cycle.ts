/**
 * Sleep Cycle Runner — periodic offline analysis of execution traces.
 *
 * Frequency-based pattern detection with statistical significance filtering.
 * Extracts anti-patterns (approaches that consistently fail) and success
 * patterns (approaches that consistently outperform alternatives).
 *
 * Algorithm per TDD §12B:
 * 1. Trigger every N sessions (default: 20)
 * 2. Group traces by task_type_signature
 * 3. Anti-pattern: approach X fails on task Y ≥80% → Wilson LB ≥ 0.6
 * 4. Success pattern: approach A beats B by ≥25% composite → Wilson LB ≥ 0.15
 * 5. Minimum support: ≥5 observations, ≥3 distinct sessions
 * 6. Exponential decay on pattern weights
 *
 * Source of truth: vinyan-tdd.md §12B (Sleep Cycle Algorithm)
 */
import type { TraceStore } from "../db/trace-store.ts";
import type { PatternStore } from "../db/pattern-store.ts";
import type { ExtractedPattern, SleepCycleConfig, ExecutionTrace } from "../orchestrator/types.ts";
import { wilsonLowerBound } from "./wilson.ts";
import { checkDataGate, type DataGateStats, type DataGateThresholds } from "../orchestrator/data-gate.ts";
import type { SkillManager } from "../orchestrator/skill-manager.ts";
import type { RuleStore } from "../db/rule-store.ts";
import type { VinyanBus } from "../core/bus.ts";
import type { EvolutionaryRule } from "../orchestrator/types.ts";
import { generateRule } from "../evolution/rule-generator.ts";

const DEFAULT_CONFIG: SleepCycleConfig = {
  interval_sessions: 20,
  min_traces_for_analysis: 100,
  pattern_min_frequency: 5,
  pattern_min_confidence: 0.6,
  decay_half_life_sessions: 50,
};

export interface SleepCycleResult {
  cycleId: string;
  patterns: ExtractedPattern[];
  tracesAnalyzed: number;
  antiPatterns: number;
  successPatterns: number;
  decayedPatterns: number;
  rulesPromoted: number;
}

export class SleepCycleRunner {
  private traceStore: TraceStore;
  private patternStore: PatternStore;
  private config: SleepCycleConfig;
  private skillManager?: SkillManager;
  private ruleStore?: RuleStore;
  private bus?: VinyanBus;

  constructor(options: {
    traceStore: TraceStore;
    patternStore: PatternStore;
    config?: Partial<SleepCycleConfig>;
    skillManager?: SkillManager;
    ruleStore?: RuleStore;
    bus?: VinyanBus;
  }) {
    this.traceStore = options.traceStore;
    this.patternStore = options.patternStore;
    this.config = { ...DEFAULT_CONFIG, ...options.config };
    this.skillManager = options.skillManager;
    this.ruleStore = options.ruleStore;
    this.bus = options.bus;
  }

  /** Returns the configured session interval for triggering sleep cycles. */
  getInterval(): number {
    return this.config.interval_sessions;
  }

  /**
   * Run one sleep cycle. Returns extracted patterns.
   * Checks data gate before proceeding.
   */
  async run(): Promise<SleepCycleResult> {
    const cycleId = `cycle-${Date.now().toString(36)}`;

    // Check data gate
    const stats = this.gatherStats();
    const gate = checkDataGate("sleep_cycle", stats, this.getThresholds());
    if (!gate.satisfied) {
      return {
        cycleId,
        patterns: [],
        tracesAnalyzed: 0,
        antiPatterns: 0,
        successPatterns: 0,
        decayedPatterns: 0,
        rulesPromoted: 0,
      };
    }

    this.patternStore.recordCycleStart(cycleId);

    // Collect all traces
    const traces = this.traceStore.queryRecentTraces(10000);
    if (traces.length < this.config.min_traces_for_analysis) {
      this.patternStore.recordCycleComplete(cycleId, traces.length, 0);
      return { cycleId, patterns: [], tracesAnalyzed: traces.length, antiPatterns: 0, successPatterns: 0, decayedPatterns: 0, rulesPromoted: 0 };
    }

    // Group by task type signature
    const grouped = this.groupByTaskType(traces);

    // Extract patterns
    const newPatterns: ExtractedPattern[] = [];

    for (const [taskSig, taskTraces] of grouped) {
      // Anti-patterns: approach X fails on task Y ≥80%
      const antiPatterns = this.extractAntiPatterns(taskSig, taskTraces);
      newPatterns.push(...antiPatterns);

      // Success patterns: approach A beats B by ≥25% composite
      const successPatterns = this.extractSuccessPatterns(taskSig, taskTraces);
      newPatterns.push(...successPatterns);
    }

    // Store new patterns + feed into Skill Formation (2.5) and Evolution (2.6)
    let skillsCreated = 0;
    let rulesGenerated = 0;

    for (const pattern of newPatterns) {
      this.patternStore.insert(pattern);

      // Phase 2.5: Create skills from success patterns
      if (pattern.type === "success-pattern" && pattern.approach && this.skillManager) {
        const affectedFiles = this.extractAffectedFilesFromPattern(pattern, traces);
        const depConeHashes = this.skillManager.computeCurrentHashes(affectedFiles);
        const riskScore = this.estimatePatternRisk(pattern, traces);
        this.skillManager.createFromPattern(pattern, riskScore, depConeHashes);
        skillsCreated++;
      }

      // Phase 2.6: Generate rules from all patterns
      if (this.ruleStore) {
        const rule = generateRule(pattern);
        if (rule) {
          this.ruleStore.insert(rule);
          rulesGenerated++;
        }
      }
    }

    // Phase 2.6: Backtest probation rules and promote passing ones
    let rulesPromoted = 0;
    if (this.ruleStore) {
      const { backtestRule } = await import("../evolution/backtester.ts");
      const { checkSafetyInvariants } = await import("../evolution/safety-invariants.ts");
      const probationRules = this.ruleStore.findByStatus("probation");

      for (const rule of probationRules) {
        const backtestTraces = this.getTracesForBacktest(rule);
        if (backtestTraces.length < 5) continue; // backtester requires ≥5

        const result = backtestRule(rule, backtestTraces);
        this.ruleStore.updateEffectiveness(rule.id, result.effectiveness);

        if (result.pass) {
          const safety = checkSafetyInvariants(rule);
          if (safety.safe) {
            this.ruleStore.activate(rule.id);
            rulesPromoted++;
          }
        }
      }
    }

    // Apply decay to existing patterns
    const decayedCount = this.applyDecay();

    this.patternStore.recordCycleComplete(
      cycleId, traces.length, newPatterns.length,
    );

    this.bus?.emit("sleep:cycle_complete", {
      cycleId,
      patternsFound: newPatterns.length,
      rulesGenerated,
      skillsCreated,
      rulesPromoted,
    });

    return {
      cycleId,
      patterns: newPatterns,
      tracesAnalyzed: traces.length,
      antiPatterns: newPatterns.filter(p => p.type === "anti-pattern").length,
      successPatterns: newPatterns.filter(p => p.type === "success-pattern").length,
      decayedPatterns: decayedCount,
      rulesPromoted,
    };
  }

  // ── Pattern extraction ───────────────────────────────────────────────

  private extractAntiPatterns(taskSig: string, traces: ExecutionTrace[]): ExtractedPattern[] {
    const patterns: ExtractedPattern[] = [];

    // Group by approach
    const byApproach = this.groupByApproach(traces);

    for (const [approach, approachTraces] of byApproach) {
      const total = approachTraces.length;
      if (total < this.config.pattern_min_frequency) continue;

      // Check minimum distinct sessions
      const distinctSessions = new Set(approachTraces.map(t => t.session_id ?? t.taskId));
      if (distinctSessions.size < 3) continue;

      const failures = approachTraces.filter(t => t.outcome === "failure" || t.outcome === "timeout").length;
      const failRate = failures / total;

      // Raw threshold: ≥80%
      if (failRate < 0.8) continue;

      // Statistical significance: Wilson LB ≥ 0.6
      const wilsonLB = wilsonLowerBound(failures, total);
      if (wilsonLB < this.config.pattern_min_confidence) continue;

      patterns.push({
        id: `ap-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
        type: "anti-pattern",
        description: `Approach "${approach}" fails ${(failRate * 100).toFixed(0)}% of the time on task type "${taskSig}"`,
        frequency: total,
        confidence: wilsonLB,
        taskTypeSignature: taskSig,
        approach,
        sourceTraceIds: approachTraces.map(t => t.id),
        createdAt: Date.now(),
        decayWeight: 1.0,
      });
    }

    return patterns;
  }

  private extractSuccessPatterns(taskSig: string, traces: ExecutionTrace[]): ExtractedPattern[] {
    const patterns: ExtractedPattern[] = [];

    // Group by approach, compute average quality
    const byApproach = this.groupByApproach(traces);
    const approachStats: Array<{
      approach: string;
      avgQuality: number;
      count: number;
      traces: ExecutionTrace[];
    }> = [];

    for (const [approach, approachTraces] of byApproach) {
      if (approachTraces.length < this.config.pattern_min_frequency) continue;

      const qualityTraces = approachTraces.filter(t => t.qualityScore);
      if (qualityTraces.length === 0) continue;

      const avgQuality = qualityTraces.reduce(
        (sum, t) => sum + (t.qualityScore?.composite ?? 0), 0,
      ) / qualityTraces.length;

      approachStats.push({ approach, avgQuality, count: qualityTraces.length, traces: approachTraces });
    }

    // Compare all pairs: A beats B by ≥25% composite
    for (let i = 0; i < approachStats.length; i++) {
      for (let j = i + 1; j < approachStats.length; j++) {
        const a = approachStats[i]!;
        const b = approachStats[j]!;
        const delta = a.avgQuality - b.avgQuality;
        const absDelta = Math.abs(delta);

        if (absDelta < 0.25) continue;

        const winner = delta > 0 ? a : b;
        const loser = delta > 0 ? b : a;

        // Check minimum sessions
        const winnerSessions = new Set(winner.traces.map(t => t.session_id ?? t.taskId));
        if (winnerSessions.size < 3) continue;

        // Wilson LB of improvement ≥ 0.15
        // Model as: winner "wins" in head-to-head comparison
        const totalPairs = Math.min(winner.count, loser.count);
        const wins = Math.round(totalPairs * (winner.avgQuality > loser.avgQuality ? 1 : 0));
        const wilsonLB = wilsonLowerBound(wins, totalPairs);
        if (wilsonLB < 0.15) continue;

        patterns.push({
          id: `sp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
          type: "success-pattern",
          description: `Approach "${winner.approach}" outperforms "${loser.approach}" by ${(absDelta * 100).toFixed(0)}% on task type "${taskSig}"`,
          frequency: winner.count + loser.count,
          confidence: wilsonLB,
          taskTypeSignature: taskSig,
          approach: winner.approach,
          comparedApproach: loser.approach,
          qualityDelta: absDelta,
          sourceTraceIds: [...winner.traces.map(t => t.id), ...loser.traces.map(t => t.id)],
          createdAt: Date.now(),
          decayWeight: 1.0,
        });
      }
    }

    return patterns;
  }

  // ── Decay ────────────────────────────────────────────────────────────

  private applyDecay(): number {
    const existingPatterns = this.patternStore.queryActive(0.01);
    let decayedCount = 0;

    const cyclesRun = this.patternStore.countCycleRuns();
    const halfLife = this.config.decay_half_life_sessions;

    for (const pattern of existingPatterns) {
      // Age in "cycles" since pattern creation
      const ageMs = Date.now() - pattern.createdAt;
      const ageCycles = ageMs / (this.config.interval_sessions * 60_000); // approximate

      // Exponential decay: weight = 0.5 ^ (age / half_life)
      const newWeight = Math.pow(0.5, ageCycles / halfLife);

      if (Math.abs(newWeight - pattern.decayWeight) > 0.01) {
        this.patternStore.updateDecayWeight(pattern.id, newWeight);
        decayedCount++;
      }
    }

    return decayedCount;
  }

  // ── Helpers ──────────────────────────────────────────────────────────

  private groupByTaskType(traces: ExecutionTrace[]): Map<string, ExecutionTrace[]> {
    const groups = new Map<string, ExecutionTrace[]>();
    for (const trace of traces) {
      const sig = trace.task_type_signature ?? "unknown";
      const group = groups.get(sig);
      if (group) {
        group.push(trace);
      } else {
        groups.set(sig, [trace]);
      }
    }
    return groups;
  }

  private groupByApproach(traces: ExecutionTrace[]): Map<string, ExecutionTrace[]> {
    const groups = new Map<string, ExecutionTrace[]>();
    for (const trace of traces) {
      const approach = trace.approach || "default";
      const group = groups.get(approach);
      if (group) {
        group.push(trace);
      } else {
        groups.set(approach, [trace]);
      }
    }
    return groups;
  }

  /** Get traces relevant for backtesting a rule. */
  private getTracesForBacktest(_rule: EvolutionaryRule): ExecutionTrace[] {
    return this.traceStore.queryRecentTraces(1000);
  }

  private gatherStats(): DataGateStats {
    return {
      traceCount: this.traceStore.count(),
      distinctTaskTypes: this.traceStore.countDistinctTaskTypes(),
      patternsExtracted: this.patternStore.count(),
      activeSkills: this.skillManager?.countActive() ?? 0,
      sleepCyclesRun: this.patternStore.countCycleRuns(),
    };
  }

  private getThresholds(): DataGateThresholds {
    return {
      sleep_cycle_min_traces: this.config.min_traces_for_analysis,
      sleep_cycle_min_task_types: 5,
      skill_min_patterns: 1,
      skill_min_sleep_cycles: 1,
      evolution_min_traces: 200,
      evolution_min_active_skills: 1,
      evolution_min_sleep_cycles: 3,
    };
  }

  /**
   * Extract unique affected files from traces that sourced a pattern.
   */
  private extractAffectedFilesFromPattern(
    pattern: ExtractedPattern,
    allTraces: ExecutionTrace[],
  ): string[] {
    const traceIdSet = new Set(pattern.sourceTraceIds);
    const files = new Set<string>();
    for (const trace of allTraces) {
      if (traceIdSet.has(trace.id)) {
        for (const f of trace.affected_files) files.add(f);
      }
    }
    return [...files];
  }

  /**
   * Estimate risk score for a pattern from its source traces.
   * Uses average risk_score from traces, falls back to routing-level proxy.
   */
  private estimatePatternRisk(
    pattern: ExtractedPattern,
    allTraces: ExecutionTrace[],
  ): number {
    const traceIdSet = new Set(pattern.sourceTraceIds);
    const risks: number[] = [];
    for (const trace of allTraces) {
      if (traceIdSet.has(trace.id)) {
        if (trace.risk_score != null) {
          risks.push(trace.risk_score);
        } else {
          // Proxy: routing level / 3
          risks.push(trace.routingLevel / 3);
        }
      }
    }
    if (risks.length === 0) return 0.2;
    return risks.reduce((a, b) => a + b, 0) / risks.length;
  }
}
