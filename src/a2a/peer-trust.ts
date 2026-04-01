/**
 * Peer Trust Lifecycle — Wilson LB progression for A2A peers.
 *
 * Trust is empirical (A5), NOT declared. Progression:
 *   untrusted (0.25) → provisional (0.40) → established (0.50) → trusted (0.60)
 *
 * Promotion requires statistically significant accuracy measured by Wilson LB.
 * Demotion on consecutive failures or inactivity decay.
 *
 * Source of truth: Plan Phase D3
 */
import { wilsonLowerBound } from "../sleep-cycle/wilson.ts";
import { PEER_TRUST_CAPS, type PeerTrustLevel } from "../oracle/tier-clamp.ts";

export interface PeerTrustRecord {
  peerId: string;
  instanceId: string;
  trustLevel: PeerTrustLevel;
  interactions: number;
  accurate: number;
  wilsonLB: number;
  lastInteraction: number;
  promotedAt?: number;
  demotedAt?: number;
  consecutiveFailures: number;
}

export interface PeerTrustConfig {
  /** Min interactions to promote from untrusted → provisional. */
  promotionMinInteractions: number;
  /** Wilson LB threshold to promote from untrusted → provisional. */
  untrustedPromotionLB: number;
  /** Wilson LB threshold to promote from provisional → established. */
  provisionalPromotionLB: number;
  /** Wilson LB threshold to promote from established → trusted. */
  establishedPromotionLB: number;
  /** Consecutive failures to trigger demotion. */
  demotionConsecutiveFailures: number;
  /** Inactivity decay: ms after which trust decays one level. */
  inactivityDecayMs: number;
}

export const DEFAULT_PEER_TRUST_CONFIG: PeerTrustConfig = {
  promotionMinInteractions: 10,
  untrustedPromotionLB: 0.60,
  provisionalPromotionLB: 0.70,
  establishedPromotionLB: 0.80,
  demotionConsecutiveFailures: 5,
  inactivityDecayMs: 7 * 24 * 60 * 60 * 1000, // 7 days
};

const TRUST_LEVELS: PeerTrustLevel[] = ["untrusted", "provisional", "established", "trusted"];

export class PeerTrustManager {
  private peers = new Map<string, PeerTrustRecord>();
  private config: PeerTrustConfig;

  constructor(config: Partial<PeerTrustConfig> = {}) {
    this.config = { ...DEFAULT_PEER_TRUST_CONFIG, ...config };
  }

  /** Register a new peer or return existing record. */
  registerPeer(peerId: string, instanceId: string): PeerTrustRecord {
    const existing = this.peers.get(peerId);
    if (existing) return existing;

    const record: PeerTrustRecord = {
      peerId,
      instanceId,
      trustLevel: "untrusted",
      interactions: 0,
      accurate: 0,
      wilsonLB: 0,
      lastInteraction: Date.now(),
      consecutiveFailures: 0,
    };
    this.peers.set(peerId, record);
    return record;
  }

  /** Record an interaction outcome and evaluate trust transitions. */
  recordInteraction(peerId: string, wasAccurate: boolean): PeerTrustRecord | null {
    const record = this.peers.get(peerId);
    if (!record) return null;

    record.interactions++;
    if (wasAccurate) {
      record.accurate++;
      record.consecutiveFailures = 0;
    } else {
      record.consecutiveFailures++;
    }

    record.wilsonLB = wilsonLowerBound(record.accurate, record.interactions);
    record.lastInteraction = Date.now();

    // Check demotion first (consecutive failures)
    if (record.consecutiveFailures >= this.config.demotionConsecutiveFailures) {
      this.demote(record);
      return record;
    }

    // Check promotion
    this.evaluatePromotion(record);

    return record;
  }

  /** Get the current trust level for a peer. */
  getTrustLevel(peerId: string): PeerTrustLevel {
    return this.peers.get(peerId)?.trustLevel ?? "untrusted";
  }

  /** Get the confidence cap for a peer. */
  getConfidenceCap(peerId: string): number {
    return PEER_TRUST_CAPS[this.getTrustLevel(peerId)];
  }

  /** Get full trust record for a peer. */
  getRecord(peerId: string): PeerTrustRecord | undefined {
    return this.peers.get(peerId);
  }

  /** Get all registered peers. */
  getAllPeers(): PeerTrustRecord[] {
    return [...this.peers.values()];
  }

  /** Apply inactivity decay to all peers. */
  applyInactivityDecay(): string[] {
    const now = Date.now();
    const decayed: string[] = [];

    for (const record of this.peers.values()) {
      if (record.trustLevel === "untrusted") continue;

      const inactive = now - record.lastInteraction;
      if (inactive >= this.config.inactivityDecayMs) {
        this.demote(record);
        decayed.push(record.peerId);
      }
    }

    return decayed;
  }

  /** Remove a peer from tracking. */
  removePeer(peerId: string): boolean {
    return this.peers.delete(peerId);
  }

  // ── Private ────────────────────────────────────────────────────────

  private evaluatePromotion(record: PeerTrustRecord): void {
    if (record.interactions < this.config.promotionMinInteractions) return;

    const levelIndex = TRUST_LEVELS.indexOf(record.trustLevel);
    if (levelIndex >= TRUST_LEVELS.length - 1) return; // already at max

    const threshold = this.getPromotionThreshold(record.trustLevel);
    if (record.wilsonLB >= threshold) {
      record.trustLevel = TRUST_LEVELS[levelIndex + 1]!;
      record.promotedAt = Date.now();
    }
  }

  private demote(record: PeerTrustRecord): void {
    const levelIndex = TRUST_LEVELS.indexOf(record.trustLevel);
    if (levelIndex <= 0) return; // already at minimum

    record.trustLevel = TRUST_LEVELS[levelIndex - 1]!;
    record.demotedAt = Date.now();
    record.consecutiveFailures = 0;
  }

  private getPromotionThreshold(currentLevel: PeerTrustLevel): number {
    switch (currentLevel) {
      case "untrusted": return this.config.untrustedPromotionLB;
      case "provisional": return this.config.provisionalPromotionLB;
      case "established": return this.config.establishedPromotionLB;
      case "trusted": return 1.0; // can't promote beyond trusted
    }
  }
}
