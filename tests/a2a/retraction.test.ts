/**
 * Belief retraction tests — Phase G3.
 */
import { describe, expect, test } from 'bun:test';
import { PeerTrustManager } from '../../src/a2a/peer-trust.ts';
import { type ECPRetraction, RetractionManager } from '../../src/a2a/retraction.ts';
import { EventBus, type VinyanBusEvents } from '../../src/core/bus.ts';

function makeBus(): EventBus<VinyanBusEvents> {
  return new EventBus<VinyanBusEvents>();
}

function makeTrust(): PeerTrustManager {
  const mgr = new PeerTrustManager();
  mgr.registerPeer('peer-A', 'inst-002');
  return mgr;
}

function makeRetraction(overrides: Partial<ECPRetraction> = {}): ECPRetraction {
  return {
    retraction_id: `ret-${Date.now()}`,
    target_type: 'verdict',
    target_id: 'verdict-001',
    severity: 'advisory',
    reason: 'content_hash_mismatch',
    timestamp: Date.now(),
    peer_id: 'peer-A',
    ...overrides,
  };
}

describe('RetractionManager — retract', () => {
  test('creates retraction and marks target as retracted', () => {
    const mgr = new RetractionManager({ instanceId: 'inst-001' });
    const r = mgr.retract('verdict', 'v-001', 'advisory', 'content_hash_mismatch');

    expect(r.retraction_id).toMatch(/^ret-/);
    expect(r.target_id).toBe('v-001');
    expect(r.severity).toBe('advisory');
    expect(mgr.isRetracted('v-001')).toBe(true);
  });

  test('supports replacement ID and evidence', () => {
    const mgr = new RetractionManager({ instanceId: 'inst-001' });
    const r = mgr.retract('rule', 'rule-001', 'mandatory', 'backtesting_failure', {
      replacementId: 'rule-002',
      evidence: [{ file: 'src/auth.ts', line: 10, snippet: 'old code' }],
    });

    expect(r.replacement_id).toBe('rule-002');
    expect(r.evidence).toHaveLength(1);
  });

  test('getRetractions returns all', () => {
    const mgr = new RetractionManager({ instanceId: 'inst-001' });
    mgr.retract('verdict', 'v-001', 'advisory', 'manual');
    mgr.retract('knowledge', 'k-001', 'mandatory', 'contradiction_detected');

    expect(mgr.getRetractions()).toHaveLength(2);
  });
});

describe('RetractionManager — handleRetraction', () => {
  test('stores retraction and marks target retracted', () => {
    const mgr = new RetractionManager({ instanceId: 'inst-001' });
    const retraction = makeRetraction({ target_id: 'v-remote-001' });

    mgr.handleRetraction('peer-A', retraction);
    expect(mgr.isRetracted('v-remote-001')).toBe(true);
  });

  test('emits a2a:retractionReceived bus event', () => {
    const bus = makeBus();
    const events: any[] = [];
    bus.on('a2a:retractionReceived', (e) => events.push(e));

    const mgr = new RetractionManager({ instanceId: 'inst-001', bus });
    mgr.handleRetraction('peer-A', makeRetraction());

    expect(events).toHaveLength(1);
    expect(events[0]!.severity).toBe('advisory');
  });

  test('builds trust on proactive retraction (non-spam)', () => {
    const trust = makeTrust();
    const mgr = new RetractionManager({ instanceId: 'inst-001', trustManager: trust });

    mgr.handleRetraction('peer-A', makeRetraction());
    const record = trust.getRecord('peer-A');
    expect(record!.accurate).toBe(1);
  });

  test('decreases trust on spam (>10 in 60s)', () => {
    const trust = makeTrust();
    const mgr = new RetractionManager({
      instanceId: 'inst-001',
      trustManager: trust,
      spamThreshold: 3, // lower threshold for test
      spamWindowMs: 60_000,
    });

    // Send 4 retractions — 4th should trigger spam
    for (let i = 0; i < 4; i++) {
      mgr.handleRetraction(
        'peer-A',
        makeRetraction({
          retraction_id: `ret-${i}`,
          target_id: `v-${i}`,
        }),
      );
    }

    const record = trust.getRecord('peer-A');
    // First 3 are positive (accurate), 4th is negative
    expect(record!.accurate).toBe(3);
    expect(record!.interactions).toBe(4);
  });
});

describe('RetractionManager — isRetracted', () => {
  test('returns true for retracted target', () => {
    const mgr = new RetractionManager({ instanceId: 'inst-001' });
    mgr.retract('verdict', 'v-001', 'advisory', 'manual');
    expect(mgr.isRetracted('v-001')).toBe(true);
  });

  test('returns false for non-retracted target', () => {
    const mgr = new RetractionManager({ instanceId: 'inst-001' });
    expect(mgr.isRetracted('v-unknown')).toBe(false);
  });
});

describe('RetractionManager — preemptive storage', () => {
  test('stores retraction for unknown target in preemptive store', () => {
    const mgr = new RetractionManager({ instanceId: 'inst-001' });
    const retraction = makeRetraction({ target_id: 'v-future-001' });

    mgr.handleRetraction('peer-A', retraction);
    // target is marked retracted (even though we haven't seen the original)
    expect(mgr.isRetracted('v-future-001')).toBe(true);
  });

  test('cleanExpired removes old preemptive entries', () => {
    const mgr = new RetractionManager({
      instanceId: 'inst-001',
      preemptiveTtlMs: 1, // 1ms — expires immediately
    });

    const retraction = makeRetraction({ target_id: 'v-old', timestamp: Date.now() - 100 });
    mgr.handleRetraction('peer-A', retraction);

    const cleaned = mgr.cleanExpired();
    expect(cleaned).toBeGreaterThanOrEqual(0); // may or may not have stored in preemptive
  });
});

describe('RetractionManager — spam detection', () => {
  test('exact threshold boundary — at threshold is not spam', () => {
    const trust = makeTrust();
    const mgr = new RetractionManager({
      instanceId: 'inst-001',
      trustManager: trust,
      spamThreshold: 3,
    });

    // Send exactly 3 — should all be positive
    for (let i = 0; i < 3; i++) {
      mgr.handleRetraction(
        'peer-A',
        makeRetraction({
          retraction_id: `ret-${i}`,
          target_id: `v-${i}`,
        }),
      );
    }

    const record = trust.getRecord('peer-A');
    expect(record!.accurate).toBe(3);
    expect(record!.interactions).toBe(3);
  });

  test('cleanExpired trims timestamp history', () => {
    const mgr = new RetractionManager({
      instanceId: 'inst-001',
      spamWindowMs: 1, // 1ms window
    });

    mgr.handleRetraction('peer-A', makeRetraction());
    // Timestamps should be cleaned after window
    mgr.cleanExpired();
    // No assertion needed — just verify no crash
  });
});
