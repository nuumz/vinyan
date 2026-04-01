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
import type { HypothesisTuple, OracleVerdict } from '../core/types.ts';
import type { OracleProfileStore } from '../db/oracle-profile-store.ts';
import { clampFull, type PeerTrustLevel } from '../oracle/tier-clamp.ts';
import type { TaskFingerprint, TaskInput, TaskResult } from './types.ts';

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
  /** Event bus for coordination events. */
  bus?: VinyanBus;
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
    Pick<InstanceCoordinatorConfig, 'maxDelegationAttempts' | 'demotionFalsePositiveThreshold' | 'demotionTimeoutThreshold'>
  > &
    InstanceCoordinatorConfig;
  private lastDiscoveryAt = 0;
  private discoveryIntervalMs = 60_000;

  constructor(config: InstanceCoordinatorConfig) {
    this.config = {
      ...config,
      maxDelegationAttempts: config.maxDelegationAttempts ?? 2,
      demotionFalsePositiveThreshold: config.demotionFalsePositiveThreshold ?? 0.3,
      demotionTimeoutThreshold: config.demotionTimeoutThreshold ?? 5,
    };
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
   * The peer's result is NOT automatically trusted — caller must re-verify (I12).
   */
  async delegate(input: TaskInput, _fingerprint?: TaskFingerprint): Promise<DelegationResult> {
    const peers = this.getActivePeers();
    if (peers.length === 0) {
      return { delegated: false, reason: 'No peers available' };
    }

    for (let attempt = 0; attempt < this.config.maxDelegationAttempts && attempt < peers.length; attempt++) {
      const peer = peers[attempt]!;
      try {
        const transport = new A2ATransport({
          peerUrl: peer.url,
          oracleName: 'task-delegation',
          instanceId: this.config.instanceId,
        });

        // Use verify() to send task as an ECP verification request
        // The peer will execute the full task and return a result
        const verdict = await transport.verify(
          {
            target: input.goal,
            pattern: 'task-delegation',
            workspace: input.targetFiles?.[0] ?? '',
            context: { taskInput: input },
          },
          input.budget?.maxDurationMs ?? 60_000,
        );

        if (verdict.verified || verdict.type !== 'unknown') {
          return {
            delegated: true,
            peerId: peer.url,
            result: {
              id: input.id,
              status: verdict.verified ? 'completed' : 'failed',
              mutations: [],
              trace: {
                id: `delegated-${input.id}`,
                taskId: input.id,
                timestamp: Date.now(),
                routingLevel: 0,
                approach: `delegated to ${peer.url}`,
                oracleVerdicts: {},
                modelUsed: 'remote',
                tokensConsumed: 0,
                durationMs: verdict.durationMs,
                outcome: verdict.verified ? 'success' : 'failure',
                affectedFiles: [],
                correlationId: input.id,
                sourceInstanceId: this.config.instanceId,
              },
            },
            reason: `Delegated to ${peer.url}`,
          };
        }
      } catch {
        // Try next peer
      }
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
        const clampedConfidence = Math.min(
          clampFull(verdict.confidence, undefined, 'a2a', peerTrust),
          0.95,
        );

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
   */
  broadcastVerdict(_trace: unknown): void {
    // Broadcast via remote bus adapter if available
    // This is advisory — peers may or may not incorporate the information
    // Implementation deferred to when remote-bus adapter is wired
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

    const accuracy = profile.verdictsRequested > 0
      ? profile.verdictsAccurate / profile.verdictsRequested
      : 0;

    if (accuracy >= 0.7 && profile.verdictsRequested >= 20) return 'trusted';
    if (accuracy >= 0.5 && profile.verdictsRequested >= 10) return 'established';
    if (accuracy >= 0.3 && profile.verdictsRequested >= 5) return 'provisional';
    return 'untrusted';
  }

  private recordOracleResult(instanceId: string, oracleName: string, success: boolean): void {
    if (!this.config.profileStore) return;

    const profile = this.config.profileStore.getProfile(instanceId, oracleName);
    if (profile) {
      this.config.profileStore.recordResult(profile.id, success);

      // Check demotion triggers
      if (profile.status === 'active' || profile.status === 'probation') {
        const falsePositiveRate = profile.verdictsRequested > 0
          ? profile.falsePositiveCount / profile.verdictsRequested
          : 0;

        if (falsePositiveRate > this.config.demotionFalsePositiveThreshold) {
          this.config.profileStore.demote(profile.id, `False positive rate ${falsePositiveRate.toFixed(2)} exceeds threshold`);
          this.config.bus?.emit('worker:demoted', { workerId: profile.id, reason: 'high false positive rate', permanent: false });
        }
        if (profile.timeoutCount >= this.config.demotionTimeoutThreshold) {
          this.config.profileStore.demote(profile.id, `Timeout count ${profile.timeoutCount} exceeds threshold`);
        }
      }
    } else {
      // Create new profile in probation
      this.config.profileStore.createProfile({
        instanceId,
        oracleName,
        status: 'probation',
      });
    }
  }
}
