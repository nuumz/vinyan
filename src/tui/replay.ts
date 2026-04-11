/**
 * JSONL Audit Replay — replay audit log files for post-mortem analysis.
 *
 * Reads JSONL audit files written by the AuditListener and replays
 * them through the EventRenderer for visualization.
 */

import { ANSI, bold, color, dim, formatTimestamp } from './renderer.ts';

export interface AuditEntry {
  event: string;
  payload: Record<string, unknown>;
  timestamp: number;
}

/**
 * Parse a JSONL audit file into structured entries.
 */
export function parseAuditLog(content: string): AuditEntry[] {
  const entries: AuditEntry[] = [];

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    try {
      const parsed = JSON.parse(trimmed) as AuditEntry;
      if (parsed.event && parsed.timestamp) {
        entries.push(parsed);
      }
    } catch {
      // Skip malformed lines
    }
  }

  return entries;
}

/**
 * Render a summary of an audit log.
 */
export function summarizeAuditLog(entries: AuditEntry[]): string {
  if (entries.length === 0) return 'No audit entries found.';

  const eventCounts = new Map<string, number>();
  let minTs = Infinity;
  let maxTs = 0;

  for (const entry of entries) {
    eventCounts.set(entry.event, (eventCounts.get(entry.event) ?? 0) + 1);
    if (entry.timestamp < minTs) minTs = entry.timestamp;
    if (entry.timestamp > maxTs) maxTs = entry.timestamp;
  }

  const durationMs = maxTs - minTs;
  const durationStr =
    durationMs > 60_000
      ? `${(durationMs / 60_000).toFixed(1)}m`
      : durationMs > 1_000
        ? `${(durationMs / 1_000).toFixed(1)}s`
        : `${durationMs}ms`;

  const lines: string[] = [];
  lines.push(bold('Audit Log Summary'));
  lines.push(`${dim('Period:')} ${formatTimestamp(minTs)} → ${formatTimestamp(maxTs)} (${durationStr})`);
  lines.push(`${dim('Total events:')} ${entries.length}`);
  lines.push('');
  lines.push(bold('Event breakdown:'));

  // Sort by count descending
  const sorted = [...eventCounts.entries()].sort((a, b) => b[1] - a[1]);
  for (const [event, count] of sorted) {
    const bar = '█'.repeat(Math.min(30, Math.ceil((count / entries.length) * 30)));
    lines.push(`  ${event.padEnd(30)} ${color(String(count).padStart(5), ANSI.cyan)} ${dim(bar)}`);
  }

  return lines.join('\n');
}

/**
 * Replay audit entries to terminal with timing.
 * If realtime=true, delays between events match original timing.
 */
export async function replayAuditLog(
  entries: AuditEntry[],
  options: { realtime?: boolean; speedMultiplier?: number } = {},
): Promise<void> {
  const speed = options.speedMultiplier ?? 1;

  console.log(bold(`Replaying ${entries.length} audit entries...`));
  console.log('');

  let lastTs = entries[0]?.timestamp ?? 0;

  for (const entry of entries) {
    if (options.realtime && entry.timestamp > lastTs) {
      const delay = (entry.timestamp - lastTs) / speed;
      if (delay > 10) {
        await new Promise((r) => setTimeout(r, Math.min(delay, 2000)));
      }
    }
    lastTs = entry.timestamp;

    const ts = dim(formatTimestamp(entry.timestamp));
    const event = color(entry.event.padEnd(30), ANSI.cyan);
    const payload = dim(JSON.stringify(entry.payload).slice(0, 80));
    console.log(`${ts} ${event} ${payload}`);
  }

  console.log('');
  console.log(bold('Replay complete.'));
}
