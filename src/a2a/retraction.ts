/**
 * Belief Retraction — RETRACT primitive for epistemic honesty.
 *
 * Proactive retraction BUILDS trust (A2: epistemic honesty).
 * Retraction spam (>threshold in window) DECREASES trust.
 * Pre-emptive storage: retraction arriving before the original is stored for later.
 *
 * Source of truth: Plan Phase G3
 */
import type { EventBus, VinyanBusEvents } from '../core/bus.ts';
import type { PeerTrustManager } from './peer-trust.ts';

export type RetractionTargetType = 'verdict' | 'knowledge' | 'rule' | 'event';
export type RetractionSeverity = 'advisory' | 'mandatory';
export type RetractionReason =
  | 'content_hash_mismatch'
  | 'backtesting_failure'
  | 'contradiction_detected'
  | 'stale_temporal_context'
  | 'manual';

export interface ECPRetraction {
  retraction_id: string;
  target_type: RetractionTargetType;
  target_id: string;
  severity: RetractionSeverity;
  reason: RetractionReason;
  replacement_id?: string;
  evidence?: Array<{ file: string; line: number; snippet: string }>;
  timestamp: number;
  peer_id: string;
}

export interface RetractionConfig {
  instanceId: string;
  bus?: EventBus<VinyanBusEvents>;
  trustManager?: PeerTrustManager;
  spamThreshold?: number;
  spamWindowMs?: number;
  preemptiveTtlMs?: number;
}

const DEFAULT_SPAM_THRESHOLD = 10;
const DEFAULT_SPAM_WINDOW_MS = 60_000;
const DEFAULT_PREEMPTIVE_TTL_MS = 300_000; // 5 min

function genId(): string {
  return `ret-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}

export class RetractionManager {
  private retractions = new Map<string, ECPRetraction>();
  private retractedTargets = new Set<string>();
  private preemptiveStore = new Map<string, ECPRetraction>();
  private peerTimestamps = new Map<string, number[]>();

  private spamThreshold: number;
  private spamWindowMs: number;
  private preemptiveTtlMs: number;

  constructor(private config: RetractionConfig) {
    this.spamThreshold = config.spamThreshold ?? DEFAULT_SPAM_THRESHOLD;
    this.spamWindowMs = config.spamWindowMs ?? DEFAULT_SPAM_WINDOW_MS;
    this.preemptiveTtlMs = config.preemptiveTtlMs ?? DEFAULT_PREEMPTIVE_TTL_MS;
  }

  retract(
    targetType: RetractionTargetType,
    targetId: string,
    severity: RetractionSeverity,
    reason: RetractionReason,
    options?: { replacementId?: string; evidence?: Array<{ file: string; line: number; snippet: string }> },
  ): ECPRetraction {
    const retraction: ECPRetraction = {
      retraction_id: genId(),
      target_type: targetType,
      target_id: targetId,
      severity,
      reason,
      replacement_id: options?.replacementId,
      evidence: options?.evidence,
      timestamp: Date.now(),
      peer_id: this.config.instanceId,
    };

    this.retractions.set(retraction.retraction_id, retraction);
    this.retractedTargets.add(targetId);
    return retraction;
  }

  handleRetraction(peerId: string, retraction: ECPRetraction): void {
    // Record timestamp for spam detection
    const timestamps = this.peerTimestamps.get(peerId) ?? [];
    timestamps.push(Date.now());
    this.peerTimestamps.set(peerId, timestamps);

    // Spam detection: count retractions in window
    const now = Date.now();
    const windowStart = now - this.spamWindowMs;
    const recentCount = timestamps.filter((t) => t >= windowStart).length;

    if (recentCount > this.spamThreshold) {
      // Spam — penalize trust
      this.config.trustManager?.recordInteraction(peerId, false);
    } else {
      // Proactive retraction builds trust (A2: epistemic honesty)
      this.config.trustManager?.recordInteraction(peerId, true);
    }

    // Store retraction
    this.retractions.set(retraction.retraction_id, retraction);
    this.retractedTargets.add(retraction.target_id);

    // If target not yet known locally, store as pre-emptive
    if (!this.retractedTargets.has(retraction.target_id)) {
      this.preemptiveStore.set(retraction.target_id, retraction);
    }

    this.config.bus?.emit('a2a:retractionReceived', {
      peerId,
      retractionId: retraction.retraction_id,
      targetId: retraction.target_id,
      severity: retraction.severity,
    });
  }

  isRetracted(targetId: string): boolean {
    return this.retractedTargets.has(targetId);
  }

  getRetractions(): ECPRetraction[] {
    return [...this.retractions.values()];
  }

  getPreemptive(targetId: string): ECPRetraction | undefined {
    return this.preemptiveStore.get(targetId);
  }

  cleanExpired(): number {
    const cutoff = Date.now() - this.preemptiveTtlMs;
    let count = 0;
    for (const [targetId, retraction] of this.preemptiveStore) {
      if (retraction.timestamp < cutoff) {
        this.preemptiveStore.delete(targetId);
        count++;
      }
    }

    // Also trim spam detection timestamps
    for (const [peerId, timestamps] of this.peerTimestamps) {
      const windowStart = Date.now() - this.spamWindowMs;
      const trimmed = timestamps.filter((t) => t >= windowStart);
      if (trimmed.length === 0) {
        this.peerTimestamps.delete(peerId);
      } else {
        this.peerTimestamps.set(peerId, trimmed);
      }
    }

    return count;
  }
}
