/**
 * PeerTrustManager tests — Phase D3.
 *
 * Tests Wilson LB trust progression, promotion, demotion, and inactivity decay.
 */
import { describe, expect, test } from 'bun:test';
import { PeerTrustManager } from '../../src/a2a/peer-trust.ts';
import { PEER_TRUST_CAPS } from '../../src/oracle/tier-clamp.ts';
import { wilsonLowerBound } from '../../src/sleep-cycle/wilson.ts';

// ── Registration ──────────────────────────────────────────────────────

describe('PeerTrustManager — registration', () => {
  test('registerPeer creates untrusted record with zeroed stats', () => {
    const mgr = new PeerTrustManager();
    const record = mgr.registerPeer('peer-a', 'instance-a');

    expect(record.peerId).toBe('peer-a');
    expect(record.instanceId).toBe('instance-a');
    expect(record.trustLevel).toBe('untrusted');
    expect(record.interactions).toBe(0);
    expect(record.accurate).toBe(0);
    expect(record.wilsonLB).toBe(0);
    expect(record.consecutiveFailures).toBe(0);
    expect(record.lastInteraction).toBeGreaterThan(0);
  });

  test('registerPeer is idempotent — returns existing record', () => {
    const mgr = new PeerTrustManager();
    const first = mgr.registerPeer('peer-a', 'instance-a');
    first.interactions = 5; // mutate the original

    const second = mgr.registerPeer('peer-a', 'instance-b');
    expect(second).toBe(first); // same reference
    expect(second.interactions).toBe(5);
    expect(second.instanceId).toBe('instance-a'); // not overwritten
  });
});

// ── Interaction Recording ─────────────────────────────────────────────

describe('PeerTrustManager — interactions', () => {
  test('accurate interaction increments interactions and accurate, resets failures', () => {
    const mgr = new PeerTrustManager();
    mgr.registerPeer('peer-a', 'inst-a');

    const record = mgr.recordInteraction('peer-a', true)!;
    expect(record.interactions).toBe(1);
    expect(record.accurate).toBe(1);
    expect(record.consecutiveFailures).toBe(0);
  });

  test('inaccurate interaction increments interactions and consecutiveFailures', () => {
    const mgr = new PeerTrustManager();
    mgr.registerPeer('peer-a', 'inst-a');

    const record = mgr.recordInteraction('peer-a', false)!;
    expect(record.interactions).toBe(1);
    expect(record.accurate).toBe(0);
    expect(record.consecutiveFailures).toBe(1);
  });

  test('accurate interaction resets consecutive failures', () => {
    const mgr = new PeerTrustManager();
    mgr.registerPeer('peer-a', 'inst-a');

    mgr.recordInteraction('peer-a', false);
    mgr.recordInteraction('peer-a', false);
    expect(mgr.getRecord('peer-a')!.consecutiveFailures).toBe(2);

    mgr.recordInteraction('peer-a', true);
    expect(mgr.getRecord('peer-a')!.consecutiveFailures).toBe(0);
  });

  test('recordInteraction returns null for unknown peer', () => {
    const mgr = new PeerTrustManager();
    expect(mgr.recordInteraction('unknown', true)).toBeNull();
  });

  test('wilsonLB is updated after each interaction', () => {
    const mgr = new PeerTrustManager();
    mgr.registerPeer('peer-a', 'inst-a');

    for (let i = 0; i < 5; i++) mgr.recordInteraction('peer-a', true);
    mgr.recordInteraction('peer-a', false);

    const record = mgr.getRecord('peer-a')!;
    const expected = wilsonLowerBound(5, 6);
    expect(record.wilsonLB).toBeCloseTo(expected, 10);
  });
});

// ── Promotion ─────────────────────────────────────────────────────────

describe('PeerTrustManager — promotion', () => {
  test('stays untrusted below promotionMinInteractions even with perfect accuracy', () => {
    const mgr = new PeerTrustManager();
    mgr.registerPeer('peer-a', 'inst-a');

    // 9 perfect interactions (below default min of 10)
    for (let i = 0; i < 9; i++) mgr.recordInteraction('peer-a', true);

    expect(mgr.getTrustLevel('peer-a')).toBe('untrusted');
  });

  test('promotes untrusted → provisional when Wilson LB >= 0.60 after min interactions', () => {
    const mgr = new PeerTrustManager();
    mgr.registerPeer('peer-a', 'inst-a');

    // 10/10 accurate → Wilson LB ≈ 0.72, above 0.60 threshold
    for (let i = 0; i < 10; i++) mgr.recordInteraction('peer-a', true);

    expect(mgr.getTrustLevel('peer-a')).toBe('provisional');
    expect(mgr.getRecord('peer-a')!.promotedAt).toBeGreaterThan(0);
  });

  test('does NOT promote when Wilson LB is below threshold', () => {
    const mgr = new PeerTrustManager();
    mgr.registerPeer('peer-a', 'inst-a');

    // 7 accurate + 3 inaccurate → Wilson LB ≈ 0.39, below 0.60
    for (let i = 0; i < 7; i++) mgr.recordInteraction('peer-a', true);
    for (let i = 0; i < 3; i++) mgr.recordInteraction('peer-a', false);

    expect(mgr.getTrustLevel('peer-a')).toBe('untrusted');
  });

  test('promotes provisional → established when Wilson LB >= 0.70', () => {
    const mgr = new PeerTrustManager();
    mgr.registerPeer('peer-a', 'inst-a');

    // 10/10 → untrusted→provisional (Wilson LB ≈ 0.72 >= 0.60)
    for (let i = 0; i < 10; i++) mgr.recordInteraction('peer-a', true);
    expect(mgr.getTrustLevel('peer-a')).toBe('provisional');

    // 11/11 → provisional→established (Wilson LB ≈ 0.74 >= 0.70)
    mgr.recordInteraction('peer-a', true);
    expect(mgr.getTrustLevel('peer-a')).toBe('established');
  });

  test('promotes established → trusted when Wilson LB >= 0.80', () => {
    const mgr = new PeerTrustManager();
    mgr.registerPeer('peer-a', 'inst-a');

    // Fast-forward to established (11 perfect interactions)
    for (let i = 0; i < 11; i++) mgr.recordInteraction('peer-a', true);
    expect(mgr.getTrustLevel('peer-a')).toBe('established');

    // Continue until Wilson LB >= 0.80 (around 17 perfect interactions)
    for (let i = 12; i <= 20; i++) mgr.recordInteraction('peer-a', true);

    expect(mgr.getTrustLevel('peer-a')).toBe('trusted');
  });

  test('trusted peer does not promote further', () => {
    const mgr = new PeerTrustManager();
    mgr.registerPeer('peer-a', 'inst-a');

    // Get to trusted
    for (let i = 0; i < 25; i++) mgr.recordInteraction('peer-a', true);
    expect(mgr.getTrustLevel('peer-a')).toBe('trusted');

    // More interactions don't change level
    for (let i = 0; i < 10; i++) mgr.recordInteraction('peer-a', true);
    expect(mgr.getTrustLevel('peer-a')).toBe('trusted');
  });

  test('custom config thresholds are respected', () => {
    const mgr = new PeerTrustManager({
      promotionMinInteractions: 3,
      untrustedPromotionLB: 0.3,
    });
    mgr.registerPeer('peer-a', 'inst-a');

    // 3/3 accurate → Wilson LB ≈ 0.44, above custom 0.30
    for (let i = 0; i < 3; i++) mgr.recordInteraction('peer-a', true);
    expect(mgr.getTrustLevel('peer-a')).toBe('provisional');
  });
});

// ── Demotion ──────────────────────────────────────────────────────────

describe('PeerTrustManager — demotion', () => {
  function buildTrustedPeer(mgr: PeerTrustManager, peerId: string): void {
    mgr.registerPeer(peerId, `inst-${peerId}`);
    for (let i = 0; i < 25; i++) mgr.recordInteraction(peerId, true);
  }

  test('5 consecutive failures demotes by one level', () => {
    const mgr = new PeerTrustManager();
    buildTrustedPeer(mgr, 'peer-a');
    expect(mgr.getTrustLevel('peer-a')).toBe('trusted');

    for (let i = 0; i < 5; i++) mgr.recordInteraction('peer-a', false);

    expect(mgr.getTrustLevel('peer-a')).toBe('established');
    expect(mgr.getRecord('peer-a')!.demotedAt).toBeGreaterThan(0);
  });

  test('demotion resets consecutiveFailures', () => {
    const mgr = new PeerTrustManager();
    buildTrustedPeer(mgr, 'peer-a');

    for (let i = 0; i < 5; i++) mgr.recordInteraction('peer-a', false);
    expect(mgr.getRecord('peer-a')!.consecutiveFailures).toBe(0);
  });

  test('successive demotions cascade through levels', () => {
    const mgr = new PeerTrustManager();
    buildTrustedPeer(mgr, 'peer-a');

    // trusted → established
    for (let i = 0; i < 5; i++) mgr.recordInteraction('peer-a', false);
    expect(mgr.getTrustLevel('peer-a')).toBe('established');

    // established → provisional
    for (let i = 0; i < 5; i++) mgr.recordInteraction('peer-a', false);
    expect(mgr.getTrustLevel('peer-a')).toBe('provisional');

    // provisional → untrusted
    for (let i = 0; i < 5; i++) mgr.recordInteraction('peer-a', false);
    expect(mgr.getTrustLevel('peer-a')).toBe('untrusted');
  });

  test('untrusted peer does not demote further', () => {
    const mgr = new PeerTrustManager();
    mgr.registerPeer('peer-a', 'inst-a');

    for (let i = 0; i < 10; i++) mgr.recordInteraction('peer-a', false);

    expect(mgr.getTrustLevel('peer-a')).toBe('untrusted');
  });

  test('demotion takes priority over promotion', () => {
    const mgr = new PeerTrustManager({ demotionConsecutiveFailures: 3 });
    buildTrustedPeer(mgr, 'peer-a');

    // 3 failures triggers demotion even though cumulative Wilson LB is high
    for (let i = 0; i < 3; i++) mgr.recordInteraction('peer-a', false);

    expect(mgr.getTrustLevel('peer-a')).toBe('established');
  });
});

// ── Inactivity Decay ──────────────────────────────────────────────────

describe('PeerTrustManager — inactivity decay', () => {
  test('demotes inactive peers by one level', () => {
    const mgr = new PeerTrustManager({ inactivityDecayMs: 1000 });
    mgr.registerPeer('peer-a', 'inst-a');

    // Manually promote to provisional
    for (let i = 0; i < 10; i++) mgr.recordInteraction('peer-a', true);
    expect(mgr.getTrustLevel('peer-a')).toBe('provisional');

    // Backdate lastInteraction
    mgr.getRecord('peer-a')!.lastInteraction = Date.now() - 2000;

    const decayed = mgr.applyInactivityDecay();
    expect(decayed).toContain('peer-a');
    expect(mgr.getTrustLevel('peer-a')).toBe('untrusted');
  });

  test('skips untrusted peers — cannot decay further', () => {
    const mgr = new PeerTrustManager({ inactivityDecayMs: 1000 });
    mgr.registerPeer('peer-a', 'inst-a');
    mgr.getRecord('peer-a')!.lastInteraction = Date.now() - 2000;

    const decayed = mgr.applyInactivityDecay();
    expect(decayed).not.toContain('peer-a');
    expect(mgr.getTrustLevel('peer-a')).toBe('untrusted');
  });

  test('does not decay peers with recent interaction', () => {
    const mgr = new PeerTrustManager({ inactivityDecayMs: 60_000 });
    mgr.registerPeer('peer-a', 'inst-a');
    for (let i = 0; i < 10; i++) mgr.recordInteraction('peer-a', true);

    const decayed = mgr.applyInactivityDecay();
    expect(decayed).toHaveLength(0);
    expect(mgr.getTrustLevel('peer-a')).toBe('provisional');
  });

  test('returns all demoted peer IDs', () => {
    const mgr = new PeerTrustManager({ inactivityDecayMs: 1000 });

    mgr.registerPeer('peer-a', 'inst-a');
    mgr.registerPeer('peer-b', 'inst-b');
    for (let i = 0; i < 10; i++) {
      mgr.recordInteraction('peer-a', true);
      mgr.recordInteraction('peer-b', true);
    }

    // Backdate both
    mgr.getRecord('peer-a')!.lastInteraction = Date.now() - 2000;
    mgr.getRecord('peer-b')!.lastInteraction = Date.now() - 2000;

    const decayed = mgr.applyInactivityDecay();
    expect(decayed).toHaveLength(2);
    expect(decayed).toContain('peer-a');
    expect(decayed).toContain('peer-b');
  });
});

// ── Utility Methods ───────────────────────────────────────────────────

describe('PeerTrustManager — utilities', () => {
  test('getTrustLevel returns untrusted for unknown peer', () => {
    const mgr = new PeerTrustManager();
    expect(mgr.getTrustLevel('nonexistent')).toBe('untrusted');
  });

  test('getConfidenceCap returns correct cap for each trust level', () => {
    const mgr = new PeerTrustManager();
    mgr.registerPeer('peer-a', 'inst-a');
    expect(mgr.getConfidenceCap('peer-a')).toBe(PEER_TRUST_CAPS.untrusted);

    // Promote to provisional
    for (let i = 0; i < 10; i++) mgr.recordInteraction('peer-a', true);
    expect(mgr.getConfidenceCap('peer-a')).toBe(PEER_TRUST_CAPS.provisional);
  });

  test('getConfidenceCap returns untrusted cap for unknown peer', () => {
    const mgr = new PeerTrustManager();
    expect(mgr.getConfidenceCap('nonexistent')).toBe(PEER_TRUST_CAPS.untrusted);
  });

  test('getAllPeers returns all registered peers', () => {
    const mgr = new PeerTrustManager();
    mgr.registerPeer('peer-a', 'inst-a');
    mgr.registerPeer('peer-b', 'inst-b');

    const peers = mgr.getAllPeers();
    expect(peers).toHaveLength(2);
    expect(peers.map((p) => p.peerId)).toEqual(expect.arrayContaining(['peer-a', 'peer-b']));
  });

  test('getRecord returns undefined for unknown peer', () => {
    const mgr = new PeerTrustManager();
    expect(mgr.getRecord('nonexistent')).toBeUndefined();
  });

  test('removePeer deletes the record', () => {
    const mgr = new PeerTrustManager();
    mgr.registerPeer('peer-a', 'inst-a');

    expect(mgr.removePeer('peer-a')).toBe(true);
    expect(mgr.getRecord('peer-a')).toBeUndefined();
    expect(mgr.getAllPeers()).toHaveLength(0);
  });

  test('removePeer returns false for unknown peer', () => {
    const mgr = new PeerTrustManager();
    expect(mgr.removePeer('nonexistent')).toBe(false);
  });
});
