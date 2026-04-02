/**
 * Peers View — Tab 3: A2A peer network with trust and health.
 *
 * Layout:
 *   ┌─ Peer Network (list) ────────────────────────────────┐
 *   │ Peer        Trust        Health     Wilson  Latency   │
 *   └──────────────────────────────────────────────────────-┘
 *   ┌─ Peer Detail ──────────────────────────────────────--┐
 *   │ Trust history, capabilities, knowledge exchange       │
 *   └──────────────────────────────────────────────────────-┘
 */

import { ANSI, bold, color, dim, formatDuration, padEnd, panel, truncate } from '../renderer.ts';
import type { PeerDisplayState, TUIState } from '../types.ts';

export function renderPeers(state: TUIState): string {
  const { termWidth, termHeight } = state;
  const listHeight = Math.min(12, Math.floor(termHeight * 0.35));
  const detailHeight = termHeight - listHeight - 4;

  const listPanel = renderPeerList(state, termWidth, listHeight, state.focusedPanel === 0);
  const detailPanel = renderPeerDetail(state, termWidth, detailHeight, state.focusedPanel === 1);

  return listPanel + '\n' + detailPanel;
}

export const PEERS_PANEL_COUNT = 2;

// ── Trust Badge Widget ──────────────────────────────────────────────

function trustBadge(level: string): string {
  switch (level) {
    case 'trusted':
      return color('trusted', ANSI.bold, ANSI.green);
    case 'established':
      return color('established', ANSI.blue);
    case 'provisional':
      return color('provisional', ANSI.yellow);
    case 'untrusted':
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

// ── Peer List ───────────────────────────────────────────────────────

function renderPeerList(state: TUIState, width: number, height: number, focused: boolean): string {
  const innerW = width - 2;
  const peers = [...state.peers.values()];
  const visibleRows = height - 3;

  const lines: string[] = [];

  // Header
  const header =
    `${padEnd(bold('Peer'), 18)}` +
    `${padEnd(bold('Instance'), 20)}` +
    `${padEnd(bold('Trust'), 14)}` +
    `${padEnd(bold('Health'), 10)}` +
    `${padEnd(bold('Interactions'), 14)}` +
    `${bold('Latency')}`;
  lines.push(truncate(header, innerW));

  if (peers.length === 0) {
    lines.push(dim('  No peers connected. Configure network.instances in vinyan.json.'));
  } else {
    const startIdx = state.peerListScroll;
    const slice = peers.slice(startIdx, startIdx + visibleRows - 1);

    for (const peer of slice) {
      const selected = peer.peerId === state.selectedPeerId;
      const prefix = selected ? color('▸ ', ANSI.cyan) : '  ';
      const id = padEnd(peer.peerId.slice(0, 16), 16);
      const inst = padEnd(peer.instanceId.slice(0, 18), 18);
      const trust = padEnd(trustBadge(peer.trustLevel), 12);
      const health = padEnd(`${healthIcon(peer.healthState)} ${peer.healthState}`, 8);
      const interactions = padEnd(String(peer.interactions), 12);
      const latency = peer.latencyMs != null ? `${peer.latencyMs}ms` : '-';

      const line = `${prefix}${id}  ${inst}  ${trust}  ${health}  ${interactions}  ${latency}`;
      lines.push(truncate(line, innerW));
    }
  }

  while (lines.length < visibleRows) lines.push('');

  return panel(`Peers (${peers.length})`, lines.join('\n'), width, height, focused);
}

// ── Peer Detail ─────────────────────────────────────────────────────

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
    `${bold('Latency:')} ${peer.latencyMs != null ? `${peer.latencyMs}ms` : 'unknown'}  ${bold('Last seen:')} ${timeSince(peer.lastSeen)}`,
  );
  lines.push('');

  // Capabilities
  lines.push(bold('Capabilities:'));
  if (peer.capabilities.length === 0) {
    lines.push(dim('  Unknown'));
  } else {
    lines.push(`  ${peer.capabilities.join(', ')}`);
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
  return formatDuration(delta) + ' ago';
}
