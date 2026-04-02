/**
 * Peers View — Tab 3: A2A peer network with trust and health.
 *
 * Layout (left-right split):
 *   ┌─ Peers (3) ─────────────────┐   ┌─ inst-02 ─────────────────────┐
 *   │  Peer       Trust   Health   │   │ Peer: inst-02                 │
 *   │ ▸ inst-02  trusted  ● conn  │   │ Trust: trusted  Health: conn  │
 *   │   inst-05  prov     ● conn  │   │ Capabilities: ...             │
 *   └─────────────────────────────-┘   └───────────────────────────────┘
 */

import { ANSI, bold, color, dim, formatDuration, padEnd, panel, sideBySide, truncate } from '../renderer.ts';
import type { PeerDisplayState, PeerSortField, SortConfig, TUIState } from '../types.ts';

export function renderPeers(state: TUIState): string {
  const { termWidth, termHeight } = state;
  const viewHeight = termHeight - 4; // header + spacing (1/2) + tab bar + hints
  const leftW = Math.floor(termWidth * 0.5);
  const rightW = termWidth - leftW - 1; // 1 gap

  const allPeers = [...state.peers.values()];
  const filtered = state.filterQuery
    ? allPeers.filter((p) => p.peerId.includes(state.filterQuery) || p.trustLevel.includes(state.filterQuery) || p.healthState.includes(state.filterQuery))
    : allPeers;
  const peers = sortPeers(filtered, state.sort.peers as SortConfig<PeerSortField> | undefined);

  const listPanel = renderPeerList(state, peers, leftW, viewHeight, state.focusedPanel === 0);
  const detailPanel = renderPeerDetail(state, rightW, viewHeight, state.focusedPanel === 1);

  return sideBySide(listPanel, detailPanel);
}

export const PEERS_PANEL_COUNT = 2;

// ── Sort ────────────────────────────────────────────────────────────

const TRUST_ORDER: Record<string, number> = { trusted: 0, established: 1, provisional: 2, untrusted: 3 };
const HEALTH_ORDER: Record<string, number> = { connected: 0, degraded: 1, partitioned: 2, unknown: 3 };

function sortPeers(peers: PeerDisplayState[], sort?: SortConfig<PeerSortField>): PeerDisplayState[] {
  if (!sort) return peers;
  const dir = sort.direction === 'asc' ? 1 : -1;
  return peers.sort((a, b) => {
    switch (sort.field) {
      case 'trust':
        return dir * ((TRUST_ORDER[a.trustLevel] ?? 9) - (TRUST_ORDER[b.trustLevel] ?? 9));
      case 'health':
        return dir * ((HEALTH_ORDER[a.healthState] ?? 9) - (HEALTH_ORDER[b.healthState] ?? 9));
      case 'lastSeen':
        return dir * (a.lastSeen - b.lastSeen);
      default:
        return 0;
    }
  });
}

// ── Trust Badge Widget ──────────────────────────────────────────────

function trustBadge(level: string): string {
  switch (level) {
    case 'trusted':
      return color('trusted', ANSI.bold, ANSI.green);
    case 'established':
      return color('established', ANSI.blue);
    case 'provisional':
      return color('provisional', ANSI.yellow);
    default:
      return color('untrusted', ANSI.red);
  }
}

function healthIcon(state: string): string {
  switch (state) {
    case 'connected':
      return color('●', ANSI.green);
    case 'degraded':
      return color('◐', ANSI.yellow);
    case 'partitioned':
      return color('○', ANSI.red);
    default:
      return dim('?');
  }
}

// ── Peer List (left pane) ───────────────────────────────────────────

function renderPeerList(
  state: TUIState,
  peers: PeerDisplayState[],
  width: number,
  height: number,
  focused: boolean,
): string {
  const innerW = width - 2;
  const visibleRows = height - 3;

  const lines: string[] = [];

  // Header
  const header = `${padEnd(bold('Peer'), 18)}${padEnd(bold('Trust'), 14)}${bold('Health')}`;
  lines.push(truncate(header, innerW));

  if (peers.length === 0) {
    lines.push(dim('  No peers connected.'));
  } else {
    const startIdx = state.peerListScroll;
    const slice = peers.slice(startIdx, startIdx + visibleRows - 1);

    for (const peer of slice) {
      const selected = peer.peerId === state.selectedPeerId;
      const prefix = selected ? color('▸ ', ANSI.cyan) : '  ';
      const id = padEnd(peer.peerId.slice(0, 16), 16);
      const trust = padEnd(trustBadge(peer.trustLevel), 12);
      const health = `${healthIcon(peer.healthState)} ${peer.healthState}`;

      lines.push(truncate(`${prefix}${id}${trust}  ${health}`, innerW));
    }
  }

  while (lines.length < visibleRows) lines.push('');

  return panel(`Peers (${peers.length})`, lines.join('\n'), width, height, focused);
}

// ── Peer Detail (right pane) ────────────────────────────────────────

function renderPeerDetail(state: TUIState, width: number, height: number, focused: boolean): string {
  const peer = state.selectedPeerId ? state.peers.get(state.selectedPeerId) : undefined;

  if (!peer) {
    return panel('Peer Detail', dim('Select a peer to view details.'), width, height, focused);
  }

  const lines: string[] = [];

  // Identity
  lines.push(`${bold('Peer:')} ${peer.peerId}`);
  lines.push(`${bold('Instance:')} ${peer.instanceId}`);
  lines.push(`${bold('URL:')} ${peer.url}`);
  lines.push('');

  // Trust & Health
  lines.push(
    `${bold('Trust:')} ${trustBadge(peer.trustLevel)}  ${bold('Health:')} ${healthIcon(peer.healthState)} ${peer.healthState}`,
  );
  lines.push(
    `${bold('Latency:')} ${peer.latencyMs != null ? `${peer.latencyMs}ms` : 'unknown'}  ${bold('Interactions:')} ${peer.interactions}`,
  );
  lines.push(`${bold('Last seen:')} ${timeSince(peer.lastSeen)}`);
  lines.push('');

  // Capabilities
  lines.push(bold('Capabilities:'));
  if (peer.capabilities.length === 0) {
    lines.push(dim('  Unknown'));
  } else {
    for (const cap of peer.capabilities) {
      lines.push(`  ${cap}`);
    }
  }
  lines.push('');

  // Knowledge Exchange
  lines.push(bold('Knowledge Exchange:'));
  lines.push(`  Imported: ${color(String(peer.knowledgeImported), ANSI.cyan)} patterns`);
  lines.push(`  Offered: ${color(String(peer.knowledgeOffered), ANSI.cyan)} patterns`);

  return panel(`Peer: ${peer.peerId.slice(0, 24)}`, lines.join('\n'), width, height, focused);
}

function timeSince(ts: number): string {
  const delta = Date.now() - ts;
  if (delta < 1000) return 'just now';
  return `${formatDuration(delta)} ago`;
}
