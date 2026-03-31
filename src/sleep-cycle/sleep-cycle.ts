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
import { findFailureCorrelations, correlationToPattern } from "./cross-task-analyzer.ts";
import {
  computeDecay,
  createExperimentState,
  recordCycleScore,
  getActiveDecayFunction,
  type DecayExperimentState,
} from "./decay-experiment.ts";

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
  private workerStore?: import("../db/worker-store.ts").WorkerStore;
  private workerLifecycle?: import("../orchestrator/worker-lifecycle.ts").WorkerLifecycle;
  private decayExperiment: DecayExperimentState;
  /** Intentionally in-memory — reset-on-restart gives rules a fresh grace period
   * after environmental changes that may make previously ineffective rules effective again. */
  private ineffectiveCycles: Map<string, number> = new Map();

  constructor(options: {
    traceStore: TraceStore;
    patternStore: PatternStore;
    config?: Partial<SleepCycleConfig>;
    skillManager?: SkillManager;
    ruleStore?: RuleStore;
    bus?: VinyanBus;
    workerStore?: import("../db/worker-store.ts").WorkerStore;
    workerLifecycle?: import("../orchestrator/worker-lifecycle.ts").WorkerLifecycle;
  }) {
    this.traceStore = options.traceStore;
    this.patternStore = options.patternStore;
    this.config = { ...DEFAULT_CONFIG, ...options.config };
    this.skillManager = options.skillManager;
    this.ruleStore = options.ruleStore;
    this.bus = options.bus;
    this.workerStore = options.workerStore;
    this.workerLifecycle = options.workerLifecycle;
    this.decayExperiment = createExperimentState();
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

    // PH3.5: Time-windowed trace analysis — use last 5 cycle windows
    const traces = this.queryTracesTimeWindowed();
    const hasEnoughTraces = traces.length >= this.config.min_traces_for_analysis;

    // Even if not enough traces for new pattern extraction, still backtest existing rules
    if (!hasEnoughTraces) {
      const rulesPromoted = await this.backtestProbationRules(new Set());
      this.patternStore.recordCycleComplete(cycleId, traces.length, 0);
      return { cycleId, patterns: [], tracesAnalyzed: traces.length, antiPatterns: 0, successPatterns: 0, decayedPatterns: 0, rulesPromoted };
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

    // PH3.5: Cross-task-type correlation analysis
    const crossTaskCorrelations = findFailureCorrelations(
      traces,
      this.config.pattern_min_frequency,
      this.config.pattern_min_confidence,
    );
    for (const corr of crossTaskCorrelations) {
      newPatterns.push(correlationToPattern(corr));
    }

    // PH4.5: Worker performance patterns — compare workers per task type
    const workerPatterns = this.extractWorkerPerformancePatterns(traces);
    newPatterns.push(...workerPatterns);

    // Store new patterns + feed into Skill Formation (2.5) and Evolution (2.6)
    let skillsCreated = 0;
    let rulesGenerated = 0;
    const newRuleIds = new Set<string>();

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
          newRuleIds.add(rule.id);
          rulesGenerated++;
        }
      }
    }

    // Phase 2.6 + PH3.3: Backtest probation rules — promote or retire
    // Skip rules generated in this cycle — they need fresh data to validate
    const rulesPromoted = await this.backtestProbationRules(newRuleIds);
    let rulesRetired = 0;

    // PH3.7: Auto-retire active rules with sustained ineffectiveness
    if (this.ruleStore) {
      const { backtestRule, backtestWorkerAssignment } = await import("../evolution/backtester.ts");
      const activeRules = this.ruleStore.findActive();
      for (const rule of activeRules) {
        const bt = this.getTracesForBacktest(rule);
        if (bt.length < 5) continue;
        const result = rule.action === "assign-worker"
          ? backtestWorkerAssignment(rule, bt)
          : backtestRule(rule, bt);
        this.ruleStore.updateEffectiveness(rule.id, result.effectiveness);

        if (result.effectiveness <= 0) {
          const count = this.trackIneffectiveCycle(rule.id);
          if (count >= 3) {
            this.ruleStore.retire(rule.id);
            rulesRetired++;
            this.bus?.emit("evolution:ruleRetired", {
              ruleId: rule.id,
              reason: `Auto-retired: ineffective for ${count} consecutive cycles`,
            });
          }
        } else {
          this.resetIneffectiveCycle(rule.id);
        }
      }
    }

    // GAP-9: Re-verify active skills whose dep-cone may have changed
    if (this.skillManager) {
      this.skillManager.reVerifyStaleSkills();
    }

    // PH4.2: Worker lifecycle transitions — promotion, demotion, re-enrollment
    // WorkerLifecycle emits its own bus events (worker:promoted, worker:demoted, etc.)
    if (this.workerLifecycle && this.workerStore) {
      // Evaluate probation workers for promotion
      const probationWorkers = this.workerStore.findByStatus("probation");
      for (const worker of probationWorkers) {
        this.workerLifecycle.evaluatePromotion(worker.id);
      }

      // Check active workers for demotion
      this.workerLifecycle.checkDemotions();

      // Re-enroll expired demoted workers
      const totalTraces = this.traceStore.count();
      this.workerLifecycle.reEnrollExpired(totalTraces);

      // Emergency reactivation safety net
      this.workerLifecycle.emergencyReactivation();
    }

    // Apply decay to existing patterns
    const decayedCount = this.applyDecay();

    this.patternStore.recordCycleComplete(
      cycleId, traces.length, newPatterns.length,
    );

    this.bus?.emit("sleep:cycleComplete", {
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

      // PH3.3: Capture routing level + model for proportional escalation and multi-condition rules
      const failingTraces = approachTraces.filter(t => t.outcome === "failure");
      const avgRoutingLevel = failingTraces.length > 0
        ? Math.round(failingTraces.reduce((s, t) => s + t.routingLevel, 0) / failingTraces.length)
        : 1;
      const modelCounts = new Map<string, number>();
      for (const t of failingTraces) {
        modelCounts.set(t.model_used, (modelCounts.get(t.model_used) ?? 0) + 1);
      }
      const dominantModel = [...modelCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];

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
        routingLevel: avgRoutingLevel,
        modelPattern: dominantModel,
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

        // PH3.3: Real pairwise Wilson LB — compare individual trace pairs
        let actualWins = 0;
        const winnerTraces = winner.traces.filter(t => t.qualityScore?.composite != null);
        const loserTraces = loser.traces.filter(t => t.qualityScore?.composite != null);
        for (const w of winnerTraces) {
          for (const l of loserTraces) {
            if ((w.qualityScore?.composite ?? 0) > (l.qualityScore?.composite ?? 0)) actualWins++;
          }
        }
        const totalPairs = winnerTraces.length * loserTraces.length;
        if (totalPairs === 0) continue;
        const wilsonLB = wilsonLowerBound(actualWins, totalPairs);
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
    const existingPatterns = this.patternStore.findActive(0.01);
    let decayedCount = 0;

    const halfLife = this.config.decay_half_life_sessions;
    const activeFn = getActiveDecayFunction(this.decayExperiment);

    // Track scores for both functions this cycle
    let expTotal = 0, plTotal = 0, scoreCount = 0;

    for (const pattern of existingPatterns) {
      const ageMs = Date.now() - pattern.createdAt;
      const ageCycles = ageMs / (this.config.interval_sessions * 60_000);

      // PH3.5: Compute both decay weights for experiment
      const expWeight = computeDecay("exponential", ageCycles, halfLife);
      const plWeight = computeDecay("power-law", ageCycles, halfLife);

      // Use the active function's weight
      const newWeight = activeFn === "exponential" ? expWeight : plWeight;

      // Track scores: surviving patterns (weight > 0.1) score by confidence
      if (expWeight > 0.1) expTotal += pattern.confidence;
      if (plWeight > 0.1) plTotal += pattern.confidence;
      scoreCount++;

      if (Math.abs(newWeight - pattern.decayWeight) > 0.01) {
        this.patternStore.updateDecayWeight(pattern.id, newWeight);
        decayedCount++;
      }
    }

    // Update experiment with this cycle's scores
    if (scoreCount > 0 && !this.decayExperiment.locked) {
      this.decayExperiment = recordCycleScore(
        this.decayExperiment,
        expTotal / scoreCount,
        plTotal / scoreCount,
      );
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

  /**
   * PH3.5: Query traces using a time window based on recent sleep cycle timestamps.
   * Falls back to count-bounded query if no cycles have run yet.
   */
  private queryTracesTimeWindowed(): ExecutionTrace[] {
    const cycleTimestamps = this.patternStore.getRecentCycleTimestamps(5);

    if (cycleTimestamps.length === 0) {
      // No cycles yet — fall back to count-bounded
      return this.traceStore.findRecent(10000);
    }

    // Use the oldest of the last 5 cycle starts as the window start
    const oldestCycleStart = cycleTimestamps[cycleTimestamps.length - 1]!;
    return this.traceStore.findByTimeRange(oldestCycleStart, Date.now());
  }

  /** PH3.7: Track consecutive ineffective cycles for a rule. Returns new count. */
  private trackIneffectiveCycle(ruleId: string): number {
    const current = this.ineffectiveCycles.get(ruleId) ?? 0;
    const next = current + 1;
    this.ineffectiveCycles.set(ruleId, next);
    return next;
  }

  /** PH3.7: Reset ineffective cycle counter when a rule becomes effective again. */
  private resetIneffectiveCycle(ruleId: string): void {
    this.ineffectiveCycles.delete(ruleId);
  }

  /**
   * Backtest probation rules — promote passing rules, retire failing ones.
   * Skips rules in the excludeIds set (newly created this cycle).
   */
  private async backtestProbationRules(excludeIds: Set<string>): Promise<number> {
    if (!this.ruleStore) return 0;

    const { backtestRule, backtestWorkerAssignment } = await import("../evolution/backtester.ts");
    const { checkSafetyInvariants } = await import("../evolution/safety-invariants.ts");
    const probationRules = this.ruleStore.findByStatus("probation")
      .filter(r => !excludeIds.has(r.id));

    let promoted = 0;
    for (const rule of probationRules) {
      const backtestTraces = this.getTracesForBacktest(rule);
      if (backtestTraces.length < 5) continue;

      // Route to appropriate backtest: worker assignment uses quality comparison, others use failure prevention
      const result = rule.action === "assign-worker"
        ? backtestWorkerAssignment(rule, backtestTraces)
        : backtestRule(rule, backtestTraces);
      this.ruleStore.updateEffectiveness(rule.id, result.effectiveness);

      if (result.pass) {
        const safety = checkSafetyInvariants(rule);
        if (safety.safe) {
          this.ruleStore.activate(rule.id);
          promoted++;
          this.bus?.emit("evolution:rulePromoted", {
            ruleId: rule.id, taskSig: rule.condition.file_pattern ?? "*",
          });
        }
      } else {
        this.ruleStore.retire(rule.id);
        this.bus?.emit("evolution:ruleRetired", {
          ruleId: rule.id, reason: `Failed backtest (effectiveness: ${result.effectiveness.toFixed(2)})`,
        });
      }
    }
    return promoted;
  }

  /** Get traces relevant for backtesting a rule, filtered by rule conditions. */
  private getTracesForBacktest(rule: EvolutionaryRule): ExecutionTrace[] {
    const allTraces = this.traceStore.findRecent(1000);
    const condition = rule.condition;

    // No filtering conditions → use all traces
    if (!condition.file_pattern && !condition.oracle_name && !condition.model_pattern) {
      return allTraces;
    }

    const filtered = allTraces.filter(trace => {
      if (condition.file_pattern) {
        const pattern = condition.file_pattern;
        const regex = new RegExp("^" + pattern.replace(/\./g, "\\.").replace(/\*/g, ".*") + "$");
        const matches = trace.affected_files.some(f => regex.test(f));
        if (!matches) return false;
      }
      if (condition.oracle_name) {
        if (!Object.keys(trace.oracleVerdicts).includes(condition.oracle_name)) return false;
      }
      if (condition.model_pattern) {
        if (!trace.model_used.includes(condition.model_pattern)) return false;
      }
      return true;
    });

    // If filtering leaves too few traces, fall back to all
    return filtered.length >= 5 ? filtered : allTraces;
  }

  /**
   * PH4.5: Extract worker performance patterns.
   * Groups traces by (task_type_signature, worker_id) and compares
   * Wilson LB/UB quality across workers for the same task type.
   */
  private extractWorkerPerformancePatterns(traces: ExecutionTrace[]): ExtractedPattern[] {
    const patterns: ExtractedPattern[] = [];

    // Group by task type → worker → traces
    const byTaskType = new Map<string, Map<string, ExecutionTrace[]>>();
    for (const trace of traces) {
      const sig = trace.task_type_signature ?? "unknown";
      const wid = trace.worker_id;
      if (!wid) continue;

      if (!byTaskType.has(sig)) byTaskType.set(sig, new Map());
      const byWorker = byTaskType.get(sig)!;
      if (!byWorker.has(wid)) byWorker.set(wid, []);
      byWorker.get(wid)!.push(trace);
    }

    for (const [taskSig, byWorker] of byTaskType) {
      // Need at least 2 workers to compare
      if (byWorker.size < 2) continue;

      // Compute per-worker quality stats
      const workerStats: Array<{
        workerId: string;
        avgQuality: number;
        successRate: number;
        count: number;
        traceIds: string[];
      }> = [];

      for (const [workerId, workerTraces] of byWorker) {
        if (workerTraces.length < this.config.pattern_min_frequency) continue;

        const qualityTraces = workerTraces.filter(t => t.qualityScore?.composite != null);
        const avgQuality = qualityTraces.length > 0
          ? qualityTraces.reduce((s, t) => s + (t.qualityScore?.composite ?? 0), 0) / qualityTraces.length
          : 0;
        const successRate = workerTraces.filter(t => t.outcome === "success").length / workerTraces.length;

        workerStats.push({
          workerId,
          avgQuality,
          successRate,
          count: workerTraces.length,
          traceIds: workerTraces.map(t => t.id),
        });
      }

      if (workerStats.length < 2) continue;

      // Sort by avgQuality descending
      workerStats.sort((a, b) => b.avgQuality - a.avgQuality);

      // Compare best vs rest: generate pattern if delta >= 0.15
      const best = workerStats[0]!;
      for (let i = 1; i < workerStats.length; i++) {
        const other = workerStats[i]!;
        const delta = best.avgQuality - other.avgQuality;
        if (delta < 0.15) continue;

        // Wilson LB significance check on pairwise comparison
        const totalPairs = best.count * other.count;
        if (totalPairs === 0) continue;
        // Simple: check if best's success rate is significantly better
        const wilsonLB = wilsonLowerBound(
          Math.round(best.successRate * best.count),
          best.count,
        );
        if (wilsonLB < 0.15) continue;

        patterns.push({
          id: `wp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
          type: "worker-performance",
          description: `Worker "${best.workerId}" outperforms "${other.workerId}" by ${(delta * 100).toFixed(0)}% quality on task type "${taskSig}"`,
          frequency: best.count + other.count,
          confidence: wilsonLB,
          taskTypeSignature: taskSig,
          approach: best.workerId,
          comparedApproach: other.workerId,
          qualityDelta: delta,
          sourceTraceIds: [...best.traceIds, ...other.traceIds],
          createdAt: Date.now(),
          decayWeight: 1.0,
          workerId: best.workerId,
          comparedWorkerId: other.workerId,
        });
      }
    }

    return patterns;
  }

  private gatherStats(): DataGateStats {
    return {
      traceCount: this.traceStore.count(),
      distinctTaskTypes: this.traceStore.countDistinctTaskTypes(),
      patternsExtracted: this.patternStore.count(),
      activeSkills: this.skillManager?.countActive() ?? 0,
      sleepCyclesRun: this.patternStore.countCycleRuns(),
      activeWorkers: this.workerStore?.countActive() ?? 0,
      workerTraceDiversity: this.workerStore?.countDistinctWorkerIds() ?? 0,
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
      fleet_min_active_workers: 2,
      fleet_min_worker_trace_diversity: 2,
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
