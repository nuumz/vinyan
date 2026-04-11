/**
 * Commitment tracking tests — Phase G2.
 */
import { describe, expect, test } from 'bun:test';
import { CommitmentTracker, type FulfillmentCriteria } from '../../src/a2a/commitment.ts';
import { PeerTrustManager } from '../../src/a2a/peer-trust.ts';
import { EventBus, type VinyanBusEvents } from '../../src/core/bus.ts';

function makeBus(): EventBus<VinyanBusEvents> {
  return new EventBus<VinyanBusEvents>();
}

function makeTrust(): PeerTrustManager {
  const mgr = new PeerTrustManager();
  mgr.registerPeer('peer-A', 'inst-002');
  return mgr;
}

const CRITERIA: FulfillmentCriteria = { type: 'task_complete', target_id: 'task-001' };

describe('CommitmentTracker — create', () => {
  test('creates commitment with correct fields', () => {
    const tracker = new CommitmentTracker({ instanceId: 'inst-001' });
    const c = tracker.create('peer-A', 'Deliver verdict for auth.ts', Date.now() + 60_000, CRITERIA);

    expect(c.commitment_id).toMatch(/^cmt-/);
    expect(c.committer_instance_id).toBe('inst-001');
    expect(c.description).toBe('Deliver verdict for auth.ts');
    expect(c.status).toBe('active');
    expect(c.peer_id).toBe('peer-A');
    expect(c.fulfillment_criteria.type).toBe('task_complete');
  });

  test('generates unique IDs', () => {
    const tracker = new CommitmentTracker({ instanceId: 'inst-001' });
    const c1 = tracker.create('peer-A', 'desc1', Date.now() + 60_000, CRITERIA);
    const c2 = tracker.create('peer-A', 'desc2', Date.now() + 60_000, CRITERIA);
    expect(c1.commitment_id).not.toBe(c2.commitment_id);
  });

  test('defaults to active status', () => {
    const tracker = new CommitmentTracker({ instanceId: 'inst-001' });
    const c = tracker.create('peer-A', 'desc', Date.now() + 60_000, CRITERIA);
    expect(c.status).toBe('active');
  });
});

describe('CommitmentTracker — fulfill', () => {
  test('transitions to fulfilled', () => {
    const tracker = new CommitmentTracker({ instanceId: 'inst-001' });
    const c = tracker.create('peer-A', 'desc', Date.now() + 60_000, CRITERIA);

    expect(tracker.fulfill(c.commitment_id)).toBe(true);
    expect(tracker.get(c.commitment_id)!.status).toBe('fulfilled');
  });

  test('calls trust positive on fulfillment', () => {
    const trust = makeTrust();
    const tracker = new CommitmentTracker({ instanceId: 'inst-001', trustManager: trust });
    const c = tracker.create('peer-A', 'desc', Date.now() + 60_000, CRITERIA);

    tracker.fulfill(c.commitment_id);
    const record = trust.getRecord('peer-A');
    expect(record!.accurate).toBe(1);
    expect(record!.interactions).toBe(1);
  });

  test('rejects fulfillment of non-active commitment', () => {
    const tracker = new CommitmentTracker({ instanceId: 'inst-001' });
    const c = tracker.create('peer-A', 'desc', Date.now() + 60_000, CRITERIA);
    tracker.fulfill(c.commitment_id);

    expect(tracker.fulfill(c.commitment_id)).toBe(false); // already fulfilled
  });
});

describe('CommitmentTracker — fail', () => {
  test('transitions to failed', () => {
    const tracker = new CommitmentTracker({ instanceId: 'inst-001' });
    const c = tracker.create('peer-A', 'desc', Date.now() + 60_000, CRITERIA);

    expect(tracker.fail(c.commitment_id, 'timeout')).toBe(true);
    expect(tracker.get(c.commitment_id)!.status).toBe('failed');
  });

  test('calls trust negative on failure', () => {
    const trust = makeTrust();
    const tracker = new CommitmentTracker({ instanceId: 'inst-001', trustManager: trust });
    const c = tracker.create('peer-A', 'desc', Date.now() + 60_000, CRITERIA);

    tracker.fail(c.commitment_id, 'timeout');
    const record = trust.getRecord('peer-A');
    expect(record!.interactions).toBe(1);
    expect(record!.accurate).toBe(0);
  });

  test('emits a2a:commitmentFailed bus event', () => {
    const bus = makeBus();
    const events: any[] = [];
    bus.on('a2a:commitmentFailed', (e) => events.push(e));

    const tracker = new CommitmentTracker({ instanceId: 'inst-001', bus });
    const c = tracker.create('peer-A', 'desc', Date.now() + 60_000, CRITERIA);
    tracker.fail(c.commitment_id, 'peer_down');

    expect(events).toHaveLength(1);
    expect(events[0]!.reason).toBe('peer_down');
    expect(events[0]!.commitmentId).toBe(c.commitment_id);
  });
});

describe('CommitmentTracker — withdraw', () => {
  test('transitions to withdrawn', () => {
    const tracker = new CommitmentTracker({ instanceId: 'inst-001' });
    const c = tracker.create('peer-A', 'desc', Date.now() + 60_000, CRITERIA);

    expect(tracker.withdraw(c.commitment_id)).toBe(true);
    expect(tracker.get(c.commitment_id)!.status).toBe('withdrawn');
  });

  test('no trust impact on withdrawal', () => {
    const trust = makeTrust();
    const tracker = new CommitmentTracker({ instanceId: 'inst-001', trustManager: trust });
    const c = tracker.create('peer-A', 'desc', Date.now() + 60_000, CRITERIA);

    tracker.withdraw(c.commitment_id);
    const record = trust.getRecord('peer-A');
    expect(record!.interactions).toBe(0);
  });
});

describe('CommitmentTracker — checkDeadlines', () => {
  test('fails expired active commitments', () => {
    const bus = makeBus();
    const events: any[] = [];
    bus.on('a2a:commitmentFailed', (e) => events.push(e));

    const tracker = new CommitmentTracker({ instanceId: 'inst-001', bus });
    const c = tracker.create('peer-A', 'desc', Date.now() - 1000, CRITERIA); // already expired

    const failed = tracker.checkDeadlines();
    expect(failed).toHaveLength(1);
    expect(failed[0]).toBe(c.commitment_id);
    expect(tracker.get(c.commitment_id)!.status).toBe('failed');
    expect(events).toHaveLength(1);
  });

  test('skips non-expired commitments', () => {
    const tracker = new CommitmentTracker({ instanceId: 'inst-001' });
    tracker.create('peer-A', 'desc', Date.now() + 60_000, CRITERIA);

    expect(tracker.checkDeadlines()).toHaveLength(0);
  });

  test('returns all failed IDs', () => {
    const tracker = new CommitmentTracker({ instanceId: 'inst-001' });
    tracker.create('peer-A', 'desc1', Date.now() - 1000, CRITERIA);
    tracker.create('peer-B', 'desc2', Date.now() - 500, CRITERIA);
    tracker.create('peer-C', 'desc3', Date.now() + 60_000, CRITERIA); // not expired

    const failed = tracker.checkDeadlines();
    expect(failed).toHaveLength(2);
  });
});

describe('CommitmentTracker — queries', () => {
  test('getActive filters by status', () => {
    const tracker = new CommitmentTracker({ instanceId: 'inst-001' });
    tracker.create('peer-A', 'desc1', Date.now() + 60_000, CRITERIA);
    const c2 = tracker.create('peer-B', 'desc2', Date.now() + 60_000, CRITERIA);
    tracker.fulfill(c2.commitment_id);

    expect(tracker.getActive()).toHaveLength(1);
  });

  test('getByPeer filters by peer', () => {
    const tracker = new CommitmentTracker({ instanceId: 'inst-001' });
    tracker.create('peer-A', 'desc1', Date.now() + 60_000, CRITERIA);
    tracker.create('peer-A', 'desc2', Date.now() + 60_000, CRITERIA);
    tracker.create('peer-B', 'desc3', Date.now() + 60_000, CRITERIA);

    expect(tracker.getByPeer('peer-A')).toHaveLength(2);
    expect(tracker.getByPeer('peer-B')).toHaveLength(1);
    expect(tracker.getByPeer('peer-C')).toHaveLength(0);
  });
});
