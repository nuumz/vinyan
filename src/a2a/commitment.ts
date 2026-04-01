/**
 * Commitment Tracking — COMMIT primitive for mutual obligations.
 *
 * Trust impact:
 *   fulfilled → recordInteraction(true)  — builds trust
 *   failed    → recordInteraction(false) — degrades trust
 *   withdrawn → neutral (honest about inability)
 *
 * Deadline enforcement: checkDeadlines() marks expired active commitments as failed.
 *
 * Source of truth: Plan Phase G2
 */
import type { EventBus, VinyanBusEvents } from '../core/bus.ts';
import type { PeerTrustManager } from './peer-trust.ts';

export type CommitmentStatus = 'active' | 'fulfilled' | 'failed' | 'withdrawn';
export type FulfillmentCriteriaType = 'task_complete' | 'verdict_delivered' | 'knowledge_shared' | 'custom';

export interface FulfillmentCriteria {
  type: FulfillmentCriteriaType;
  target_id?: string;
  description?: string;
}

export interface ECPCommitment {
  commitment_id: string;
  committer_instance_id: string;
  description: string;
  deadline: number;
  fulfillment_criteria: FulfillmentCriteria;
  status: CommitmentStatus;
  created_at: number;
  peer_id: string;
}

export interface CommitmentTrackerConfig {
  instanceId: string;
  bus?: EventBus<VinyanBusEvents>;
  trustManager?: PeerTrustManager;
}

function genId(): string {
  return `cmt-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}

export class CommitmentTracker {
  private commitments = new Map<string, ECPCommitment>();

  constructor(private config: CommitmentTrackerConfig) {}

  create(peerId: string, description: string, deadline: number, criteria: FulfillmentCriteria): ECPCommitment {
    const commitment: ECPCommitment = {
      commitment_id: genId(),
      committer_instance_id: this.config.instanceId,
      description,
      deadline,
      fulfillment_criteria: criteria,
      status: 'active',
      created_at: Date.now(),
      peer_id: peerId,
    };

    this.commitments.set(commitment.commitment_id, commitment);
    return commitment;
  }

  fulfill(commitmentId: string): boolean {
    const c = this.commitments.get(commitmentId);
    if (!c || c.status !== 'active') return false;

    c.status = 'fulfilled';
    this.config.trustManager?.recordInteraction(c.peer_id, true);
    return true;
  }

  fail(commitmentId: string, reason: string): boolean {
    const c = this.commitments.get(commitmentId);
    if (!c || c.status !== 'active') return false;

    c.status = 'failed';
    this.config.trustManager?.recordInteraction(c.peer_id, false);
    this.config.bus?.emit('a2a:commitmentFailed', {
      peerId: c.peer_id,
      commitmentId,
      reason,
    });
    return true;
  }

  withdraw(commitmentId: string): boolean {
    const c = this.commitments.get(commitmentId);
    if (!c || c.status !== 'active') return false;

    c.status = 'withdrawn';
    // No trust impact — honest about inability
    return true;
  }

  checkDeadlines(): string[] {
    const now = Date.now();
    const failed: string[] = [];

    for (const [id, c] of this.commitments) {
      if (c.status === 'active' && c.deadline < now) {
        c.status = 'failed';
        this.config.trustManager?.recordInteraction(c.peer_id, false);
        this.config.bus?.emit('a2a:commitmentFailed', {
          peerId: c.peer_id,
          commitmentId: id,
          reason: 'deadline_exceeded',
        });
        failed.push(id);
      }
    }

    return failed;
  }

  getActive(): ECPCommitment[] {
    return [...this.commitments.values()].filter((c) => c.status === 'active');
  }

  getByPeer(peerId: string): ECPCommitment[] {
    return [...this.commitments.values()].filter((c) => c.peer_id === peerId);
  }

  get(commitmentId: string): ECPCommitment | undefined {
    return this.commitments.get(commitmentId);
  }
}
