/**
 * Fleet Coordinator — cross-instance task routing and specialization tracking.
 *
 * When the local instance is overloaded, routes tasks to peers with capacity.
 * Tracks which instances handle which task types best (from delegation results).
 *
 * A3: All routing decisions are deterministic and rule-based.
 * A7: Cross-instance prediction error accelerates learning.
 *
 * Source of truth: design/implementation-plan.md §PH5.8
 */

import type { VinyanBus } from '../core/bus.ts';
import type { TaskFingerprint } from './types.ts';

// ── Types ───────────────────────────────────────────────────────

export interface PeerCapacity {
  instanceId: string;
  availableSlots: number;
  totalSlots: number;
  lastUpdatedAt: number;
}

export interface PeerSpecialization {
  instanceId: string;
  taskType: string;
  successCount: number;
  failureCount: number;
  avgDurationMs: number;
  lastUpdatedAt: number;
}

export interface DelegationRecommendation {
  targetInstanceId: string;
  reason: string;
  score: number;
}

export interface FleetCoordinatorConfig {
  /** Local instance ID. */
  instanceId: string;
  /** Event bus for fleet events. */
  bus?: VinyanBus;
  /** Capacity ratio below which a peer is considered overloaded (default: 0.1). */
  overloadThreshold?: number;
  /** Minimum success count before specialization data is trusted (default: 3). */
  minSpecializationTasks?: number;
  /** Staleness threshold for capacity data in ms (default: 120_000). */
  capacityStalenessMs?: number;
}

export class FleetCoordinator {
  private peerCapacities = new Map<string, PeerCapacity>();
  private specializations = new Map<string, PeerSpecialization[]>();
  private config: Required<
    Pick<FleetCoordinatorConfig, 'overloadThreshold' | 'minSpecializationTasks' | 'capacityStalenessMs'>
  > &
    FleetCoordinatorConfig;

  constructor(config: FleetCoordinatorConfig) {
    this.config = {
      ...config,
      overloadThreshold: config.overloadThreshold ?? 0.1,
      minSpecializationTasks: config.minSpecializationTasks ?? 3,
      capacityStalenessMs: config.capacityStalenessMs ?? 120_000,
    };
  }

  /** Update capacity for a peer instance. */
  updatePeerCapacity(instanceId: string, availableSlots: number, totalSlots: number): void {
    this.peerCapacities.set(instanceId, {
      instanceId,
      availableSlots,
      totalSlots,
      lastUpdatedAt: Date.now(),
    });
    this.config.bus?.emit('fleet:capacityUpdate', { instanceId, availableSlots, totalSlots });
  }

  /** Record a delegation outcome to build specialization knowledge. */
  recordDelegationResult(instanceId: string, taskType: string, success: boolean, durationMs: number): void {
    const key = `${instanceId}:${taskType}`;
    let specs = this.specializations.get(key);
    if (!specs) {
      specs = [];
      this.specializations.set(key, specs);
    }

    let spec = specs.find((s) => s.instanceId === instanceId && s.taskType === taskType);
    if (!spec) {
      spec = {
        instanceId,
        taskType,
        successCount: 0,
        failureCount: 0,
        avgDurationMs: 0,
        lastUpdatedAt: Date.now(),
      };
      specs.push(spec);
    }

    const totalBefore = spec.successCount + spec.failureCount;
    if (success) {
      spec.successCount++;
    } else {
      spec.failureCount++;
    }
    spec.avgDurationMs = (spec.avgDurationMs * totalBefore + durationMs) / (totalBefore + 1);
    spec.lastUpdatedAt = Date.now();
  }

  /**
   * Recommend the best peer to delegate a task to.
   * Returns null if no peer has capacity or specialization.
   *
   * Scoring: capacity_ratio * 0.4 + specialization_score * 0.6
   */
  recommendDelegation(
    fingerprint: TaskFingerprint,
    localCapacity: PeerCapacity,
    peerCapacities?: PeerCapacity[],
  ): DelegationRecommendation | null {
    const peers = peerCapacities ?? Array.from(this.peerCapacities.values());

    const now = Date.now();
    const candidates = peers.filter((p) => {
      if (p.instanceId === this.config.instanceId) return false;
      if (now - p.lastUpdatedAt > this.config.capacityStalenessMs) return false;
      if (p.totalSlots === 0) return false;
      return p.availableSlots / p.totalSlots > this.config.overloadThreshold;
    });

    if (candidates.length === 0) return null;

    // Check if local is NOT overloaded — no need to delegate
    if (localCapacity.totalSlots > 0) {
      const localRatio = localCapacity.availableSlots / localCapacity.totalSlots;
      if (localRatio > this.config.overloadThreshold) return null;
    }

    const taskType = fingerprint.actionVerb;
    let bestCandidate: { peer: PeerCapacity; score: number; reason: string } | null = null;

    for (const peer of candidates) {
      const capRatio = peer.availableSlots / peer.totalSlots;
      const capScore = capRatio * 0.4;

      let specScore = 0;
      const specKey = `${peer.instanceId}:${taskType}`;
      const specs = this.specializations.get(specKey);
      if (specs && specs.length > 0) {
        const s = specs[0]!;
        const total = s.successCount + s.failureCount;
        if (total >= this.config.minSpecializationTasks) {
          specScore = (s.successCount / total) * 0.6;
        }
      }

      const totalScore = capScore + specScore;
      const reason =
        specScore > 0
          ? `Cap:${(capRatio * 100).toFixed(0)}% Spec:${((specScore / 0.6) * 100).toFixed(0)}% on ${taskType}`
          : `Cap:${(capRatio * 100).toFixed(0)}% available`;

      if (!bestCandidate || totalScore > bestCandidate.score) {
        bestCandidate = { peer, score: totalScore, reason };
      }
    }

    if (!bestCandidate) return null;

    this.config.bus?.emit('fleet:taskRouted', {
      taskId: `fleet-${Date.now()}`,
      targetPeerId: bestCandidate.peer.instanceId,
      reason: bestCandidate.reason,
    });

    return {
      targetInstanceId: bestCandidate.peer.instanceId,
      reason: bestCandidate.reason,
      score: bestCandidate.score,
    };
  }

  /** Get all known peer capacities. */
  getPeerCapacities(): PeerCapacity[] {
    return Array.from(this.peerCapacities.values());
  }

  /** Get specialization data for a specific instance. */
  getSpecializations(instanceId: string): PeerSpecialization[] {
    const result: PeerSpecialization[] = [];
    for (const specs of this.specializations.values()) {
      for (const spec of specs) {
        if (spec.instanceId === instanceId) {
          result.push(spec);
        }
      }
    }
    return result;
  }
}
