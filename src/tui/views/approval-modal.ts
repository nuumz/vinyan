/**
 * Approval Modal — overlay for approving/rejecting high-risk tasks.
 *
 * Renders as a centered box over the current view.
 */

import { ANSI, bold, color, dim, moveTo, visibleLength } from '../renderer.ts';
import type { TUIState } from '../types.ts';

export function renderApprovalModal(state: TUIState): string {
  if (state.modal?.type !== 'approval') return '';

  const { termWidth, termHeight } = state;
  const modalW = Math.min(60, termWidth - 10);
  const modalH = 14;
  const startRow = Math.max(2, Math.floor((termHeight - modalH) / 2));
  const startCol = Math.max(2, Math.floor((termWidth - modalW) / 2));

  const task = state.modal.taskId ? state.tasks.get(state.modal.taskId) : undefined;

  const border = ANSI.yellow;
  const lines: string[] = [];

  // Top border
  lines.push(`${border}┌${'─'.repeat(modalW - 2)}┐${ANSI.reset}`);

  // Title
  const title = ' APPROVAL REQUIRED ';
  const titlePad = Math.max(0, modalW - 2 - title.length);
  lines.push(
    `${border}│${ANSI.reset}${color(title, ANSI.bold, ANSI.yellow)}${' '.repeat(titlePad)}${border}│${ANSI.reset}`,
  );

  lines.push(`${border}│${' '.repeat(modalW - 2)}${border}│${ANSI.reset}`);

  // Task info
  const taskId = state.modal.taskId ?? 'unknown';
  lines.push(padLine(`Task: ${taskId}`, modalW, border));
  lines.push(padLine(`Goal: ${task?.goal?.slice(0, modalW - 12) ?? '?'}`, modalW, border));
  lines.push(`${border}│${' '.repeat(modalW - 2)}${border}│${ANSI.reset}`);

  // Risk
  const riskScore = state.modal.riskScore ?? 0;
  const riskColor = riskScore > 0.8 ? ANSI.red : riskScore > 0.5 ? ANSI.yellow : ANSI.green;
  const riskLabel = riskScore > 0.8 ? 'CRITICAL' : riskScore > 0.5 ? 'HIGH' : 'MODERATE';
  lines.push(padLine(`Risk: ${color(`${riskScore.toFixed(2)} (${riskLabel})`, ANSI.bold, riskColor)}`, modalW, border));
  lines.push(padLine(`Reason: ${state.modal.reason ?? '-'}`, modalW, border));

  lines.push(`${border}│${' '.repeat(modalW - 2)}${border}│${ANSI.reset}`);

  // Actions
  const actions = `  ${color('[a]pprove', ANSI.green)}    ${color('[r]eject', ANSI.red)}    ${dim('[Esc] cancel')}`;
  lines.push(padLine(actions, modalW, border));

  lines.push(`${border}│${' '.repeat(modalW - 2)}${border}│${ANSI.reset}`);

  // Bottom border
  lines.push(`${border}└${'─'.repeat(modalW - 2)}┘${ANSI.reset}`);

  // Position the modal using cursor movement
  return lines.map((line, i) => moveTo(startRow + i, startCol) + line).join('');
}

function padLine(content: string, width: number, border: string): string {
  const visible = visibleLength(content);
  const pad = Math.max(0, width - 3 - visible);
  return `${border}│${ANSI.reset} ${content}${' '.repeat(pad)}${border}│${ANSI.reset}`;
}

/** Render confirm-quit dialog. */
export function renderConfirmQuit(state: TUIState): string {
  if (state.modal?.type !== 'confirm-quit') return '';

  const { termWidth, termHeight } = state;
  const modalW = 40;
  const modalH = 6;
  const startRow = Math.floor((termHeight - modalH) / 2);
  const startCol = Math.floor((termWidth - modalW) / 2);

  const border = ANSI.yellow;
  const lines = [
    `${border}┌${'─'.repeat(modalW - 2)}┐${ANSI.reset}`,
    padLine(bold('Tasks are still running.'), modalW, border),
    padLine('Quit anyway?', modalW, border),
    padLine('', modalW, border),
    padLine(`${color('[y]es', ANSI.red)}  ${color('[n]o', ANSI.green)}`, modalW, border),
    `${border}└${'─'.repeat(modalW - 2)}┘${ANSI.reset}`,
  ];

  return lines.map((line, i) => moveTo(startRow + i, startCol) + line).join('');
}
