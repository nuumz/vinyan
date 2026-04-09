/**
 * Peer Pricing — instance pricing for delegation, A2A negotiation.
 *
 * Instances set prices for delegation requests. Prices are negotiated
 * via the A2A negotiation protocol (PROPOSE/AFFIRM).
 *
 * A3 compliant: acceptance is deterministic (price <= maxPrice × 1.1).
 *
 * Source of truth: Economy OS plan §E4
 */
import type { VinyanBus } from '../core/bus.ts';

export interface PeerPrice {
  instanceId: string;
  taskType: string;
  price_per_token_input: number;
  price_per_token_output: number;
  min_charge_usd: number;
  valid_until: number;
}

export class PeerPricingManager {
  private localPrices = new Map<string, PeerPrice>();
  private peerPrices = new Map<string, PeerPrice[]>();
  private maxNegotiationRounds: number;
  private bus: VinyanBus | undefined;

  constructor(maxNegotiationRounds = 3, bus?: VinyanBus) {
    this.maxNegotiationRounds = maxNegotiationRounds;
    this.bus = bus;
  }

  /** Set local pricing for a task type. */
  setLocalPricing(taskType: string, pricing: Omit<PeerPrice, 'instanceId' | 'valid_until'>): void {
    this.localPrices.set(taskType, {
      ...pricing,
      instanceId: 'local',
      taskType,
      valid_until: Date.now() + 3_600_000, // 1 hour default TTL
    });
  }

  /** Get local pricing for a task type. */
  getLocalPricing(taskType: string): PeerPrice | null {
    const price = this.localPrices.get(taskType);
    if (!price || price.valid_until < Date.now()) return null;
    return price;
  }

  /** Record a peer's pricing. */
  recordPeerPricing(peerId: string, price: PeerPrice): void {
    const existing = this.peerPrices.get(peerId) ?? [];
    // Replace existing for same task type
    const filtered = existing.filter((p) => p.taskType !== price.taskType);
    filtered.push(price);
    this.peerPrices.set(peerId, filtered);
  }

  /**
   * Evaluate whether a peer's price is acceptable.
   * A3: deterministic — accept if price <= maxPrice × 1.1.
   */
  evaluatePrice(offeredUsd: number, maxPriceUsd: number): 'accept' | 'reject' | 'counter' {
    if (offeredUsd <= maxPriceUsd) return 'accept';
    if (offeredUsd <= maxPriceUsd * 1.1) return 'accept'; // 10% tolerance
    if (offeredUsd <= maxPriceUsd * 1.5) return 'counter'; // negotiable range
    return 'reject';
  }

  /**
   * Compute a counter-offer price.
   * A3: deterministic midpoint between our max and their offer.
   */
  computeCounterOffer(offeredUsd: number, maxPriceUsd: number): number {
    return (offeredUsd + maxPriceUsd) / 2;
  }

  /** Get all known peer prices for a task type. */
  getPeerPricesForType(taskType: string): Array<{ peerId: string; price: PeerPrice }> {
    const results: Array<{ peerId: string; price: PeerPrice }> = [];
    for (const [peerId, prices] of this.peerPrices) {
      const match = prices.find((p) => p.taskType === taskType && p.valid_until > Date.now());
      if (match) results.push({ peerId, price: match });
    }
    return results;
  }
}
