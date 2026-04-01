/**
 * Peer Discovery tests — Phase D2.
 *
 * Tests Agent Card fetching, peer discovery, and Vinyan peer filtering.
 * Uses Bun.serve with port: 0 for HTTP mock servers.
 */
import { describe, expect, test } from 'bun:test';
import { discoverPeers, fetchAgentCard, filterVinyanPeers } from '../../src/a2a/peer-discovery.ts';
import type { A2AAgentCard } from '../../src/a2a/types.ts';

/** Build a minimal valid Agent Card for testing. */
function makeAgentCard(overrides: Partial<A2AAgentCard> = {}): A2AAgentCard {
  return {
    name: 'Test Agent',
    description: 'A test agent',
    url: 'http://localhost:0',
    version: '1.0.0',
    capabilities: { streaming: false, pushNotifications: false },
    skills: [],
    ...overrides,
  };
}

/** Build a Vinyan Agent Card with x-vinyan-ecp extension. */
function makeVinyanCard(overrides: Partial<A2AAgentCard> = {}): A2AAgentCard {
  return makeAgentCard({
    name: 'Vinyan ENS',
    'x-vinyan-ecp': {
      protocol: 'vinyan-ecp',
      ecp_version: 1,
      instance_id: 'test-instance-001',
      public_key: 'pk-test-001',
      capability_version: 1,
      oracle_capabilities: [{ name: 'ast-oracle', tier: 'deterministic', languages: ['typescript'] }],
      features: ['knowledge_sharing'],
    },
    ...overrides,
  });
}

// ── fetchAgentCard ────────────────────────────────────────────────────

describe('fetchAgentCard', () => {
  test('fetches and parses a valid Agent Card', async () => {
    const card = makeAgentCard();
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        if (new URL(req.url).pathname === '/.well-known/agent.json') {
          return Response.json(card);
        }
        return new Response('Not Found', { status: 404 });
      },
    });

    try {
      const result = await fetchAgentCard(`http://localhost:${server.port}`);
      expect(result).not.toBeNull();
      expect(result!.name).toBe('Test Agent');
      expect(result!.version).toBe('1.0.0');
    } finally {
      server.stop(true);
    }
  });

  test('returns null for unreachable peer', async () => {
    // Port 19998 — nothing listening
    const result = await fetchAgentCard('http://localhost:19998', { fetchTimeoutMs: 500 });
    expect(result).toBeNull();
  });

  test('returns null for HTTP 404', async () => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response('Not Found', { status: 404 });
      },
    });

    try {
      const result = await fetchAgentCard(`http://localhost:${server.port}`);
      expect(result).toBeNull();
    } finally {
      server.stop(true);
    }
  });

  test('returns null for HTTP 500', async () => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response('Internal Server Error', { status: 500 });
      },
    });

    try {
      const result = await fetchAgentCard(`http://localhost:${server.port}`);
      expect(result).toBeNull();
    } finally {
      server.stop(true);
    }
  });

  test('returns null for invalid JSON', async () => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response('not json {{{', { headers: { 'Content-Type': 'application/json' } });
      },
    });

    try {
      const result = await fetchAgentCard(`http://localhost:${server.port}`);
      expect(result).toBeNull();
    } finally {
      server.stop(true);
    }
  });

  test('returns null for JSON that fails schema validation', async () => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        // Missing required fields: description, url, version, capabilities, skills
        return Response.json({ name: 'Incomplete' });
      },
    });

    try {
      const result = await fetchAgentCard(`http://localhost:${server.port}`);
      expect(result).toBeNull();
    } finally {
      server.stop(true);
    }
  });

  test('respects timeout — slow server returns null', async () => {
    const server = Bun.serve({
      port: 0,
      async fetch() {
        await new Promise((resolve) => setTimeout(resolve, 5000));
        return Response.json(makeAgentCard());
      },
    });

    try {
      const result = await fetchAgentCard(`http://localhost:${server.port}`, {
        fetchTimeoutMs: 100,
      });
      expect(result).toBeNull();
    } finally {
      server.stop(true);
    }
  });

  test('strips trailing slash from URL', async () => {
    let requestedPath = '';
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        requestedPath = new URL(req.url).pathname;
        return Response.json(makeAgentCard());
      },
    });

    try {
      await fetchAgentCard(`http://localhost:${server.port}/`);
      expect(requestedPath).toBe('/.well-known/agent.json');
    } finally {
      server.stop(true);
    }
  });
});

// ── discoverPeers ─────────────────────────────────────────────────────

describe('discoverPeers', () => {
  test('discovers reachable peers with correct structure', async () => {
    const card = makeVinyanCard();
    const server = Bun.serve({
      port: 0,
      fetch() {
        return Response.json(card);
      },
    });

    try {
      const url = `http://localhost:${server.port}`;
      const peers = await discoverPeers([url]);
      expect(peers).toHaveLength(1);
      expect(peers[0]!.url).toBe(url);
      expect(peers[0]!.card.name).toBe('Vinyan ENS');
      expect(peers[0]!.isVinyanPeer).toBe(true);
      expect(peers[0]!.ecpExtension).not.toBeNull();
      expect(peers[0]!.discoveredAt).toBeGreaterThan(0);
    } finally {
      server.stop(true);
    }
  });

  test('filters out unreachable peers', async () => {
    const card = makeAgentCard();
    const server = Bun.serve({
      port: 0,
      fetch() {
        return Response.json(card);
      },
    });

    try {
      const peers = await discoverPeers(
        [
          `http://localhost:${server.port}`,
          'http://localhost:19997', // unreachable
        ],
        { fetchTimeoutMs: 500 },
      );

      expect(peers).toHaveLength(1);
      expect(peers[0]!.url).toBe(`http://localhost:${server.port}`);
    } finally {
      server.stop(true);
    }
  });

  test('isVinyanPeer is false for non-Vinyan cards', async () => {
    const card = makeAgentCard(); // no x-vinyan-ecp
    const server = Bun.serve({
      port: 0,
      fetch() {
        return Response.json(card);
      },
    });

    try {
      const peers = await discoverPeers([`http://localhost:${server.port}`]);
      expect(peers).toHaveLength(1);
      expect(peers[0]!.isVinyanPeer).toBe(false);
      expect(peers[0]!.ecpExtension).toBeNull();
    } finally {
      server.stop(true);
    }
  });

  test('returns empty array for empty URL list', async () => {
    const peers = await discoverPeers([]);
    expect(peers).toHaveLength(0);
  });

  test('returns empty array when all peers unreachable', async () => {
    const peers = await discoverPeers(['http://localhost:19996', 'http://localhost:19995'], { fetchTimeoutMs: 500 });
    expect(peers).toHaveLength(0);
  });
});

// ── filterVinyanPeers ─────────────────────────────────────────────────

describe('filterVinyanPeers', () => {
  const now = Date.now();

  const vinyanPeer = {
    url: 'http://peer-1:3928',
    card: makeVinyanCard(),
    ecpExtension: makeVinyanCard()['x-vinyan-ecp']!,
    isVinyanPeer: true,
    discoveredAt: now,
  };

  const genericPeer = {
    url: 'http://peer-2:3928',
    card: makeAgentCard(),
    ecpExtension: null,
    isVinyanPeer: false,
    discoveredAt: now,
  };

  test('filters to only Vinyan peers', () => {
    const result = filterVinyanPeers([vinyanPeer, genericPeer]);
    expect(result).toHaveLength(1);
    expect(result[0]!.url).toBe('http://peer-1:3928');
  });

  test('returns empty when no Vinyan peers', () => {
    const result = filterVinyanPeers([genericPeer]);
    expect(result).toHaveLength(0);
  });

  test('returns all when all are Vinyan', () => {
    const result = filterVinyanPeers([vinyanPeer, { ...vinyanPeer, url: 'http://peer-3:3928' }]);
    expect(result).toHaveLength(2);
  });
});
