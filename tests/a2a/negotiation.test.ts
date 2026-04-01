/**
 * Negotiation primitives tests — Phase G1.
 */
import { describe, expect, test } from 'bun:test';
import { type EcpProposal, NegotiationManager } from '../../src/a2a/negotiation.ts';
import { EventBus, type VinyanBusEvents } from '../../src/core/bus.ts';

function makeBus(): EventBus<VinyanBusEvents> {
  return new EventBus<VinyanBusEvents>();
}

function makeManager(bus?: EventBus<VinyanBusEvents>) {
  return new NegotiationManager({
    instanceId: 'inst-001',
    bus,
    defaultExpiryMs: 60_000,
  });
}

describe('NegotiationManager — propose', () => {
  test('creates valid proposal with correct fields', () => {
    const mgr = makeManager();
    const p = mgr.propose('peer-A', 'task_split', { files: ['a.ts', 'b.ts'] });

    expect(p.proposal_id).toMatch(/^prop-/);
    expect(p.proposal_type).toBe('task_split');
    expect(p.proposer_instance_id).toBe('inst-001');
    expect(p.terms).toEqual({ files: ['a.ts', 'b.ts'] });
    expect(p.max_rounds).toBe(3);
    expect(p.round).toBe(1);
    expect(p.expires_at).toBeGreaterThan(Date.now());
  });

  test('generates unique IDs for each proposal', () => {
    const mgr = makeManager();
    const p1 = mgr.propose('peer-A', 'task_split', {});
    const p2 = mgr.propose('peer-A', 'task_split', {});
    expect(p1.proposal_id).not.toBe(p2.proposal_id);
  });

  test('stores proposal as active with proposed state', () => {
    const mgr = makeManager();
    const p = mgr.propose('peer-A', 'knowledge_exchange', {});
    const record = mgr.getProposal(p.proposal_id);

    expect(record).toBeDefined();
    expect(record!.state).toBe('proposed');
    expect(record!.peerId).toBe('peer-A');
    expect(record!.history).toHaveLength(1);
    expect(record!.history[0]!.action).toBe('propose');
  });
});

describe('NegotiationManager — counterPropose', () => {
  test('increments round and updates terms', () => {
    const mgr = makeManager();
    const p = mgr.propose('peer-A', 'task_split', { split: '50/50' });
    const counter = mgr.counterPropose(p.proposal_id, { split: '70/30' });

    expect(counter).not.toBeNull();
    expect(counter!.round).toBe(2);
    expect(counter!.terms).toEqual({ split: '70/30' });
  });

  test('rejects counter at max_rounds', () => {
    const mgr = makeManager();
    const p = mgr.propose('peer-A', 'task_split', { v: 1 });
    mgr.counterPropose(p.proposal_id, { v: 2 }); // round 2
    mgr.counterPropose(p.proposal_id, { v: 3 }); // round 3
    const result = mgr.counterPropose(p.proposal_id, { v: 4 }); // round 4 — should fail

    expect(result).toBeNull();
  });

  test('returns null for unknown proposal', () => {
    const mgr = makeManager();
    expect(mgr.counterPropose('nonexistent', {})).toBeNull();
  });

  test('transitions state to countered', () => {
    const mgr = makeManager();
    const p = mgr.propose('peer-A', 'task_split', {});
    mgr.counterPropose(p.proposal_id, { new: true });

    expect(mgr.getProposal(p.proposal_id)!.state).toBe('countered');
    expect(mgr.getProposal(p.proposal_id)!.history).toHaveLength(2);
  });
});

describe('NegotiationManager — affirm/reject', () => {
  test('affirm transitions to affirmed and returns EcpAffirm', () => {
    const mgr = makeManager();
    const p = mgr.propose('peer-A', 'task_split', {});
    const aff = mgr.affirm(p.proposal_id, ['cmt-1', 'cmt-2']);

    expect(aff).not.toBeNull();
    expect(aff!.proposal_id).toBe(p.proposal_id);
    expect(aff!.commitments).toEqual(['cmt-1', 'cmt-2']);
    expect(mgr.getProposal(p.proposal_id)!.state).toBe('affirmed');
  });

  test('reject transitions to rejected', () => {
    const mgr = makeManager();
    const p = mgr.propose('peer-A', 'resource_sharing', {});
    const ok = mgr.reject(p.proposal_id);

    expect(ok).toBe(true);
    expect(mgr.getProposal(p.proposal_id)!.state).toBe('rejected');
  });

  test('affirm returns null for already rejected proposal', () => {
    const mgr = makeManager();
    const p = mgr.propose('peer-A', 'task_split', {});
    mgr.reject(p.proposal_id);

    expect(mgr.affirm(p.proposal_id)).toBeNull();
  });

  test('reject returns false for unknown proposal', () => {
    const mgr = makeManager();
    expect(mgr.reject('nonexistent')).toBe(false);
  });
});

describe('NegotiationManager — incoming', () => {
  test('stores remote proposal and emits bus event', () => {
    const bus = makeBus();
    const events: any[] = [];
    bus.on('a2a:proposalReceived', (e) => events.push(e));

    const mgr = makeManager(bus);
    const incoming: EcpProposal = {
      proposal_id: 'prop-remote-001',
      proposal_type: 'knowledge_exchange',
      proposer_instance_id: 'inst-002',
      terms: { patterns: 5 },
      expires_at: Date.now() + 60_000,
      max_rounds: 3,
      round: 1,
    };

    mgr.handleIncomingProposal('peer-B', incoming);

    const record = mgr.getProposal('prop-remote-001');
    expect(record).toBeDefined();
    expect(record!.peerId).toBe('peer-B');
    expect(events).toHaveLength(1);
    expect(events[0]!.proposalType).toBe('knowledge_exchange');
  });

  test('handles incoming affirm and updates state', () => {
    const mgr = makeManager();
    const p = mgr.propose('peer-B', 'task_split', {});
    mgr.handleIncomingAffirm('peer-B', { proposal_id: p.proposal_id, commitments: ['c1'] });

    expect(mgr.getProposal(p.proposal_id)!.state).toBe('affirmed');
  });

  test('incoming affirm for unknown proposal is ignored', () => {
    const mgr = makeManager();
    // Should not throw
    mgr.handleIncomingAffirm('peer-B', { proposal_id: 'unknown', commitments: [] });
  });
});

describe('NegotiationManager — expiry', () => {
  test('cleanExpired marks expired proposals', async () => {
    const mgr = new NegotiationManager({
      instanceId: 'inst-001',
      defaultExpiryMs: 10, // 10ms — will expire quickly
    });

    mgr.propose('peer-A', 'task_split', {});
    await new Promise((r) => setTimeout(r, 20)); // wait for expiry
    const cleaned = mgr.cleanExpired();

    expect(cleaned).toBe(1);
  });

  test('cleanExpired leaves non-expired alone', () => {
    const mgr = makeManager(); // 60s expiry
    mgr.propose('peer-A', 'task_split', {});

    expect(mgr.cleanExpired()).toBe(0);
  });
});

describe('NegotiationManager — queries', () => {
  test('getActiveProposals returns only proposed/countered', () => {
    const mgr = makeManager();
    mgr.propose('peer-A', 'task_split', {});
    const p2 = mgr.propose('peer-B', 'resource_sharing', {});
    mgr.reject(p2.proposal_id);

    expect(mgr.getActiveProposals()).toHaveLength(1);
  });

  test('getProposal returns undefined for unknown', () => {
    const mgr = makeManager();
    expect(mgr.getProposal('nonexistent')).toBeUndefined();
  });
});
