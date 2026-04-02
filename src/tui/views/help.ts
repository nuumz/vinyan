/**
 * Help Overlay — contextual keyboard shortcut reference.
 */

import { ANSI, bold, color, dim, moveTo, visibleLength } from '../renderer.ts';
import type { TUIState } from '../types.ts';

export function renderHelpOverlay(state: TUIState): string {
  if (state.modal?.type !== 'help') return '';

  const { termWidth, termHeight } = state;
  const modalW = Math.min(64, termWidth - 6);
  const startRow = 3;
  const startCol = Math.max(2, Math.floor((termWidth - modalW) / 2));
  const border = ANSI.cyan;

  const sections = [
    {
      title: 'Navigation',
      keys: [
        ['1 / 2 / 3 / 4', 'Switch to Tasks / System / Peers / Events'],
        ['Tab / Shift+Tab', 'Cycle panels forward / backward'],
        ['j / k / ↑ / ↓', 'Navigate list up / down'],
        ['g / G', 'Jump to top / bottom'],
        ['Ctrl+d / Ctrl+u', 'Page down / up'],
        ['Enter / Space', 'Select / expand item'],
        ['[ / ]', 'Cycle through notifications'],
        ['Esc', 'Back / close modal'],
      ],
    },
    {
      title: 'Actions',
      keys: [
        ['a', 'Approve (notification target or selected task)'],
        ['r', 'Reject (notification target) / Refresh'],
        ['c', 'Cancel running task'],
        ['n', 'New task (tasks tab)'],
        ['s', 'Sort cycle (tasks / peers tab)'],
      ],
    },
    {
      title: 'Modes',
      keys: [
        [':', 'Command mode'],
        ['/', 'Filter mode (event log)'],
        ['?', 'Toggle this help'],
        ['q', 'Quit'],
      ],
    },
    {
      title: 'Commands (: prefix)',
      keys: [
        [':run "goal"', 'Submit a new task'],
        [':approve [id]', 'Approve pending task'],
        [':reject [id]', 'Reject pending task'],
        [':cancel [id]', 'Cancel a running task'],
        [':sort <field>', 'Sort current tab list'],
        [':sleep', 'Trigger sleep cycle'],
        [':export [file]', 'Export patterns to JSON'],
        [':filter <domain>', 'Filter event log'],
      ],
    },
    {
      title: 'Approval Modal',
      keys: [
        ['a', 'Approve task'],
        ['r', 'Reject task'],
        ['Esc', 'Cancel / close'],
      ],
    },
  ];

  const lines: string[] = [];
  lines.push(`${border}┌─ ${bold('Keyboard Shortcuts')} ${'─'.repeat(Math.max(0, modalW - 24))}┐${ANSI.reset}`);

  for (const section of sections) {
    lines.push(emptyLine(modalW, border));
    lines.push(contentLine(` ${bold(section.title)}`, modalW, border));
    for (const [key, desc] of section.keys) {
      const keyStr = color((key ?? '').padEnd(20), ANSI.cyan);
      lines.push(contentLine(`  ${keyStr} ${dim(desc ?? '')}`, modalW, border));
    }
  }

  lines.push(emptyLine(modalW, border));
  lines.push(contentLine(dim('  Press ? or Esc to close'), modalW, border));
  lines.push(`${border}└${'─'.repeat(modalW - 2)}┘${ANSI.reset}`);

  // Position
  return lines.map((line, i) => moveTo(startRow + i, startCol) + line).join('');
}

function emptyLine(width: number, border: string): string {
  return `${border}│${' '.repeat(width - 2)}│${ANSI.reset}`;
}

function contentLine(content: string, width: number, border: string): string {
  const visible = visibleLength(content);
  const pad = Math.max(0, width - 3 - visible);
  return `${border}│${ANSI.reset}${content}${' '.repeat(pad)} ${border}│${ANSI.reset}`;
}
