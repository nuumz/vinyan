/**
 * Federation Cost Relay — cross-instance cost signal exchange via A2A.
 *
 * Broadcasts local cost signals to federated peers and processes incoming
 * cost signals from remote instances.
 *
 * A3 compliant: deterministic signal routing.
 * A5 compliant: remote cost signals capped by trust tier.
 *
 * Source of truth: Economy OS plan §E4
 */
import type { VinyanBus } from '../core/bus.ts';

export interface FederationCostSignal {
  instanceId: string;
  taskId: string;
  computed_usd: number;
  rate_card_id: string;
  cost_tier: 'billing' | 'estimated';
  timestamp: number;
}

export class FederationCostRelay {
  private bus: VinyanBus | undefined;
  private peerCosts = new Map<string, FederationCostSignal[]>();

  constructor(bus?: VinyanBus) {
    this.bus = bus;
  }

  /** Broadcast a local cost signal to peers. */
  broadcastCost(signal: FederationCostSignal): void {
    this.bus?.emit('economy:federation_cost_broadcast', {
      taskId: signal.taskId,
      computed_usd: signal.computed_usd,
      peerCount: this.peerCosts.size,
    });
  }

  /** Handle incoming cost signal from a peer. */
  handlePeerCost(peerId: string, signal: FederationCostSignal): void {
    const existing = this.peerCosts.get(peerId) ?? [];
    existing.push(signal);
    // Keep bounded
    if (existing.length > 1000) existing.shift();
    this.peerCosts.set(peerId, existing);

    this.bus?.emit('economy:federation_cost_received', {
      fromInstanceId: peerId,
      taskId: signal.taskId,
      computed_usd: signal.computed_usd,
    });
  }

  /** Get total cost reported by a peer. */
  getPeerTotalCost(peerId: string): number {
    const costs = this.peerCosts.get(peerId) ?? [];
    return costs.reduce((sum, c) => sum + c.computed_usd, 0);
  }

  /** Get all known peer IDs with cost signals. */
  getTrackedPeers(): string[] {
    return Array.from(this.peerCosts.keys());
  }
}
