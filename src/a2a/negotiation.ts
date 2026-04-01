/**
 * Negotiation Primitives — PROPOSE + AFFIRM for multi-instance coordination.
 *
 * State machine: proposed → countered → ... → affirmed | rejected | expired
 * Maps to A2A: PROPOSE = tasks/send with message_type "propose",
 *              AFFIRM = tasks/send with message_type "affirm".
 * Expired proposals are silently cleaned — no blocking.
 *
 * Source of truth: Plan Phase G1
 */
import type { EventBus, VinyanBusEvents } from '../core/bus.ts';

export type ProposalType =
  | 'task_split'
  | 'knowledge_exchange'
  | 'resource_sharing'
  | 'verification_delegation'
  | 'norm_adoption';

export type ProposalState = 'proposed' | 'countered' | 'affirmed' | 'rejected' | 'expired';

export interface EcpProposal {
  proposal_id: string;
  proposal_type: ProposalType;
  proposer_instance_id: string;
  terms: Record<string, unknown>;
  expires_at: number;
  max_rounds: number;
  round: number;
}

export interface EcpAffirm {
  proposal_id: string;
  commitments: string[];
}

export interface ProposalRecord {
  proposal: EcpProposal;
  state: ProposalState;
  peerId: string;
  history: Array<{ round: number; action: 'propose' | 'counter' | 'affirm' | 'reject'; timestamp: number }>;
}

export interface NegotiationConfig {
  instanceId: string;
  bus?: EventBus<VinyanBusEvents>;
  defaultExpiryMs?: number;
}

const DEFAULT_EXPIRY_MS = 60_000;

function genId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}

export class NegotiationManager {
  private proposals = new Map<string, ProposalRecord>();
  private config: Required<Pick<NegotiationConfig, 'instanceId' | 'defaultExpiryMs'>> & NegotiationConfig;

  constructor(config: NegotiationConfig) {
    this.config = {
      ...config,
      defaultExpiryMs: config.defaultExpiryMs ?? DEFAULT_EXPIRY_MS,
    };
  }

  propose(peerId: string, type: ProposalType, terms: Record<string, unknown>): EcpProposal {
    const proposal: EcpProposal = {
      proposal_id: genId('prop'),
      proposal_type: type,
      proposer_instance_id: this.config.instanceId,
      terms,
      expires_at: Date.now() + this.config.defaultExpiryMs,
      max_rounds: 3,
      round: 1,
    };

    this.proposals.set(proposal.proposal_id, {
      proposal,
      state: 'proposed',
      peerId,
      history: [{ round: 1, action: 'propose', timestamp: Date.now() }],
    });

    return proposal;
  }

  counterPropose(proposalId: string, newTerms: Record<string, unknown>): EcpProposal | null {
    const record = this.proposals.get(proposalId);
    if (!record) return null;
    if (record.state !== 'proposed' && record.state !== 'countered') return null;
    if (record.proposal.round >= record.proposal.max_rounds) return null;

    record.proposal.round += 1;
    record.proposal.terms = newTerms;
    record.state = 'countered';
    record.history.push({ round: record.proposal.round, action: 'counter', timestamp: Date.now() });

    return record.proposal;
  }

  affirm(proposalId: string, commitmentIds: string[] = []): EcpAffirm | null {
    const record = this.proposals.get(proposalId);
    if (!record) return null;
    if (record.state !== 'proposed' && record.state !== 'countered') return null;

    record.state = 'affirmed';
    record.history.push({ round: record.proposal.round, action: 'affirm', timestamp: Date.now() });

    return { proposal_id: proposalId, commitments: commitmentIds };
  }

  reject(proposalId: string): boolean {
    const record = this.proposals.get(proposalId);
    if (!record) return false;
    if (record.state !== 'proposed' && record.state !== 'countered') return false;

    record.state = 'rejected';
    record.history.push({ round: record.proposal.round, action: 'reject', timestamp: Date.now() });
    return true;
  }

  handleIncomingProposal(peerId: string, proposal: EcpProposal): void {
    this.proposals.set(proposal.proposal_id, {
      proposal,
      state: 'proposed',
      peerId,
      history: [{ round: proposal.round, action: 'propose', timestamp: Date.now() }],
    });

    this.config.bus?.emit('a2a:proposalReceived', {
      peerId,
      proposalId: proposal.proposal_id,
      proposalType: proposal.proposal_type,
    });
  }

  handleIncomingAffirm(peerId: string, affirmation: EcpAffirm): void {
    const record = this.proposals.get(affirmation.proposal_id);
    if (!record) return;

    record.state = 'affirmed';
    record.history.push({ round: record.proposal.round, action: 'affirm', timestamp: Date.now() });
  }

  getProposal(proposalId: string): ProposalRecord | undefined {
    return this.proposals.get(proposalId);
  }

  getActiveProposals(): ProposalRecord[] {
    return [...this.proposals.values()].filter((r) => r.state === 'proposed' || r.state === 'countered');
  }

  cleanExpired(): number {
    const now = Date.now();
    let count = 0;
    for (const [, record] of this.proposals) {
      if ((record.state === 'proposed' || record.state === 'countered') && record.proposal.expires_at < now) {
        record.state = 'expired';
        count++;
      }
    }
    return count;
  }
}
