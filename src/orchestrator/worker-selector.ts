/**
 * Worker Selector — capability-based worker routing.
 *
 * Weighted product scoring:
 *   capability^2 × quality^1 × cost^0.5 × (1 - negPenalty)
 *
 * Epsilon-worker exploration (10%), diversity cap (70%, I11).
 * Falls back to tier-based selection when data gate not met.
 *
 * Source of truth: design/implementation-plan.md §Phase 4.4
 */
import type {
  TaskFingerprint,
  RoutingLevel,
  WorkerSelectionResult,
  WorkerProfile,
} from "./types.ts";
import type { WorkerStore } from "../db/worker-store.ts";
import { CapabilityModel } from "./capability-model.ts";
import { checkDataGate, type DataGateStats, type DataGateThresholds } from "./data-gate.ts";
import type { VinyanBus } from "../core/bus.ts";

/** Default cycle duration for staleness penalty (10 minutes). */
const DEFAULT_CYCLE_DURATION_MS = 600_000;

export interface WorkerSelectorConfig {
  workerStore: WorkerStore;
  capabilityModel: CapabilityModel;
  bus?: VinyanBus;
  epsilonWorker: number;             // default: 0.10
  diversityCapPct: number;           // default: 0.70 (matches I11 WORKER_DIVERSITY_CAP)
  gateStats: () => DataGateStats;    // lazy — recomputed each call
  gateThresholds: DataGateThresholds;
  cycleDurationMs?: number;          // default: 600_000 (10 min)
}

export class WorkerSelector {
  private store: WorkerStore;
  private capModel: CapabilityModel;
  private bus?: VinyanBus;
  private epsilon: number;
  private diversityCap: number;
  private getStats: () => DataGateStats;
  private thresholds: DataGateThresholds;
  private cycleDurationMs: number;

  constructor(config: WorkerSelectorConfig) {
    this.store = config.workerStore;
    this.capModel = config.capabilityModel;
    this.bus = config.bus;
    this.epsilon = config.epsilonWorker;
    this.diversityCap = config.diversityCapPct;
    this.getStats = config.gateStats;
    this.thresholds = config.gateThresholds;
    this.cycleDurationMs = config.cycleDurationMs ?? DEFAULT_CYCLE_DURATION_MS;
  }

  /**
   * Select the best worker for a task based on capability matching.
   * Falls back to tier-based if data gate not met.
   */
  selectWorker(
    fingerprint: TaskFingerprint,
    routingLevel: RoutingLevel,
    budget: { maxTokens: number; timeoutMs: number },
    excludeWorkerIds?: string[],
    taskId?: string,
  ): WorkerSelectionResult {
    // Check data gate — fallback to tier if insufficient data
    const gate = checkDataGate("fleet_routing", this.getStats(), this.thresholds);
    if (!gate.satisfied) {
      return this.tierFallback(routingLevel);
    }

    const candidates = this.store.findActive()
      .filter(w => !excludeWorkerIds?.includes(w.id));

    if (candidates.length === 0) {
      return this.tierFallback(routingLevel);
    }

    // Epsilon-worker exploration (never selects probation/demoted)
    if (Math.random() < this.epsilon && candidates.length > 1) {
      return this.exploreRandomWorker(candidates, fingerprint, budget, taskId);
    }

    // Check fleet-level uncertainty (A2: "I don't know")
    const { maxCapability } = this.capModel.getMaxCapabilityForFingerprint(
      candidates.map(c => c.id), fingerprint,
    );
    if (maxCapability < 0.3 && maxCapability > 0) {
      this.bus?.emit("task:uncertain", {
        taskId: taskId ?? "",
        reason: "All workers below capability threshold",
        maxCapability,
      });
      return {
        selectedWorkerId: "",
        reason: "uncertain",
        score: 0,
        alternatives: [],
        explorationTriggered: false,
        dataGateMet: true,
        maxCapability,
        isUncertain: true,
      };
    }

    // Score all candidates
    const scored = candidates.map(w => ({
      worker: w,
      score: this.scoreWorker(w, fingerprint, budget),
    })).sort((a, b) => b.score - a.score);

    const selected = scored[0]!;
    const alternatives = scored.slice(1).map(s => ({
      workerId: s.worker.id,
      score: s.score,
    }));

    // Enforce diversity floor: if top worker exceeds allocation cap, boost alternatives
    const selectionResult = this.enforceDiversityFloor(scored, fingerprint, budget, taskId);
    if (selectionResult) return selectionResult;

    this.bus?.emit("worker:selected", {
      taskId: taskId ?? "",
      workerId: selected.worker.id,
      reason: "capability-score",
      score: selected.score,
      alternatives: alternatives.length,
    });

    return {
      selectedWorkerId: selected.worker.id,
      reason: "capability-score",
      score: selected.score,
      alternatives,
      explorationTriggered: false,
      dataGateMet: true,
    };
  }

  /**
   * Score a worker for a specific task fingerprint.
   * Weighted product: capability^2 × quality^1 × cost^0.5 × (1 - negPenalty)
   */
  private scoreWorker(
    worker: WorkerProfile,
    fingerprint: TaskFingerprint,
    budget: { maxTokens: number; timeoutMs: number },
  ): number {
    // Check negative capability — binary exclusion
    if (this.capModel.hasNegativeCapability(worker.id, fingerprint)) {
      return 0;
    }

    const capScore = this.capModel.getCapability(worker.id, fingerprint);
    const stats = this.store.getStats(worker.id);

    // Capability match (Wilson LB, null → 0.5 default for cold-start)
    const capability = capScore.capability ?? 0.5;

    // Quality track record
    const quality = stats.avgQualityScore || 0.5;

    // Cost efficiency: 1 - (avgTokens / budget), clamped
    const costRatio = budget.maxTokens > 0
      ? stats.avgTokenCost / budget.maxTokens
      : 0;
    const costEfficiency = Math.max(0.1, Math.min(1.0, 1 - costRatio));

    // Layer C: Staleness penalty — 0.9× per cycle without new traces
    let stalenessPenalty = 1.0;
    if (stats.lastActiveAt > 0) {
      const cyclesSinceActive = Math.floor((Date.now() - stats.lastActiveAt) / this.cycleDurationMs);
      if (cyclesSinceActive > 0) {
        stalenessPenalty = Math.pow(0.9, cyclesSinceActive);
      }
    }

    // Weighted product with exponents × staleness
    return Math.pow(capability, 2) * Math.pow(quality, 1) * Math.pow(costEfficiency, 0.5) * stalenessPenalty;
  }

  private exploreRandomWorker(
    candidates: WorkerProfile[],
    fingerprint: TaskFingerprint,
    budget: { maxTokens: number; timeoutMs: number },
    taskId?: string,
  ): WorkerSelectionResult {
    // Pick random candidate (excluding the one that would be selected by score)
    const scored = candidates.map(w => ({
      worker: w,
      score: this.scoreWorker(w, fingerprint, budget),
    })).sort((a, b) => b.score - a.score);

    const defaultWorker = scored[0]!;
    const others = scored.slice(1);

    if (others.length === 0) {
      // Only one candidate — no exploration possible
      return {
        selectedWorkerId: defaultWorker.worker.id,
        reason: "capability-score",
        score: defaultWorker.score,
        alternatives: [],
        explorationTriggered: false,
        dataGateMet: true,
      };
    }

    // Layer A: Weight inversely by task count — underserved workers get more exploration
    const weights = others.map(s => {
      const wStats = this.store.getStats(s.worker.id);
      return 1 / (wStats.totalTasks + 1);
    });
    const totalWeight = weights.reduce((a, b) => a + b, 0);
    let roll = Math.random() * totalWeight;
    let selectedIdx = 0;
    for (let i = 0; i < weights.length; i++) {
      roll -= weights[i]!;
      if (roll <= 0) { selectedIdx = i; break; }
    }
    const selected = others[selectedIdx]!;

    this.bus?.emit("worker:exploration", {
      taskId: taskId ?? "",
      selectedWorkerId: selected.worker.id,
      defaultWorkerId: defaultWorker.worker.id,
    });

    return {
      selectedWorkerId: selected.worker.id,
      reason: "exploration",
      score: selected.score,
      alternatives: scored.map(s => ({ workerId: s.worker.id, score: s.score })),
      explorationTriggered: true,
      dataGateMet: true,
    };
  }

  /**
   * Enforce diversity floor: if the top-scoring worker exceeds diversity cap,
   * select the next-best worker instead (I11 enforcement at runtime).
   */
  private enforceDiversityFloor(
    scored: Array<{ worker: WorkerProfile; score: number }>,
    fingerprint: TaskFingerprint,
    budget: { maxTokens: number; timeoutMs: number },
    taskId?: string,
  ): WorkerSelectionResult | null {
    if (scored.length < 2) return null;

    const topWorker = scored[0]!;
    const topStats = this.store.getStats(topWorker.worker.id);

    // Compute allocation: what fraction of all tasks does this worker handle?
    const allActiveWorkers = this.store.findActive();
    let totalTasks = 0;
    for (const w of allActiveWorkers) {
      totalTasks += this.store.getStats(w.id).totalTasks;
    }

    if (totalTasks === 0) return null;

    const allocation = topStats.totalTasks / totalTasks;
    if (allocation <= this.diversityCap) return null;

    // Top worker exceeds diversity cap — select next best
    const next = scored[1]!;
    this.bus?.emit("fleet:diversity_enforced", {
      workerId: topWorker.worker.id,
      boostAmount: next.score,
    });
    this.bus?.emit("worker:selected", {
      taskId: taskId ?? "",
      workerId: next.worker.id,
      reason: "diversity-floor",
      score: next.score,
      alternatives: scored.length - 1,
    });

    return {
      selectedWorkerId: next.worker.id,
      reason: "capability-score",
      score: next.score,
      alternatives: scored.filter((_, i) => i !== 1).map(s => ({
        workerId: s.worker.id,
        score: s.score,
      })),
      explorationTriggered: false,
      dataGateMet: true,
    };
  }

  private tierFallback(routingLevel: RoutingLevel): WorkerSelectionResult {
    // No specific worker — let worker pool use tier-based selection
    const activeWorkers = this.store.findActive();
    const workerId = activeWorkers.length > 0 ? activeWorkers[0]!.id : "";

    return {
      selectedWorkerId: workerId,
      reason: "tier-fallback",
      score: 0,
      alternatives: [],
      explorationTriggered: false,
      dataGateMet: false,
    };
  }
}
