/**
 * Worker Selector — capability-based worker routing.
 *
 * Weighted product scoring:
 *   capability^2 × quality^1 × cost^0.5 × (1 - negPenalty)
 *
 * Epsilon-worker exploration (10%), diversity floor (15%).
 * Falls back to tier-based selection when data gate not met.
 *
 * Source of truth: vinyan-implementation-plan.md §Phase 4.4
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

export interface WorkerSelectorConfig {
  workerStore: WorkerStore;
  capabilityModel: CapabilityModel;
  bus?: VinyanBus;
  epsilonWorker: number;             // default: 0.10
  diversityFloorPct: number;         // default: 0.15
  gateStats: () => DataGateStats;    // lazy — recomputed each call
  gateThresholds: DataGateThresholds;
}

export class WorkerSelector {
  private store: WorkerStore;
  private capModel: CapabilityModel;
  private bus?: VinyanBus;
  private epsilon: number;
  private diversityFloor: number;
  private getStats: () => DataGateStats;
  private thresholds: DataGateThresholds;

  constructor(config: WorkerSelectorConfig) {
    this.store = config.workerStore;
    this.capModel = config.capabilityModel;
    this.bus = config.bus;
    this.epsilon = config.epsilonWorker;
    this.diversityFloor = config.diversityFloorPct;
    this.getStats = config.gateStats;
    this.thresholds = config.gateThresholds;
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
      return this.exploreRandomWorker(candidates, fingerprint, budget);
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

    this.bus?.emit("worker:selected", {
      taskId: "",  // filled in by core-loop
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

    // Weighted product with exponents
    return Math.pow(capability, 2) * Math.pow(quality, 1) * Math.pow(costEfficiency, 0.5);
  }

  private exploreRandomWorker(
    candidates: WorkerProfile[],
    fingerprint: TaskFingerprint,
    budget: { maxTokens: number; timeoutMs: number },
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

    const randomIdx = Math.floor(Math.random() * others.length);
    const selected = others[randomIdx]!;

    this.bus?.emit("worker:exploration", {
      taskId: "",
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
