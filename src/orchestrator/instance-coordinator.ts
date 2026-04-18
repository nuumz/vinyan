/**
 * Instance Coordinator — cross-instance task delegation and remote oracle dispatch.
 *
 * Advisory coordination between Vinyan instances. Each instance's Orchestrator
 * remains sovereign (A3). Delegation is optional and results are always
 * re-verified locally (I12: no remote governance bypass).
 *
 * Source of truth: spec/tdd.md §23, design/implementation-plan.md §PH5.8
 */

import { A2ATransport } from '../a2a/a2a-transport.ts';
import { type DiscoveredPeer, discoverPeers, filterVinyanPeers } from '../a2a/peer-discovery.ts';
import type { VinyanBus } from '../core/bus.ts';
import {
  computeConflictReport,
  cumulativeFusion,
  fromScalar,
  projectedProbability,
} from '../core/subjective-opinion.ts';
import type { HypothesisTuple, OracleVerdict } from '../core/types.ts';
import type { OracleProfileStore } from '../db/oracle-profile-store.ts';
import type { WorkerStore } from '../db/worker-store.ts';
import { clampFull, type PeerTrustLevel } from '../oracle/tier-clamp.ts';
import type { FederationBudgetPool } from '../economy/federation-budget-pool.ts';
import type { EventForwarder } from './event-forwarder.ts';
import {
  OraclePeerGates,
  type OraclePeerAdapterProfile,
  wrapOracleProfileStore,
} from './profile/oracle-peer-gates.ts';
import { ProfileLifecycle } from './profile/profile-lifecycle.ts';
import type { TaskFingerprint, TaskInput, TaskResult, EngineProfile, EngineStats } from './types.ts';

/** Remote oracle profile — tracks accuracy of remote oracle instances. */
export interface OracleProfile {
  id: string;
  instanceId: string;
  oracleName: string;
  status: 'probation' | 'active' | 'demoted' | 'retired';
  verdictsRequested: number;
  verdictsAccurate: number;
  falsePositiveCount: number;
  timeoutCount: number;
  contradictionCount: number;
  lastUsedAt: number;
  createdAt: number;
  demotedAt?: number;
  demotionReason?: string;
}

export interface InstanceCoordinatorConfig {
  /** URLs of peer instances to discover. */
  peerUrls: string[];
  /** Local instance ID for identification. */
  instanceId: string;
  /** Auth token for peer communication. */
  authToken?: string;
  /** Oracle profile store for tracking remote oracle accuracy. */
  profileStore?: OracleProfileStore;
  /** Worker store for profile sharing. */
  workerStore?: WorkerStore;
  /** Event bus for coordination events. */
  bus?: VinyanBus;
  /** Event forwarder for broadcasting events to peers. */
  eventForwarder?: EventForwarder;
  /** Federation budget pool for cost control on delegation. */
  federationBudgetPool?: FederationBudgetPool;
  /** Max delegation attempts before giving up (default: 2). */
  maxDelegationAttempts?: number;
  /** False positive rate threshold for demotion (default: 0.3). */
  demotionFalsePositiveThreshold?: number;
  /** Timeout count threshold for demotion (default: 5). */
  demotionTimeoutThreshold?: number;
}

export interface DelegationResult {
  delegated: boolean;
  result?: TaskResult;
  peerId?: string;
  reason: string;
}

export class InstanceCoordinator {
  private peers: DiscoveredPeer[] = [];
  private config: Required<
    Pick<
      InstanceCoordinatorConfig,
      'maxDelegationAttempts' | 'demotionFalsePositiveThreshold' | 'demotionTimeoutThreshold'
    >
  > &
    InstanceCoordinatorConfig;
  private lastDiscoveryAt = 0;
  private discoveryIntervalMs = 60_000;
  /** Lazily-constructed lifecycle — only created when profileStore is available. */
  private peerLifecycle: ProfileLifecycle<OraclePeerAdapterProfile> | null = null;

  constructor(config: InstanceCoordinatorConfig) {
    this.config = {
      ...config,
      maxDelegationAttempts: config.maxDelegationAttempts ?? 2,
      demotionFalsePositiveThreshold: config.demotionFalsePositiveThreshold ?? 0.3,
      demotionTimeoutThreshold: config.demotionTimeoutThreshold ?? 5,
    };
  }

  private getPeerLifecycle(): ProfileLifecycle<OraclePeerAdapterProfile> | null {
    if (this.peerLifecycle) return this.peerLifecycle;
    if (!this.config.profileStore) return null;
    const gates = new OraclePeerGates({
      falsePositiveThreshold: this.config.demotionFalsePositiveThreshold,
      timeoutThreshold: this.config.demotionTimeoutThreshold,
    });
    this.peerLifecycle = new ProfileLifecycle<OraclePeerAdapterProfile>({
      kind: 'oracle-peer',
      store: wrapOracleProfileStore(this.config.profileStore),
      gates,
      bus: this.config.bus,
    });
    return this.peerLifecycle;
  }

  /**
   * Check if a task can be delegated to a peer instance.
   * Returns true if local workers can't handle it but a peer might.
   */
  canDelegate(_input: TaskInput, _fingerprint?: TaskFingerprint): boolean {
    return this.getActivePeers().length > 0;
  }

  /**
   * Delegate a task to a peer instance.
   *
   * Agent Conversation §5.6: this now uses `A2ATransport.delegateTask()`,
   * which sends a real `tasks/send` request to the peer's bridge so the
   * peer runs the FULL task pipeline (perception → predict → plan →
   * generate → verify) and returns a complete `TaskResult` — including
   * mutations, oracle verdicts, and any `input-required` clarification
   * questions. Previously this method abused the oracle `verify()` path
   * and synthesized a stub result with `mutations: []`, which made
   * delegated work invisible to the parent.
   *
   * The peer's result is NOT automatically trusted — caller must
   * re-verify (I12). Federation budget is consumed up-front; if all
   * attempts fail the budget is NOT refunded (pessimistic — peers may
   * still have done partial work we don't see).
   */
  async delegate(input: TaskInput, _fingerprint?: TaskFingerprint): Promise<DelegationResult> {
    const peers = this.getActivePeers();
    if (peers.length === 0) {
      return { delegated: false, reason: 'No peers available' };
    }

    // Economy: check federation budget before delegation
    const pool = this.config.federationBudgetPool;
    if (pool) {
      const estimatedCost = 0.01; // conservative default; CostPredictor can refine this
      if (!pool.canAfford(estimatedCost)) {
        return { delegated: false, reason: 'Federation budget pool exhausted' };
      }
      pool.consume(estimatedCost);
    }

    for (let attempt = 0; attempt < this.config.maxDelegationAttempts && attempt < peers.length; attempt++) {
      const peer = peers[attempt]!;
      const transport = new A2ATransport({
        peerUrl: peer.url,
        oracleName: 'task-delegation',
        instanceId: this.config.instanceId,
      });

      const result = await transport.delegateTask(input, input.budget?.maxDurationMs ?? 60_000);
      if (result) {
        // Stamp provenance so downstream consumers know this came from
        // a peer (and can re-verify per I12). The peer may already have
        // set sourceInstanceId; we don't overwrite it.
        if (!result.trace.sourceInstanceId) {
          result.trace.sourceInstanceId = this.config.instanceId;
        }
        return {
          delegated: true,
          peerId: peer.url,
          result,
          reason: `Delegated to ${peer.url}`,
        };
      }
      // Otherwise: try next peer (transport returned null on failure)
    }

    return { delegated: false, reason: 'All delegation attempts failed' };
  }

  /**
   * Request remote oracle verification from a peer.
   * Returns verdict with confidence capped at 0.95 (I13).
   */
  async requestRemoteVerification(
    hypothesis: HypothesisTuple,
    oracleName: string,
    timeoutMs = 30_000,
  ): Promise<OracleVerdict | null> {
    const peers = this.getActivePeers();

    for (const peer of peers) {
      // Check if peer has this oracle capability
      const ecpExt = peer.ecpExtension;
      if (ecpExt?.oracle_capabilities && !ecpExt.oracle_capabilities.some((c) => c.name === oracleName)) {
        continue;
      }

      // Check oracle profile status
      const profile = this.config.profileStore?.getProfile(peer.url, oracleName);
      if (profile && (profile.status === 'demoted' || profile.status === 'retired')) {
        continue;
      }

      try {
        const transport = new A2ATransport({
          peerUrl: peer.url,
          oracleName,
          instanceId: this.config.instanceId,
        });

        const verdict = await transport.verify(hypothesis, timeoutMs);

        // I13: Remote verdict confidence ceiling at 0.95
        const peerTrust = this.getPeerTrustLevel(peer.url);
        const clampedConfidence = Math.min(clampFull(verdict.confidence, undefined, 'a2a', peerTrust), 0.95);

        const result: OracleVerdict = {
          ...verdict,
          confidence: clampedConfidence,
          origin: 'a2a',
          oracleName,
        };

        // Record success in oracle profile
        this.recordOracleResult(peer.url, oracleName, true);

        return result;
      } catch {
        // Record failure in oracle profile
        this.recordOracleResult(peer.url, oracleName, false);
      }
    }

    return null;
  }

  /**
   * Broadcast a verified verdict to peer instances (informational, not authoritative).
   * Uses the EventForwarder if configured, otherwise no-op.
   */
  broadcastVerdict(trace: unknown): void {
    if (!this.config.eventForwarder) return;
    this.config.eventForwarder.forward('trace:record', { trace });
  }

  /**
   * Resolve a conflict between a local oracle verdict and a remote verdict.
   * Algorithm: domain authority → evidence tier → recency → SL fusion → escalation.
   * A5: Remote verdicts always lower tier than local.
   */
  resolveRemoteConflict(
    localVerdict: OracleVerdict,
    remoteVerdict: OracleVerdict,
    context: { taskId: string; localOracleName: string; remoteOracleName: string },
  ): RemoteConflictResolution {
    return resolveRemoteConflict(localVerdict, remoteVerdict, context, this.config.bus);
  }

  /**
   * Export local active worker profiles with reduced confidence for sharing.
   * Confidence is reduced by 50% to reflect cross-instance uncertainty.
   */
  shareWorkerProfiles(): SharedWorkerProfile[] {
    if (!this.config.workerStore) return [];

    const activeProfiles = this.config.workerStore.findActive();
    const shared: SharedWorkerProfile[] = [];

    for (const profile of activeProfiles) {
      const stats = this.config.workerStore.getStats(profile.id);
      shared.push({
        id: profile.id,
        config: profile.config,
        stats: reduceWilsonLB(stats),
        sourceInstanceId: this.config.instanceId,
        sharedAt: Date.now(),
      });
    }

    // Emit share event
    for (const peer of this.getActivePeers()) {
      this.config.bus?.emit('instance:profileShared', {
        peerId: peer.url,
        profileCount: shared.length,
      });
    }

    return shared;
  }

  /**
   * Import worker profiles from a peer instance.
   * Profiles enter with 50% reduced Wilson LB confidence (A5: remote < local trust).
   */
  importWorkerProfiles(profiles: SharedWorkerProfile[], sourceInstanceId: string): number {
    if (!this.config.workerStore) return 0;

    let imported = 0;
    for (const shared of profiles) {
      // Check if we already have this model locally
      const existing = this.config.workerStore.findByModelId(shared.config.modelId);
      if (existing.length > 0) continue; // Skip — already have this model

      // Create a new profile in probation with reduced stats
      const newProfile: EngineProfile = {
        id: `imported-${sourceInstanceId}-${shared.id}`,
        config: shared.config,
        status: 'probation',
        createdAt: Date.now(),
        demotionCount: 0,
      };

      this.config.workerStore.insert(newProfile);
      imported++;
    }

    this.config.bus?.emit('instance:profileImported', {
      fromInstanceId: sourceInstanceId,
      profileCount: imported,
      reducedConfidence: true,
    });

    return imported;
  }

  /** Get currently discovered and active peers. */
  getPeers(): DiscoveredPeer[] {
    return [...this.peers];
  }

  /** Refresh peer discovery. */
  async refreshPeers(): Promise<void> {
    if (this.config.peerUrls.length === 0) return;

    const discovered = await discoverPeers(this.config.peerUrls);
    this.peers = filterVinyanPeers(discovered);
    this.lastDiscoveryAt = Date.now();
  }

  // ── Internal ──────────────────────────────────────────────────

  private getActivePeers(): DiscoveredPeer[] {
    // Trigger lazy discovery if stale
    if (Date.now() - this.lastDiscoveryAt > this.discoveryIntervalMs && this.config.peerUrls.length > 0) {
      // Fire-and-forget — use cached peers for now
      this.refreshPeers().catch(() => {});
    }
    return this.peers;
  }

  private getPeerTrustLevel(peerUrl: string): PeerTrustLevel {
    const profile = this.config.profileStore?.getProfilesByInstance(peerUrl)?.[0];
    if (!profile) return 'untrusted';

    const accuracy = profile.verdictsRequested > 0 ? profile.verdictsAccurate / profile.verdictsRequested : 0;

    if (accuracy >= 0.7 && profile.verdictsRequested >= 20) return 'trusted';
    if (accuracy >= 0.5 && profile.verdictsRequested >= 10) return 'established';
    if (accuracy >= 0.3 && profile.verdictsRequested >= 5) return 'provisional';
    return 'untrusted';
  }

  private recordOracleResult(instanceId: string, oracleName: string, success: boolean): void {
    if (!this.config.profileStore) return;

    const profile = this.config.profileStore.getProfile(instanceId, oracleName);
    if (!profile) {
      // First contact — register in probation so the lifecycle can track it.
      this.config.profileStore.createProfile({ instanceId, oracleName, status: 'probation' });
      return;
    }

    this.config.profileStore.recordResult(profile.id, success);

    // Run unified lifecycle. `checkDemotions` walks all active peers with
    // `OraclePeerGates`, which consolidates the FP-rate and timeout checks
    // formerly open-coded here. Promotion is driven by the same lifecycle
    // once a probation peer accumulates enough evidence.
    const lifecycle = this.getPeerLifecycle();
    if (!lifecycle) return;
    if (profile.status === 'probation') {
      lifecycle.evaluatePromotion(profile.id);
    }
    lifecycle.checkDemotions();
  }
}

// ── Evidence tier ranking (A5) ──────────────────────────────────────

const EVIDENCE_TIER_PRIORITY: Record<string, number> = {
  deterministic: 4,
  heuristic: 3,
  probabilistic: 2,
  speculative: 1,
};

// ── Remote conflict resolution types ────────────────────────────────

export interface RemoteConflictResolution {
  winner: 'local' | 'remote';
  resolvedAtStep: 1 | 2 | 3 | 4 | 5;
  explanation: string;
  conflictK?: number;
  fusedProbability?: number;
}

export interface SharedWorkerProfile {
  id: string;
  config: EngineProfile['config'];
  stats: EngineStats;
  sourceInstanceId: string;
  sharedAt: number;
}

// ── Standalone functions ────────────────────────────────────────────

/**
 * Resolve a conflict between local and remote oracle verdicts.
 * Exported standalone for direct testing.
 *
 * Algorithm:
 *   Step 1: Domain authority — if local is domain-authoritative and remote is not, local wins
 *   Step 2: Evidence tier — deterministic > heuristic > probabilistic > speculative (A5)
 *   Step 3: Recency — newer temporal_context wins
 *   Step 4: SL fusion with K computation from conflict-resolver pattern
 *   Step 5: Escalation — emit oracle:contradiction, return 'contradictory'
 */
export function resolveRemoteConflict(
  localVerdict: OracleVerdict,
  remoteVerdict: OracleVerdict,
  context: { taskId: string; localOracleName: string; remoteOracleName: string },
  bus?: VinyanBus,
): RemoteConflictResolution {
  const localTier = getEvidenceTier(localVerdict);
  const remoteTier = getEvidenceTier(remoteVerdict);

  // Step 1: Domain authority — local oracle is always domain-authoritative over remote
  // A5: Remote verdicts always lower tier than local
  if (localVerdict.origin === 'local' && remoteVerdict.origin === 'a2a') {
    if (localTier > remoteTier) {
      return {
        winner: 'local',
        resolvedAtStep: 1,
        explanation: `Domain authority: local "${context.localOracleName}" (tier ${localTier}) outranks remote "${context.remoteOracleName}" (tier ${remoteTier})`,
      };
    }
  }

  // Step 2: Evidence tier comparison (A5)
  if (localTier !== remoteTier) {
    const winner = localTier > remoteTier ? 'local' : 'remote';
    return {
      winner,
      resolvedAtStep: 2,
      explanation: `Evidence tier: ${winner === 'local' ? context.localOracleName : context.remoteOracleName} (tier ${Math.max(localTier, remoteTier)}) > ${winner === 'local' ? context.remoteOracleName : context.localOracleName} (tier ${Math.min(localTier, remoteTier)})`,
    };
  }

  // Step 3: Recency — if both have temporal_context, newer evidence wins
  const localValid = localVerdict.temporalContext?.validFrom;
  const remoteValid = remoteVerdict.temporalContext?.validFrom;
  if (localValid !== undefined && remoteValid !== undefined && localValid !== remoteValid) {
    const winner = localValid > remoteValid ? 'local' : 'remote';
    return {
      winner,
      resolvedAtStep: 3,
      explanation: `Recency: ${winner} verdict is newer (${winner === 'local' ? localValid : remoteValid} > ${winner === 'local' ? remoteValid : localValid})`,
    };
  }

  // Step 4: SL fusion — compute conflict mass K
  const localOpinion = fromScalar(localVerdict.confidence);
  const remoteOpinion = fromScalar(remoteVerdict.confidence);
  const conflictReport = computeConflictReport(localOpinion, remoteOpinion);
  const K = conflictReport.K;

  if (K <= 0.5) {
    const fused = cumulativeFusion(localOpinion, remoteOpinion);
    const fusedP = projectedProbability(fused);
    // If fused probability >= 0.5, local perspective prevails; else remote
    const winner = fusedP >= 0.5 ? 'local' : 'remote';
    return {
      winner,
      resolvedAtStep: 4,
      conflictK: K,
      fusedProbability: fusedP,
      explanation: `SL fusion: K=${K.toFixed(3)}, P(fused)=${fusedP.toFixed(3)} — ${winner} wins`,
    };
  }

  // Step 5: Escalation — unresolvable contradiction
  bus?.emit('oracle:contradiction', {
    taskId: context.taskId,
    passed: [localVerdict.verified ? context.localOracleName : context.remoteOracleName],
    failed: [localVerdict.verified ? context.remoteOracleName : context.localOracleName],
  });

  return {
    winner: 'local', // Conservative: local wins when contradictory (I12)
    resolvedAtStep: 5,
    conflictK: K,
    explanation: `SL contradiction: K=${K.toFixed(3)} > 0.5 — escalated, local wins conservatively (I12)`,
  };
}

/**
 * Reduce EngineStats confidence by a factor (default 0.5) for cross-instance sharing.
 * Applies reduction to successRate and avgQualityScore.
 */
export function reduceWilsonLB(stats: EngineStats, reductionFactor = 0.5): EngineStats {
  return {
    ...stats,
    successRate: stats.successRate * reductionFactor,
    avgQualityScore: stats.avgQualityScore * reductionFactor,
    taskTypeBreakdown: Object.fromEntries(
      Object.entries(stats.taskTypeBreakdown).map(([key, val]) => [
        key,
        {
          ...val,
          successRate: val.successRate * reductionFactor,
          avgQuality: val.avgQuality * reductionFactor,
        },
      ]),
    ),
  };
}

function getEvidenceTier(verdict: OracleVerdict): number {
  // Infer tier from oracle name if available
  if (verdict.oracleName) {
    if (
      verdict.oracleName.includes('ast') ||
      verdict.oracleName.includes('type') ||
      verdict.oracleName.includes('test')
    ) {
      return EVIDENCE_TIER_PRIORITY['deterministic']!;
    }
    if (verdict.oracleName.includes('dep') || verdict.oracleName.includes('lint')) {
      return EVIDENCE_TIER_PRIORITY['heuristic']!;
    }
  }
  // Infer from confidence level
  if (verdict.confidence >= 0.95) return EVIDENCE_TIER_PRIORITY['deterministic']!;
  if (verdict.confidence >= 0.7) return EVIDENCE_TIER_PRIORITY['heuristic']!;
  if (verdict.confidence >= 0.4) return EVIDENCE_TIER_PRIORITY['probabilistic']!;
  return EVIDENCE_TIER_PRIORITY['speculative']!;
}
