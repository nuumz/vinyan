/**
 * TUI Renderer — Raw ANSI terminal renderer for Vinyan.
 *
 * No framework dependency (consistent with zero-dep philosophy).
 * Renders to stdout using ANSI escape codes.
 */

// ── ANSI escape codes ────────────────────────────────────────────────

export const ANSI = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  italic: '\x1b[3m',
  underline: '\x1b[4m',

  // Foreground colors
  black: '\x1b[30m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  gray: '\x1b[90m',

  // Background colors
  bgRed: '\x1b[41m',
  bgGreen: '\x1b[42m',
  bgYellow: '\x1b[43m',
  bgBlue: '\x1b[44m',

  // Cursor / screen
  clearScreen: '\x1b[2J',
  clearLine: '\x1b[2K',
  cursorHome: '\x1b[H',
  cursorHide: '\x1b[?25l',
  cursorShow: '\x1b[?25h',
  saveCursor: '\x1b[s',
  restoreCursor: '\x1b[u',
};

export function color(text: string, ...codes: string[]): string {
  return `${codes.join('')}${text}${ANSI.reset}`;
}

export function bold(text: string): string {
  return color(text, ANSI.bold);
}

export function dim(text: string): string {
  return color(text, ANSI.dim);
}

// ── Layout helpers ───────────────────────────────────────────────────

export function box(title: string, content: string, width = 60): string {
  const top = `${ANSI.cyan}┌${'─'.repeat(width - 2)}┐${ANSI.reset}`;
  const titleLine = `${ANSI.cyan}│${ANSI.reset} ${ANSI.bold}${title.padEnd(width - 4)}${ANSI.reset} ${ANSI.cyan}│${ANSI.reset}`;
  const separator = `${ANSI.cyan}├${'─'.repeat(width - 2)}┤${ANSI.reset}`;
  const bottom = `${ANSI.cyan}└${'─'.repeat(width - 2)}┘${ANSI.reset}`;

  const lines = content.split('\n').map((line) => {
    const padded = line.slice(0, width - 4).padEnd(width - 4);
    return `${ANSI.cyan}│${ANSI.reset} ${padded} ${ANSI.cyan}│${ANSI.reset}`;
  });

  return [top, titleLine, separator, ...lines, bottom].join('\n');
}

export function table(headers: string[], rows: string[][]): string {
  const colWidths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));

  const headerLine = headers.map((h, i) => bold(h.padEnd(colWidths[i]!))).join('  ');
  const separatorLine = colWidths.map((w) => '─'.repeat(w)).join('──');
  const bodyLines = rows.map((row) => row.map((cell, i) => cell.padEnd(colWidths[i]!)).join('  '));

  return [headerLine, separatorLine, ...bodyLines].join('\n');
}

export function progressBar(value: number, max: number, width = 20): string {
  const ratio = Math.min(1, Math.max(0, value / max));
  const filled = Math.round(ratio * width);
  const empty = width - filled;
  const barColor = ratio >= 0.7 ? ANSI.green : ratio >= 0.4 ? ANSI.yellow : ANSI.red;
  return `${barColor}${'█'.repeat(filled)}${ANSI.gray}${'░'.repeat(empty)}${ANSI.reset} ${Math.round(ratio * 100)}%`;
}

export function statusBadge(status: string): string {
  switch (status) {
    case 'active':
    case 'completed':
    case 'pass':
    case 'verified':
      return color(` ${status.toUpperCase()} `, ANSI.bgGreen, ANSI.black);
    case 'failed':
    case 'error':
    case 'rejected':
      return color(` ${status.toUpperCase()} `, ANSI.bgRed, ANSI.white);
    case 'probation':
    case 'pending':
    case 'uncertain':
      return color(` ${status.toUpperCase()} `, ANSI.bgYellow, ANSI.black);
    default:
      return color(` ${status.toUpperCase()} `, ANSI.dim);
  }
}

/** Timestamp formatter — renders as HH:MM:SS.mmm */
export function formatTimestamp(ts: number): string {
  const d = new Date(ts);
  return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}:${d.getSeconds().toString().padStart(2, '0')}.${d.getMilliseconds().toString().padStart(3, '0')}`;
}

/** Short timestamp — HH:MM:SS */
export function formatTimeShort(ts: number): string {
  const d = new Date(ts);
  return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}:${d.getSeconds().toString().padStart(2, '0')}`;
}

/** Format duration in human-readable form */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3_600_000) return `${(ms / 60_000).toFixed(0)}m${Math.round((ms % 60_000) / 1000)}s`;
  const h = Math.floor(ms / 3_600_000);
  const m = Math.round((ms % 3_600_000) / 60_000);
  return `${h}h${m.toString().padStart(2, '0')}m`;
}

// ── Sparkline ───────────────────────────────────────────────────────

const SPARK_CHARS = '▁▂▃▄▅▆▇█';

/** Render a sparkline from an array of values. */
export function sparkline(values: number[], width = 20): string {
  if (values.length === 0) return dim('─'.repeat(width));
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  // Take the last `width` values
  const slice = values.slice(-width);
  return slice
    .map((v) => {
      const idx = Math.round(((v - min) / range) * (SPARK_CHARS.length - 1));
      return SPARK_CHARS[idx];
    })
    .join('');
}

// ── Gauge (horizontal bar with label) ───────────────────────────────

export function gauge(value: number, width = 20, label?: string): string {
  const ratio = Math.min(1, Math.max(0, value));
  const filled = Math.round(ratio * width);
  const empty = width - filled;
  const barColor = ratio >= 0.7 ? ANSI.green : ratio >= 0.4 ? ANSI.yellow : ANSI.red;
  const bar = `${barColor}${'█'.repeat(filled)}${ANSI.gray}${'░'.repeat(empty)}${ANSI.reset}`;
  const pct = (ratio * 100).toFixed(0).padStart(3) + '%';
  return label ? `${bar} ${pct} ${dim(label)}` : `${bar} ${pct}`;
}

// ── Data gate dot ───────────────────────────────────────────────────

export function gateDot(ready: boolean, label: string): string {
  const dot = ready ? color('●', ANSI.green) : color('○', ANSI.gray);
  const text = ready ? label : dim(label);
  return `${dot} ${text}`;
}

// ── Truncate with ANSI awareness ────────────────────────────────────

/** Strip ANSI escape codes to get visible length. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: intentional ANSI escape matching
const ANSI_RE = /\x1b\[[0-9;]*m/g;
export function stripAnsi(str: string): string {
  return str.replace(ANSI_RE, '');
}

export function visibleLength(str: string): number {
  return stripAnsi(str).length;
}

/** Truncate a string to a visible width, preserving ANSI codes. */
export function truncate(str: string, maxWidth: number): string {
  let visible = 0;
  let result = '';
  let inEscape = false;
  for (const ch of str) {
    if (ch === '\x1b') {
      inEscape = true;
      result += ch;
      continue;
    }
    if (inEscape) {
      result += ch;
      if (ch === 'm') inEscape = false;
      continue;
    }
    if (visible >= maxWidth) break;
    result += ch;
    visible++;
  }
  return result + ANSI.reset;
}

/** Pad a string to a visible width. */
export function padEnd(str: string, width: number): string {
  const vlen = visibleLength(str);
  return vlen >= width ? truncate(str, width) : str + ' '.repeat(width - vlen);
}

// ── Full-screen rendering ───────────────────────────────────────────

/** Move cursor to row, col (1-indexed). */
export function moveTo(row: number, col: number): string {
  return `\x1b[${row};${col}H`;
}

/** Enter alternate screen buffer + hide cursor. */
export function enterAltScreen(): void {
  process.stdout.write('\x1b[?1049h' + ANSI.cursorHide);
}

/** Leave alternate screen buffer + show cursor. */
export function leaveAltScreen(): void {
  process.stdout.write('\x1b[?1049l' + ANSI.cursorShow);
}

/** Write a full frame to stdout. */
export function paintFrame(content: string): void {
  process.stdout.write(ANSI.cursorHome + content);
}

// ── Panel / Box with focus indicator ────────────────────────────────

export function panel(title: string, content: string, width: number, height: number, focused = false): string {
  const borderColor = focused ? ANSI.cyan : ANSI.gray;
  const titleColor = focused ? ANSI.bold + ANSI.cyan : ANSI.bold;

  const innerW = width - 2;
  const top = `${borderColor}┌─ ${titleColor}${title}${ANSI.reset}${borderColor} ${'─'.repeat(Math.max(0, innerW - title.length - 3))}┐${ANSI.reset}`;
  const bottom = `${borderColor}└${'─'.repeat(innerW)}┘${ANSI.reset}`;

  const contentLines = content.split('\n');
  const rows: string[] = [];
  for (let i = 0; i < height - 2; i++) {
    const line = contentLines[i] ?? '';
    const padded = padEnd(line, innerW);
    rows.push(`${borderColor}│${ANSI.reset}${padded}${borderColor}│${ANSI.reset}`);
  }

  return [top, ...rows, bottom].join('\n');
}

// ── Horizontal layout helper ────────────────────────────────────────

/** Merge two multi-line strings side by side with a gap. */
export function sideBySide(left: string, right: string, gap = 1): string {
  const leftLines = left.split('\n');
  const rightLines = right.split('\n');
  const maxRows = Math.max(leftLines.length, rightLines.length);
  const leftWidth = Math.max(...leftLines.map(visibleLength));

  const result: string[] = [];
  for (let i = 0; i < maxRows; i++) {
    const l = padEnd(leftLines[i] ?? '', leftWidth);
    const r = rightLines[i] ?? '';
    result.push(l + ' '.repeat(gap) + r);
  }
  return result.join('\n');
}

// ── Tab bar ─────────────────────────────────────────────────────────

export function tabBar(tabs: Array<{ key: string; label: string }>, activeIndex: number, width: number): string {
  const parts = tabs.map((t, i) => {
    if (i === activeIndex) {
      return color(` [${t.key}] ${t.label} `, ANSI.bold, ANSI.cyan);
    }
    return dim(` [${t.key}] ${t.label} `);
  });
  const content = parts.join(dim('│'));
  return padEnd(content, width);
}

// ── Status bar ──────────────────────────────────────────────────────

export function statusBar(left: string, right: string, width: number): string {
  const leftLen = visibleLength(left);
  const rightLen = visibleLength(right);
  const gap = Math.max(1, width - leftLen - rightLen);
  return `${ANSI.bgBlue}${ANSI.white}${left}${' '.repeat(gap)}${right}${ANSI.reset}`;
}
