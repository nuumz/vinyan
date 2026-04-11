/**
 * Help Overlay — two-column keyboard shortcut reference.
 *
 * Left column:  Navigation + Actions  (high-frequency keys)
 * Right column: Modes + Commands      (less frequent / reference)
 *
 * Each line is erased before painting to prevent background bleed.
 */

import { ANSI, bold, color, dim, truncate, visibleLength } from '../renderer.ts';
import type { TUIState } from '../types.ts';

// ── Section data ──────────────────────────────────────────────────

interface Section {
  title: string;
  keys: ReadonlyArray<readonly [string, string]>;
}

const LEFT_SECTIONS: Section[] = [
  {
    title: 'Navigation',
    keys: [
      ['1-4', 'Switch tabs'],
      ['Tab / Shift+Tab', 'Cycle panels'],
      ['j/k  ↑/↓', 'Navigate list'],
      ['g / G', 'Jump top / bottom'],
      ['PgDn / PgUp', 'Page scroll'],
      ['Enter / Space', 'Select / toggle detail'],
      ['[ / ]', 'Cycle notifications'],
      ['Esc', 'Close / back'],
    ],
  },
  {
    title: 'Actions',
    keys: [
      ['a', 'Approve'],
      ['r', 'Reject / Refresh'],
      ['c', 'Cancel task'],
      ['n', 'New task'],
      ['s', 'Sort cycle'],
    ],
  },
];

const RIGHT_SECTIONS: Section[] = [
  {
    title: 'Modes',
    keys: [
      [':', 'Command mode'],
      ['/', 'Filter mode'],
      ['?', 'Toggle help'],
      ['q', 'Quit'],
    ],
  },
  {
    title: 'Commands',
    keys: [
      [':run "goal"', 'Submit task'],
      [':approve [id]', 'Approve task'],
      [':reject [id]', 'Reject task'],
      [':cancel [id]', 'Cancel task'],
      [':sort <field>', 'Sort list'],
      [':set <k> <v>', 'Set config'],
      [':filter <q>', 'Filter list'],
      [':clear', 'Clear filter/log'],
      [':sleep', 'Sleep cycle'],
      [':export [file]', 'Export patterns'],
    ],
  },
];

// ── Render ────────────────────────────────────────────────────────

const ERASE_LINE = '\x1b[2K';

export function renderHelpOverlay(state: TUIState): string {
  if (state.modal?.type !== 'help') return '';

  const { termWidth, termHeight } = state;
  const modalW = Math.min(92, termWidth - 4);
  const innerW = modalW - 2; // chars between outer │...│
  const startCol = Math.max(1, Math.floor((termWidth - modalW) / 2));
  const bc = ANSI.cyan;

  // Column width math (exact):
  //   outer│ SP left(LW) SP │ SP right(RW) SP outer│
  //   innerW = 1 + LW + 1 + 1 + 1 + RW + 1 = LW + RW + 5
  // Right column is already well-sized — give extra width to left (descriptions)
  const rightW = Math.floor((innerW - 5) * 0.42);
  const leftW = innerW - 5 - rightW;

  // Build left and right columns as arrays of raw lines
  const leftLines = buildColumn(LEFT_SECTIONS, leftW);
  const rightLines = buildColumn(RIGHT_SECTIONS, rightW);

  // Pad shorter column to match
  const maxLen = Math.max(leftLines.length, rightLines.length);
  while (leftLines.length < maxLen) leftLines.push('');
  while (rightLines.length < maxLen) rightLines.push('');

  // ── Assemble rows ───────────────────────────────────────────────

  const rows: string[] = [];

  // Top border: ┌─ Title ──────┬──────────────┐
  const title = 'Keyboard Shortcuts';
  const topLeftDash = Math.max(0, leftW - title.length - 1);
  const topRightDash = rightW + 2; // SP + rightW + SP
  rows.push(
    `${bc}┌─ ${bold(bc + title)}${bc} ${'─'.repeat(topLeftDash)}┬${'─'.repeat(topRightDash)}┐${ANSI.reset}`,
  );

  // Blank row after top border for breathing room
  rows.push(`${bc}│${ANSI.reset}${' '.repeat(leftW + 2)}${bc}│${ANSI.reset}${' '.repeat(rightW + 2)}${bc}│${ANSI.reset}`);

  // Content rows
  const div = `${bc}│${ANSI.reset}`; // thin column divider

  for (let i = 0; i < maxLen; i++) {
    const l = padVisible(leftLines[i]!, leftW);
    const r = padVisible(rightLines[i]!, rightW);
    rows.push(`${bc}│${ANSI.reset} ${l} ${div} ${r} ${bc}│${ANSI.reset}`);
  }

  // Bottom border: └─────────────┴──────────────┘
  rows.push(
    `${bc}├${'─'.repeat(leftW + 2)}┴${'─'.repeat(rightW + 2)}┤${ANSI.reset}`,
  );
  rows.push(`${bc}│${ANSI.reset}${padVisible(dim('  Press ? or Esc to close'), innerW)}${bc}│${ANSI.reset}`);
  rows.push(`${bc}└${'─'.repeat(innerW)}┘${ANSI.reset}`);

  // ── Fit within terminal ─────────────────────────────────────────

  const startRow = 3;
  const maxRows = termHeight - startRow;
  const visible = rows.length <= maxRows
    ? rows
    : [...rows.slice(0, maxRows - 1), rows[rows.length - 1]!];

  // ── Paint with line-erase ──────────────────────────────────────

  const out: string[] = [];
  for (let i = 0; i < visible.length; i++) {
    const r = startRow + i;
    out.push(`\x1b[${r};1H${ERASE_LINE}\x1b[${r};${startCol}H${visible[i]}`);
  }
  return out.join('');
}

// ── Helpers ───────────────────────────────────────────────────────

function buildColumn(sections: Section[], colW: number): string[] {
  const keyW = Math.min(18, Math.floor(colW * 0.55));
  const lines: string[] = [];

  for (const section of sections) {
    if (lines.length > 0) lines.push(''); // blank separator between sections
    lines.push(bold(section.title));
    for (const [key, desc] of section.keys) {
      const k = color(key.padEnd(keyW), ANSI.cyan);
      const d = dim(desc);
      lines.push(` ${k} ${d}`);
    }
  }
  return lines;
}

function padVisible(str: string, width: number): string {
  const vis = visibleLength(str);
  if (vis >= width) return truncate(str, width);
  return str + ' '.repeat(width - vis);
}
