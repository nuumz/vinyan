/**
 * Cross-Instance Trust Attestation Sharing — D4.
 *
 * Allows peers to share trust observations about other peers.
 * Integration is Bayesian-weighted: local data always dominates.
 *
 * Constraints:
 *   - MAX_REMOTE_TRUST = 0.40 (remote attestations alone can never push above this)
 *   - Hop decay: 1.0 → 0.5 → 0.25 → dropped (max 3 hops)
 *   - Anti-Sybil: min 20 interactions to attest, max 3 attesters per subject
 *   - Proactive retraction: trust attestation builds trust for the attester
 *
 * Source of truth: Plan Phase D4
 */

import type { PeerTrustLevel } from '../oracle/tier-clamp.ts';
import { wilsonLowerBound } from '../sleep-cycle/wilson.ts';
import type { PeerTrustManager, PeerTrustRecord } from './peer-trust.ts';

export interface TrustAttestation {
  subject_instance_id: string;
  attester_instance_id: string;
  interactions: number;
  accurate: number;
  wilson_lb: number;
  attestation_age_ms: number;
  hop_count: number;
  timestamp: number;
}

export interface TrustAttestationConfig {
  instanceId: string;
  trustManager?: PeerTrustManager;
  /** Max trust level achievable from remote attestations alone. */
  maxRemoteTrust?: number;
  /** Min interactions before this instance can attest about a peer. */
  minInteractionsToAttest?: number;
  /** Max attesters per subject (anti-Sybil). */
  maxAttestersPerSubject?: number;
  /** Max hop count before attestation is dropped. */
  maxHops?: number;
}

const DEFAULT_MAX_REMOTE_TRUST = 0.4;
const DEFAULT_MIN_INTERACTIONS = 20;
const DEFAULT_MAX_ATTESTERS = 3;
const DEFAULT_MAX_HOPS = 3;

// Hop decay factors: direct=1.0, 1-hop=0.5, 2-hop=0.25, 3-hop=dropped
const HOP_DECAY = [1.0, 0.5, 0.25] as const;

interface AttestationRecord {
  attestation: TrustAttestation;
  receivedAt: number;
  attesterTrust: PeerTrustLevel;
}

export class TrustAttestationManager {
  private attestations = new Map<string, AttestationRecord[]>(); // subject_id → attestations
  private maxRemoteTrust: number;
  private minInteractions: number;
  private maxAttesters: number;
  private maxHops: number;

  constructor(private config: TrustAttestationConfig) {
    this.maxRemoteTrust = config.maxRemoteTrust ?? DEFAULT_MAX_REMOTE_TRUST;
    this.minInteractions = config.minInteractionsToAttest ?? DEFAULT_MIN_INTERACTIONS;
    this.maxAttesters = config.maxAttestersPerSubject ?? DEFAULT_MAX_ATTESTERS;
    this.maxHops = config.maxHops ?? DEFAULT_MAX_HOPS;
  }

  /**
   * Generate a trust attestation about a known peer.
   * Returns null if insufficient interactions (anti-Sybil).
   */
  generateAttestation(subjectPeerId: string): TrustAttestation | null {
    const record = this.config.trustManager?.getRecord(subjectPeerId);
    if (!record) return null;
    if (record.interactions < this.minInteractions) return null;

    return {
      subject_instance_id: record.instanceId,
      attester_instance_id: this.config.instanceId,
      interactions: record.interactions,
      accurate: record.accurate,
      wilson_lb: record.wilsonLB,
      attestation_age_ms: Date.now() - record.lastInteraction,
      hop_count: 0, // direct experience
      timestamp: Date.now(),
    };
  }

  /**
   * Integrate a received trust attestation.
   * Bayesian-weighted: local data dominates, remote attestations are discounted.
   * Returns the integrated trust estimate, or null if attestation was rejected.
   */
  integrateAttestation(
    attestation: TrustAttestation,
    attesterTrust: PeerTrustLevel,
  ): { accepted: boolean; reason?: string; integratedWilsonLB?: number } {
    // Reject if hop count exceeds max
    if (attestation.hop_count >= this.maxHops) {
      return { accepted: false, reason: 'max_hops_exceeded' };
    }

    const subjectId = attestation.subject_instance_id;
    const existing = this.attestations.get(subjectId) ?? [];

    // Anti-Sybil: max attesters per subject
    const uniqueAttesters = new Set(existing.map((r) => r.attestation.attester_instance_id));
    if (!uniqueAttesters.has(attestation.attester_instance_id) && uniqueAttesters.size >= this.maxAttesters) {
      return { accepted: false, reason: 'max_attesters_reached' };
    }

    // Replace existing attestation from same attester, or add new
    const filtered = existing.filter((r) => r.attestation.attester_instance_id !== attestation.attester_instance_id);
    filtered.push({
      attestation,
      receivedAt: Date.now(),
      attesterTrust,
    });
    this.attestations.set(subjectId, filtered);

    // Compute integrated Wilson LB
    const integrated = this.computeIntegratedTrust(subjectId);

    return { accepted: true, integratedWilsonLB: integrated };
  }

  /**
   * Compute integrated trust from all attestations for a subject.
   * Weighted average with hop decay and attester trust weighting.
   * Capped at maxRemoteTrust.
   */
  computeIntegratedTrust(subjectId: string): number {
    const records = this.attestations.get(subjectId);
    if (!records || records.length === 0) return 0;

    let weightedSum = 0;
    let totalWeight = 0;

    for (const record of records) {
      const hopDecay = record.attestation.hop_count < HOP_DECAY.length ? HOP_DECAY[record.attestation.hop_count]! : 0;

      if (hopDecay === 0) continue;

      // Weight by attester trust level
      const attesterWeight = this.attesterTrustWeight(record.attesterTrust);
      const weight = hopDecay * attesterWeight;

      // Use the attestation's Wilson LB as the signal
      weightedSum += record.attestation.wilson_lb * weight;
      totalWeight += weight;
    }

    if (totalWeight === 0) return 0;

    const integrated = weightedSum / totalWeight;
    return Math.min(integrated, this.maxRemoteTrust);
  }

  /**
   * Get all attestations for a subject.
   */
  getAttestations(subjectId: string): TrustAttestation[] {
    return (this.attestations.get(subjectId) ?? []).map((r) => r.attestation);
  }

  /**
   * Get count of unique subjects with attestations.
   */
  getSubjectCount(): number {
    return this.attestations.size;
  }

  /**
   * Clean expired attestations (older than maxAge).
   */
  cleanExpired(maxAgeMs: number): number {
    const cutoff = Date.now() - maxAgeMs;
    let count = 0;
    for (const [subjectId, records] of this.attestations) {
      const filtered = records.filter((r) => r.receivedAt >= cutoff);
      count += records.length - filtered.length;
      if (filtered.length === 0) {
        this.attestations.delete(subjectId);
      } else {
        this.attestations.set(subjectId, filtered);
      }
    }
    return count;
  }

  private attesterTrustWeight(trustLevel: PeerTrustLevel): number {
    switch (trustLevel) {
      case 'trusted':
        return 1.0;
      case 'established':
        return 0.75;
      case 'provisional':
        return 0.5;
      case 'untrusted':
        return 0.25;
      default:
        return 0.25;
    }
  }
}
