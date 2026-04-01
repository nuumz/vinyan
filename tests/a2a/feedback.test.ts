/**
 * Knowledge feedback loop tests — Phase G4.
 */
import { describe, expect, test } from 'bun:test';
import { type EcpFeedback, FeedbackManager } from '../../src/a2a/feedback.ts';
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

function makeIncomingFeedback(overrides: Partial<EcpFeedback> = {}): EcpFeedback {
  return {
    feedback_id: `fb-${Date.now()}`,
    target_type: 'verdict',
    target_id: 'verdict-001',
    outcome: 'accurate',
    sender_instance_id: 'inst-002',
    timestamp: Date.now(),
    ...overrides,
  };
}

describe('FeedbackManager — sendFeedback', () => {
  test('creates feedback with correct fields', () => {
    const mgr = new FeedbackManager({ instanceId: 'inst-001' });
    const fb = mgr.sendFeedback('verdict', 'v-001', 'accurate', {
      details: 'matched expected output',
    });

    expect(fb).not.toBeNull();
    expect(fb!.feedback_id).toMatch(/^fb-/);
    expect(fb!.target_type).toBe('verdict');
    expect(fb!.target_id).toBe('v-001');
    expect(fb!.outcome).toBe('accurate');
    expect(fb!.sender_instance_id).toBe('inst-001');
    expect(fb!.details).toBe('matched expected output');
  });

  test('prevents duplicate feedback for same target+sender', () => {
    const mgr = new FeedbackManager({ instanceId: 'inst-001' });
    const fb1 = mgr.sendFeedback('verdict', 'v-001', 'accurate');
    const fb2 = mgr.sendFeedback('verdict', 'v-001', 'inaccurate'); // same target

    expect(fb1).not.toBeNull();
    expect(fb2).toBeNull();
  });

  test('allows feedback for different targets', () => {
    const mgr = new FeedbackManager({ instanceId: 'inst-001' });
    const fb1 = mgr.sendFeedback('verdict', 'v-001', 'accurate');
    const fb2 = mgr.sendFeedback('knowledge', 'k-001', 'inaccurate');

    expect(fb1).not.toBeNull();
    expect(fb2).not.toBeNull();
  });
});

describe('FeedbackManager — handleFeedback', () => {
  test('stores feedback and returns true', () => {
    const mgr = new FeedbackManager({ instanceId: 'inst-001' });
    const ok = mgr.handleFeedback('peer-A', makeIncomingFeedback());

    expect(ok).toBe(true);
  });

  test('emits a2a:feedbackReceived bus event', () => {
    const bus = makeBus();
    const events: any[] = [];
    bus.on('a2a:feedbackReceived', (e) => events.push(e));

    const mgr = new FeedbackManager({ instanceId: 'inst-001', bus });
    mgr.handleFeedback('peer-A', makeIncomingFeedback());

    expect(events).toHaveLength(1);
    expect(events[0]!.outcome).toBe('accurate');
  });

  test('accurate feedback builds trust', () => {
    const trust = makeTrust();
    const mgr = new FeedbackManager({ instanceId: 'inst-001', trustManager: trust });
    mgr.handleFeedback('peer-A', makeIncomingFeedback({ outcome: 'accurate' }));

    expect(trust.getRecord('peer-A')!.accurate).toBe(1);
  });

  test('inaccurate feedback degrades trust', () => {
    const trust = makeTrust();
    const mgr = new FeedbackManager({ instanceId: 'inst-001', trustManager: trust });
    mgr.handleFeedback('peer-A', makeIncomingFeedback({ outcome: 'inaccurate' }));

    const record = trust.getRecord('peer-A');
    expect(record!.interactions).toBe(1);
    expect(record!.accurate).toBe(0);
  });
});

describe('FeedbackManager — rate limiting', () => {
  test('rejects duplicate sender+target combination', () => {
    const mgr = new FeedbackManager({ instanceId: 'inst-001' });
    mgr.handleFeedback(
      'peer-A',
      makeIncomingFeedback({
        feedback_id: 'fb-1',
        target_id: 'v-001',
        sender_instance_id: 'inst-002',
      }),
    );
    const ok = mgr.handleFeedback(
      'peer-A',
      makeIncomingFeedback({
        feedback_id: 'fb-2',
        target_id: 'v-001',
        sender_instance_id: 'inst-002',
      }),
    );

    expect(ok).toBe(false);
  });

  test('allows different senders for same target', () => {
    const mgr = new FeedbackManager({ instanceId: 'inst-001' });
    const ok1 = mgr.handleFeedback(
      'peer-A',
      makeIncomingFeedback({
        sender_instance_id: 'inst-002',
      }),
    );
    const ok2 = mgr.handleFeedback(
      'peer-B',
      makeIncomingFeedback({
        feedback_id: 'fb-other',
        sender_instance_id: 'inst-003',
      }),
    );

    expect(ok1).toBe(true);
    expect(ok2).toBe(true);
  });
});

describe('FeedbackManager — getFeedbackSummary', () => {
  test('aggregates counts correctly', () => {
    const mgr = new FeedbackManager({ instanceId: 'inst-001' });
    mgr.handleFeedback(
      'peer-A',
      makeIncomingFeedback({ feedback_id: 'fb-1', target_id: 'v-001', outcome: 'accurate', sender_instance_id: 's1' }),
    );
    mgr.handleFeedback(
      'peer-B',
      makeIncomingFeedback({
        feedback_id: 'fb-2',
        target_id: 'v-001',
        outcome: 'inaccurate',
        sender_instance_id: 's2',
      }),
    );
    mgr.handleFeedback(
      'peer-C',
      makeIncomingFeedback({ feedback_id: 'fb-3', target_id: 'v-001', outcome: 'accurate', sender_instance_id: 's3' }),
    );

    const summary = mgr.getFeedbackSummary('v-001');
    expect(summary.accurate).toBe(2);
    expect(summary.inaccurate).toBe(1);
    expect(summary.total).toBe(3);
  });

  test('returns empty summary for unknown target', () => {
    const mgr = new FeedbackManager({ instanceId: 'inst-001' });
    const summary = mgr.getFeedbackSummary('unknown');

    expect(summary.total).toBe(0);
    expect(summary.accurate).toBe(0);
  });

  test('handles mixed outcomes', () => {
    const mgr = new FeedbackManager({ instanceId: 'inst-001' });
    mgr.handleFeedback(
      'peer-A',
      makeIncomingFeedback({
        feedback_id: 'fb-1',
        target_id: 'v-002',
        outcome: 'partially_accurate',
        sender_instance_id: 's1',
      }),
    );
    mgr.handleFeedback(
      'peer-B',
      makeIncomingFeedback({
        feedback_id: 'fb-2',
        target_id: 'v-002',
        outcome: 'inapplicable',
        sender_instance_id: 's2',
      }),
    );

    const summary = mgr.getFeedbackSummary('v-002');
    expect(summary.partially_accurate).toBe(1);
    expect(summary.inapplicable).toBe(1);
    expect(summary.total).toBe(2);
  });
});

describe('FeedbackManager — hasSentFeedback', () => {
  test('returns true after send', () => {
    const mgr = new FeedbackManager({ instanceId: 'inst-001' });
    mgr.sendFeedback('verdict', 'v-001', 'accurate');

    expect(mgr.hasSentFeedback('v-001', 'inst-001')).toBe(true);
  });

  test('returns false before send', () => {
    const mgr = new FeedbackManager({ instanceId: 'inst-001' });
    expect(mgr.hasSentFeedback('v-001', 'inst-001')).toBe(false);
  });
});
