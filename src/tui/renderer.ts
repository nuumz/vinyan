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
  clearToEnd: '\x1b[J', // Clear from cursor to end of screen
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
  const pct = `${(ratio * 100).toFixed(0).padStart(3)}%`;
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
  process.stdout.write(`\x1b[?1049h${ANSI.cursorHide}`);
}

/** Leave alternate screen buffer + show cursor. */
export function leaveAltScreen(): void {
  process.stdout.write(`\x1b[?1049l${ANSI.cursorShow}`);
}

/** Write a full frame to stdout. */
export function paintFrame(content: string): void {
  // Insert \x1b[K (erase to end of line) after every newline so leftover
  // characters from longer previous-frame lines are cleared.
  const cleared = content.replace(/\n/g, '\x1b[K\n');
  process.stdout.write(ANSI.cursorHome + cleared + ANSI.clearToEnd);
}

// ── Panel / Box with focus indicator ────────────────────────────────

export function panel(title: string, content: string, width: number, height: number, focused = false): string {
  const borderColor = focused ? ANSI.cyan : ANSI.gray;
  const titleColor = focused ? ANSI.bold + ANSI.cyan : ANSI.bold;

  const innerW = width - 2;
  const titleLen = visibleLength(title);
  const top = `${borderColor}┌─ ${titleColor}${title}${ANSI.reset}${borderColor} ${'─'.repeat(Math.max(0, innerW - titleLen - 3))}┐${ANSI.reset}`;
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

// ── New Renderer Primitives (Phase 2) ───────────────────────────────

import type {
  InputMode,
  NotificationEntry,
  PipelineStep,
  PipelineStepStatus,
  TabBadge,
  TUIState,
  ToastMessage,
  ViewTab,
} from './types.ts';

const PIPELINE_ORDER: PipelineStep[] = ['perceive', 'predict', 'plan', 'generate', 'verify', 'learn'];

/** Compact 8-char pipeline: [✓✓✓▸○○] */
export function compactPipeline(pipeline: Record<PipelineStep, PipelineStepStatus>): string {
  const icons = PIPELINE_ORDER.map((step) => {
    switch (pipeline[step]) {
      case 'done':
        return color('✓', ANSI.green);
      case 'running':
        return color('▸', ANSI.blue, ANSI.bold);
      case 'skipped':
        return dim('⊘');
      case 'pending':
      default:
        return dim('○');
    }
  });
  return `[${icons.join('')}]`;
}

/** Confidence gauge: `ast PASS ████████░░ 0.95` */
export function confidenceGauge(label: string, passed: boolean, confidence: number, width = 10): string {
  const badge = passed ? color('PASS', ANSI.green) : color('FAIL', ANSI.red);
  const filled = Math.round(confidence * width);
  const empty = width - filled;
  const barColor = passed ? ANSI.green : ANSI.red;
  const bar = `${barColor}${'█'.repeat(filled)}${ANSI.gray}${'░'.repeat(empty)}${ANSI.reset}`;
  return `${padEnd(label, 6)} ${badge} ${bar} ${confidence.toFixed(2)}`;
}

/** Mode indicator — spec §7.5 */
export function modeIndicator(mode: InputMode): string {
  switch (mode) {
    case 'command':
      return color(' COMMAND ', ANSI.bgBlue, ANSI.white);
    case 'filter':
      return color(' FILTER ', ANSI.bgGreen, ANSI.black);
    case 'normal':
    default:
      return dim(' NORMAL ');
  }
}

/** Header bar — health + counts + clock */
export function headerBar(state: TUIState, width: number): string {
  const healthStatus = state.health?.status ?? 'unknown';
  const healthDot =
    healthStatus === 'healthy'
      ? color('●', ANSI.green)
      : healthStatus === 'degraded'
        ? color('●', ANSI.yellow)
        : color('●', ANSI.red);

  const runningCount = [...state.tasks.values()].filter((t) => t.status === 'running').length;
  const totalCount = state.tasks.size;
  const peerCount = state.peers?.size ?? 0;
  const notifCount = state.notifications.filter((n) => !n.dismissed).length;

  const logo = color('VINYAN', ANSI.bold, ANSI.cyan);
  const health = `${healthDot} ${healthStatus}`;
  const counts = `Tasks: ${runningCount}/${totalCount}  Peers: ${peerCount}`;
  const alerts = notifCount > 0 ? `  ${color(`⚠${notifCount}`, ANSI.yellow)}` : '';
  const clock = formatTimeShort(Date.now());

  const left = `${logo}  ${health}  ${counts}${alerts}`;
  const leftLen = visibleLength(left);
  const rightLen = clock.length;
  const gap = Math.max(1, width - leftLen - rightLen);

  return `${ANSI.bgBlue}${ANSI.white}${left}${' '.repeat(gap)}${clock}${ANSI.reset}`;
}

/** Notification bar — toast or pending notification or empty (always 1 row) */
export function notificationBar(state: TUIState, width: number): string {
  // Toast takes priority when active
  const now = Date.now();
  const activeToast = state.toasts.find((t) => t.expiresAt > now);
  if (activeToast) {
    return renderToast(activeToast, width);
  }

  // Pending notifications
  const pending = state.notifications.filter((n) => !n.dismissed);
  if (pending.length === 0) return '';

  const idx = Math.min(state.notificationIndex, pending.length - 1);
  const notif = pending[idx]!;
  return renderNotification(notif, pending.length, idx, width);
}

function renderToast(toast: ToastMessage, width: number): string {
  const icon =
    toast.level === 'success'
      ? color('✓', ANSI.green)
      : toast.level === 'error'
        ? color('✗', ANSI.red)
        : toast.level === 'warning'
          ? color('⚠', ANSI.yellow)
          : color('▶', ANSI.blue);
  const content = `${icon} ${toast.message}`;
  return padEnd(content, width);
}

function renderNotification(notif: NotificationEntry, total: number, index: number, width: number): string {
  const icon = notif.type === 'approval' ? color('⚠', ANSI.yellow, ANSI.bold) : color('!', ANSI.red);
  const taskPart = notif.taskId ? `${notif.taskId} ` : '';
  const actions =
    notif.type === 'approval'
      ? `${dim('[a]')}pprove ${dim('[r]')}eject`
      : `${dim('[Space]')}view`;
  const counter = total > 1 ? ` (${index + 1}/${total})` : '';
  const content = `${icon} ${taskPart}${notif.message}  ${actions}${counter}`;
  return padEnd(content, width);
}

/** Context hints bar — mode + keybinding hints, or command buffer when in command/filter mode */
export function contextHintsBar(
  mode: InputMode,
  hints: Array<{ key: string; label: string }>,
  width: number,
  commandBuffer?: string,
): string {
  const modeStr = modeIndicator(mode);

  // In command/filter mode, show the buffer with cursor
  if ((mode === 'command' || mode === 'filter') && commandBuffer != null) {
    const prefix = mode === 'command' ? ':' : '/';
    const bufferDisplay = `${prefix}${commandBuffer}█`;
    const hintParts = hints.map((h) => `${color(h.key, ANSI.cyan)}:${h.label}`);
    const content = `${modeStr}  ${bufferDisplay}  ${dim(hintParts.join('  '))}`;
    return padEnd(content, width);
  }

  const hintParts = hints.map((h) => `${color(h.key, ANSI.cyan)}:${h.label}`);
  const content = `${modeStr}  ${hintParts.join('  ')}`;
  return padEnd(content, width);
}

/** Tab bar with badge support */
export function tabBarWithBadges(
  tabs: Array<{ key: string; label: string; tab: ViewTab }>,
  activeTab: ViewTab,
  badges: Partial<Record<ViewTab, TabBadge>>,
  width: number,
): string {
  const parts = tabs.map((t) => {
    const badge = badges[t.tab];
    const badgeStr = badge && badge.count > 0 ? `(${badge.count})` : '';
    const badgeColor = badge?.color === 'red' ? ANSI.red : '';
    const label = `[${t.key}]${t.label}${badgeColor ? color(badgeStr, badgeColor) : dim(badgeStr)}`;

    if (t.tab === activeTab) {
      return color(` ${stripAnsi(label)} `, ANSI.bold, ANSI.cyan);
    }
    return dim(` ${stripAnsi(label)} `);
  });
  const content = parts.join(dim('│'));
  return padEnd(content, width);
}

/** Terminal size guard — returns message if too small, null otherwise */
export function terminalSizeGuard(width: number, height: number): string | null {
  if (width >= 80 && height >= 24) return null;
  const lines = [
    '┌──────────────────────────────────┐',
    '│  Terminal too small              │',
    `│  Minimum: 80 x 24               │`,
    `│  Current: ${String(width).padStart(3)} x ${String(height).padStart(2)}               │`,
    '│  Please resize your terminal.   │',
    '└──────────────────────────────────┘',
  ];
  // Center vertically and horizontally
  const padTop = Math.max(0, Math.floor((height - lines.length) / 2));
  const padLeft = Math.max(0, Math.floor((width - 36) / 2));
  return '\n'.repeat(padTop) + lines.map((l) => ' '.repeat(padLeft) + l).join('\n');
}
