/**
 * Peer Discovery — fetch Agent Cards and detect Vinyan peers via `x-vinyan-ecp`.
 *
 * Fetches /.well-known/agent.json from configured peer URLs.
 * Vinyan peers are identified by the `x-vinyan-ecp` extension.
 *
 * Source of truth: Plan Phase D2
 */

import { getECPExtension, isVinyanPeer } from './agent-card.ts';
import type { A2AAgentCard, VinyanECPExtension } from './types.ts';
import { A2AAgentCardSchema } from './types.ts';

export interface DiscoveredPeer {
  url: string;
  card: A2AAgentCard;
  ecpExtension: VinyanECPExtension | null;
  isVinyan: boolean;
  discoveredAt: number;
}

export interface PeerDiscoveryConfig {
  /** Timeout for Agent Card fetch in ms. */
  fetchTimeoutMs?: number;
}

const DEFAULT_FETCH_TIMEOUT_MS = 5000;

/**
 * Fetch and validate an Agent Card from a peer URL.
 * Returns null if unreachable or invalid.
 */
export async function fetchAgentCard(peerUrl: string, config: PeerDiscoveryConfig = {}): Promise<A2AAgentCard | null> {
  const timeout = config.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const url = `${peerUrl.replace(/\/$/, '')}/.well-known/agent.json`;
    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);

    if (!response.ok) return null;

    const raw = await response.json();
    const result = A2AAgentCardSchema.safeParse(raw);
    return result.success ? result.data : null;
  } catch {
    clearTimeout(timer);
    return null;
  }
}

/**
 * Discover peers from a list of URLs.
 * Returns all reachable peers with their Agent Cards.
 */
export async function discoverPeers(peerUrls: string[], config: PeerDiscoveryConfig = {}): Promise<DiscoveredPeer[]> {
  const results = await Promise.allSettled(
    peerUrls.map(async (url) => {
      const card = await fetchAgentCard(url, config);
      if (!card) return null;

      return {
        url,
        card,
        ecpExtension: getECPExtension(card),
        isVinyan: isVinyanPeer(card),
        discoveredAt: Date.now(),
      } satisfies DiscoveredPeer;
    }),
  );

  return results
    .filter((r): r is PromiseFulfilledResult<DiscoveredPeer | null> => r.status === 'fulfilled')
    .map((r) => r.value)
    .filter((p): p is DiscoveredPeer => p !== null);
}

/**
 * Filter discovered peers to only Vinyan instances.
 */
export function filterVinyanPeers(peers: DiscoveredPeer[]): DiscoveredPeer[] {
  return peers.filter((p) => p.isVinyan);
}
