/**
 * Gossip-Based Knowledge Propagation — epidemic protocol for fleet-scale sharing.
 *
 * Properties:
 *   - O(N) messages per knowledge item (not O(N²) broadcast)
 *   - Content-hash dedup prevents duplicate processing
 *   - All received knowledge enters probation regardless of gossip path
 *   - Trust-weighted peer selection: prefer reliable peers for propagation
 *   - Skip partitioned peers (requires PeerHealthMonitor)
 *
 * Source of truth: Plan Phase E3
 */
import type { EventBus, VinyanBusEvents } from '../core/bus.ts';
import { PEER_TRUST_CAPS, type PeerTrustLevel } from '../oracle/tier-clamp.ts';
import { ECP_MIME_TYPE } from './ecp-data-part.ts';
import type { PeerTrustManager } from './peer-trust.ts';

export interface GossipEnvelope {
  knowledge_id: string;
  hop_count: number;
  origin_instance_id: string;
  ttl_remaining: number;
  payload: unknown;
}

export interface GossipConfig {
  instanceId: string;
  fanout: number;
  maxHops: number;
  dampeningWindowMs: number;
  peerUrls: string[];
  bus?: EventBus<VinyanBusEvents>;
  trustManager?: PeerTrustManager;
  getPeerHealth?: (peerId: string) => 'connected' | 'degraded' | 'partitioned';
}

const DEFAULT_CONFIG: Pick<GossipConfig, 'fanout' | 'maxHops' | 'dampeningWindowMs'> = {
  fanout: 3,
  maxHops: 6,
  dampeningWindowMs: 10_000,
};

export class GossipManager {
  private seen = new Map<string, number>(); // knowledge_id → timestamp
  private config: GossipConfig;

  constructor(config: Partial<GossipConfig> & Pick<GossipConfig, 'instanceId' | 'peerUrls'>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Receive a gossip envelope → dedup → forward to fanout peers.
   * Returns true if the item was new (not seen before).
   */
  propagate(envelope: GossipEnvelope, fromPeerId: string): boolean {
    // Content-hash dedup
    if (this.seen.has(envelope.knowledge_id)) {
      return false;
    }

    // Mark as seen
    this.seen.set(envelope.knowledge_id, Date.now());

    // Check hop limit
    if (envelope.hop_count >= this.config.maxHops) {
      return true; // accepted locally but not forwarded
    }

    // Forward to selected peers
    const peers = this.selectPeers([fromPeerId, envelope.origin_instance_id]);
    const forwarded: GossipEnvelope = {
      ...envelope,
      hop_count: envelope.hop_count + 1,
      ttl_remaining: envelope.ttl_remaining - 1,
    };

    void this.sendToPeers(peers, forwarded);
    return true;
  }

  /**
   * Create and send a new gossip item originating from this instance.
   */
  originate(knowledgeId: string, payload: unknown): GossipEnvelope {
    const envelope: GossipEnvelope = {
      knowledge_id: knowledgeId,
      hop_count: 0,
      origin_instance_id: this.config.instanceId,
      ttl_remaining: this.config.maxHops,
      payload,
    };

    this.seen.set(knowledgeId, Date.now());
    const peers = this.selectPeers([]);
    void this.sendToPeers(peers, envelope);
    return envelope;
  }

  /**
   * Select peers for gossip forwarding.
   * Trust-weighted: higher trust = higher selection probability.
   * Excludes sender, originator, and partitioned peers.
   */
  selectPeers(exclude: string[]): string[] {
    const excludeSet = new Set(exclude);
    const candidates = this.config.peerUrls.filter((url) => {
      // Use URL as peerId for filtering
      if (excludeSet.has(url)) return false;

      // Skip partitioned peers if health checker available
      if (this.config.getPeerHealth) {
        const state = this.config.getPeerHealth(url);
        if (state === 'partitioned') return false;
      }

      return true;
    });

    if (candidates.length <= this.config.fanout) {
      return candidates;
    }

    // Trust-weighted random selection
    return this.weightedSample(candidates, this.config.fanout);
  }

  /**
   * Check if a knowledge_id has already been seen.
   */
  hasSeen(knowledgeId: string): boolean {
    return this.seen.has(knowledgeId);
  }

  /**
   * Get count of seen items (for convergence estimation).
   */
  getSeenCount(): number {
    return this.seen.size;
  }

  /**
   * Clean expired entries from the dedup window.
   */
  cleanExpired(): number {
    const cutoff = Date.now() - this.config.dampeningWindowMs;
    let count = 0;
    for (const [id, ts] of this.seen) {
      if (ts < cutoff) {
        this.seen.delete(id);
        count++;
      }
    }
    return count;
  }

  /**
   * Get convergence estimate: ratio of items forwarded vs total peers.
   */
  getConvergenceEstimate(): { seenItems: number; peerCount: number; estimatedCoverage: number } {
    const peerCount = this.config.peerUrls.length;
    const seenItems = this.seen.size;
    // Rough estimate: each item reaches fanout peers per hop, up to maxHops
    const theoreticalReach = Math.min(peerCount, this.config.fanout * this.config.maxHops);
    const estimatedCoverage = peerCount > 0 ? Math.min(1, theoreticalReach / peerCount) : 0;
    return { seenItems, peerCount, estimatedCoverage };
  }

  private weightedSample(candidates: string[], count: number): string[] {
    // Assign weights based on trust level
    const weighted = candidates.map((url) => {
      const trustLevel = this.config.trustManager?.getTrustLevel(url) ?? 'untrusted';
      const weight = PEER_TRUST_CAPS[trustLevel as PeerTrustLevel] ?? 0.25;
      return { url, weight };
    });

    // Sort by weight descending, then take top `count` with some randomness
    const shuffled = weighted
      .map((w) => ({ ...w, sort: w.weight + Math.random() * 0.1 }))
      .sort((a, b) => b.sort - a.sort);

    return shuffled.slice(0, count).map((w) => w.url);
  }

  private async sendToPeers(peerUrls: string[], envelope: GossipEnvelope): Promise<void> {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: `gossip-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      method: 'tasks/send',
      params: {
        id: `gossip-${envelope.knowledge_id}-hop${envelope.hop_count}`,
        message: {
          role: 'agent',
          parts: [
            {
              type: 'data',
              mimeType: ECP_MIME_TYPE,
              data: {
                ecp_version: 1,
                message_type: 'knowledge_transfer',
                epistemic_type: 'uncertain',
                confidence: 0.5, // gossip items always at probation confidence
                confidence_reported: true,
                payload: envelope,
              },
            },
          ],
        },
      },
    });

    await Promise.allSettled(
      peerUrls.map(async (url) => {
        try {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 3000);
          await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body,
            signal: controller.signal,
          });
          clearTimeout(timer);
        } catch {
          // Fire-and-forget
        }
      }),
    );
  }
}
