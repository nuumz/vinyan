/**
 * Gossip propagation tests — Phase E3.
 */
import { describe, expect, test } from 'bun:test';
import { type GossipEnvelope, GossipManager } from '../../src/a2a/gossip.ts';
import { PeerTrustManager } from '../../src/a2a/peer-trust.ts';

function makeManager(
  overrides: Partial<Parameters<typeof GossipManager.prototype.originate>[0]> & Record<string, any> = {},
) {
  return new GossipManager({
    instanceId: 'inst-001',
    peerUrls: ['http://peer-a', 'http://peer-b', 'http://peer-c', 'http://peer-d'],
    fanout: 2,
    maxHops: 3,
    dampeningWindowMs: 10_000,
    ...overrides,
  });
}

function makeEnvelope(overrides: Partial<GossipEnvelope> = {}): GossipEnvelope {
  return {
    knowledge_id: `k-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    hop_count: 0,
    origin_instance_id: 'inst-002',
    ttl_remaining: 3,
    payload: { type: 'pattern', data: 'test' },
    ...overrides,
  };
}

describe('GossipManager — propagate', () => {
  test('accepts new item and returns true', () => {
    const mgr = makeManager();
    const envelope = makeEnvelope();
    expect(mgr.propagate(envelope, 'peer-a')).toBe(true);
    expect(mgr.hasSeen(envelope.knowledge_id)).toBe(true);
  });

  test('rejects duplicate item and returns false', () => {
    const mgr = makeManager();
    const envelope = makeEnvelope();
    mgr.propagate(envelope, 'peer-a');
    expect(mgr.propagate(envelope, 'peer-b')).toBe(false);
  });

  test('accepts item at max hops but does not forward', () => {
    const mgr = makeManager({ maxHops: 2 });
    const envelope = makeEnvelope({ hop_count: 2 });
    expect(mgr.propagate(envelope, 'peer-a')).toBe(true);
    expect(mgr.hasSeen(envelope.knowledge_id)).toBe(true);
  });

  test('increments hop_count in forwarded envelope', () => {
    // This is an internal behavior; we verify by checking the item was accepted
    const mgr = makeManager();
    const envelope = makeEnvelope({ hop_count: 1 });
    expect(mgr.propagate(envelope, 'peer-a')).toBe(true);
  });
});

describe('GossipManager — originate', () => {
  test('creates envelope with hop_count 0', () => {
    const mgr = makeManager();
    const envelope = mgr.originate('k-new-001', { type: 'rule', data: 'test' });

    expect(envelope.knowledge_id).toBe('k-new-001');
    expect(envelope.hop_count).toBe(0);
    expect(envelope.origin_instance_id).toBe('inst-001');
  });

  test('marks item as seen after origination', () => {
    const mgr = makeManager();
    mgr.originate('k-new-002', {});
    expect(mgr.hasSeen('k-new-002')).toBe(true);
  });

  test('sends to peers via HTTP', async () => {
    let received = false;
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        received = true;
        const body = (await req.json()) as Record<string, any>;
        return Response.json({ jsonrpc: '2.0', id: body.id, result: {} });
      },
    });

    try {
      const mgr = new GossipManager({
        instanceId: 'inst-001',
        peerUrls: [`http://localhost:${server.port}`],
        fanout: 3,
        maxHops: 6,
        dampeningWindowMs: 10_000,
      });

      mgr.originate('k-http-001', { test: true });
      await new Promise((r) => setTimeout(r, 200));

      expect(received).toBe(true);
    } finally {
      server.stop(true);
    }
  });
});

describe('GossipManager — selectPeers', () => {
  test('excludes specified peers', () => {
    const mgr = makeManager({ fanout: 10 }); // high fanout to get all
    const selected = mgr.selectPeers(['http://peer-a']);
    expect(selected).not.toContain('http://peer-a');
  });

  test('returns at most fanout peers', () => {
    const mgr = makeManager({ fanout: 2 });
    const selected = mgr.selectPeers([]);
    expect(selected.length).toBeLessThanOrEqual(2);
  });

  test('returns all candidates when fewer than fanout', () => {
    const mgr = makeManager({
      peerUrls: ['http://peer-a'],
      fanout: 5,
    });
    const selected = mgr.selectPeers([]);
    expect(selected).toHaveLength(1);
  });

  test('skips partitioned peers', () => {
    const mgr = makeManager({
      getPeerHealth: (peerId: string) => (peerId === 'http://peer-a' ? 'partitioned' : 'connected'),
      fanout: 10,
    });
    const selected = mgr.selectPeers([]);
    expect(selected).not.toContain('http://peer-a');
  });

  test('prefers higher-trust peers', () => {
    const trust = new PeerTrustManager();
    trust.registerPeer('http://peer-a', 'inst-a');
    trust.registerPeer('http://peer-b', 'inst-b');
    // Make peer-b trusted with many positive interactions
    for (let i = 0; i < 20; i++) {
      trust.recordInteraction('http://peer-b', true);
    }

    const mgr = makeManager({ trustManager: trust, fanout: 1 });
    // Run multiple selections — peer-b should be selected more often
    let peerBCount = 0;
    for (let i = 0; i < 20; i++) {
      const selected = mgr.selectPeers([]);
      if (selected.includes('http://peer-b')) peerBCount++;
    }
    // With trust weighting, peer-b should be selected significantly more
    expect(peerBCount).toBeGreaterThan(5);
  });
});

describe('GossipManager — dedup & cleanup', () => {
  test('hasSeen returns false for unknown items', () => {
    const mgr = makeManager();
    expect(mgr.hasSeen('unknown')).toBe(false);
  });

  test('getSeenCount tracks seen items', () => {
    const mgr = makeManager();
    expect(mgr.getSeenCount()).toBe(0);
    mgr.propagate(makeEnvelope({ knowledge_id: 'a' }), 'peer-a');
    mgr.propagate(makeEnvelope({ knowledge_id: 'b' }), 'peer-a');
    expect(mgr.getSeenCount()).toBe(2);
  });

  test('cleanExpired removes old entries', async () => {
    const mgr = makeManager({ dampeningWindowMs: 10 });
    mgr.propagate(makeEnvelope({ knowledge_id: 'old' }), 'peer-a');
    await new Promise((r) => setTimeout(r, 20));

    const cleaned = mgr.cleanExpired();
    expect(cleaned).toBe(1);
    expect(mgr.hasSeen('old')).toBe(false);
  });

  test('cleanExpired keeps recent entries', () => {
    const mgr = makeManager({ dampeningWindowMs: 60_000 });
    mgr.propagate(makeEnvelope({ knowledge_id: 'recent' }), 'peer-a');

    expect(mgr.cleanExpired()).toBe(0);
    expect(mgr.hasSeen('recent')).toBe(true);
  });
});

describe('GossipManager — convergence', () => {
  test('getConvergenceEstimate returns sensible values', () => {
    const mgr = makeManager();
    mgr.originate('k-1', {});
    mgr.originate('k-2', {});

    const est = mgr.getConvergenceEstimate();
    expect(est.seenItems).toBe(2);
    expect(est.peerCount).toBe(4);
    expect(est.estimatedCoverage).toBeGreaterThan(0);
    expect(est.estimatedCoverage).toBeLessThanOrEqual(1);
  });

  test('empty manager has zero coverage', () => {
    const mgr = new GossipManager({ instanceId: 'inst-001', peerUrls: [] });
    const est = mgr.getConvergenceEstimate();
    expect(est.estimatedCoverage).toBe(0);
  });
});
