/**
 * Tasks View — Tab 2: Task list + detail + pipeline progress.
 *
 * Layout:
 *   ┌─ Active Tasks (list) ────────────────────────────────┐
 *   │ ID        Goal              Level  Status  Quality    │
 *   └─────────────────────────────────────────────────────┘
 *   ┌─ Task Detail ───────────────────────────────────────-┐
 *   │ Pipeline: [Perceive ✓] [Predict ✓] [Plan ▸] ...     │
 *   │ Oracle Verdicts: ast PASS, type PASS, dep FAIL       │
 *   └─────────────────────────────────────────────────────-┘
 */

import {
  ANSI,
  bold,
  color,
  dim,
  formatDuration,
  padEnd,
  panel,
  sideBySide,
  statusBadge,
  truncate,
} from '../renderer.ts';
import type { PipelineStep, PipelineStepStatus, TaskDisplayState, TUIState } from '../types.ts';

export function renderTasks(state: TUIState): string {
  const { termWidth, termHeight } = state;
  const listHeight = Math.min(12, Math.floor(termHeight * 0.35));
  const detailHeight = termHeight - listHeight - 4; // tab bar + status

  const listPanel = renderTaskList(state, termWidth, listHeight, state.focusedPanel === 0);
  const detailPanel = renderTaskDetail(state, termWidth, detailHeight, state.focusedPanel === 1);

  return listPanel + '\n' + detailPanel;
}

export const TASKS_PANEL_COUNT = 2;

// ── Task List ───────────────────────────────────────────────────────

function renderTaskList(state: TUIState, width: number, height: number, focused: boolean): string {
  const innerW = width - 2;
  const tasks = [...state.tasks.values()].sort((a, b) => b.startedAt - a.startedAt);
  const visibleRows = height - 3;

  const lines: string[] = [];

  // Header
  const header = `${padEnd(bold('ID'), 14)}${padEnd(bold('Goal'), innerW - 50)}${padEnd(bold('Lvl'), 5)}${padEnd(bold('Status'), 14)}${padEnd(bold('Duration'), 10)}${bold('Quality')}`;
  lines.push(truncate(header, innerW));

  if (tasks.length === 0) {
    lines.push(dim('  No tasks yet. Use :run "goal" to submit a task.'));
  } else {
    const startIdx = state.taskListScroll;
    const slice = tasks.slice(startIdx, startIdx + visibleRows - 1);

    for (const task of slice) {
      const selected = task.id === state.selectedTaskId;
      const prefix = selected ? color('▸ ', ANSI.cyan) : '  ';
      const id = padEnd(task.id.slice(0, 12), 12);
      const goal = padEnd(task.goal.slice(0, innerW - 52), innerW - 52);
      const level = padEnd(`L${task.routingLevel}`, 3);
      const status = formatStatus(task.status);
      const duration = task.durationMs
        ? formatDuration(task.durationMs)
        : task.status === 'running'
          ? formatDuration(Date.now() - task.startedAt)
          : '-';
      const quality = task.qualityScore != null ? task.qualityScore.toFixed(2) : '-';

      const line = `${prefix}${id}  ${goal}${level}  ${padEnd(status, 12)}${padEnd(duration, 8)}  ${quality}`;
      lines.push(truncate(line, innerW));
    }
  }

  // Pad
  while (lines.length < visibleRows) lines.push('');

  return panel(`Tasks (${tasks.length})`, lines.join('\n'), width, height, focused);
}

function formatStatus(status: TaskDisplayState['status']): string {
  switch (status) {
    case 'running':
      return color('running', ANSI.blue);
    case 'completed':
      return color('completed', ANSI.green);
    case 'failed':
      return color('failed', ANSI.red);
    case 'escalated':
      return color('escalated', ANSI.magenta);
    case 'uncertain':
      return color('uncertain', ANSI.yellow);
    case 'approval_required':
      return color('APPROVAL', ANSI.bold, ANSI.yellow);
  }
}

// ── Task Detail ─────────────────────────────────────────────────────

function renderTaskDetail(state: TUIState, width: number, height: number, focused: boolean): string {
  const task = state.selectedTaskId ? state.tasks.get(state.selectedTaskId) : undefined;

  if (!task) {
    return panel('Task Detail', dim('Select a task to view details.'), width, height, focused);
  }

  const lines: string[] = [];
  const innerW = width - 4;

  // Goal
  lines.push(`${bold('Goal:')} ${truncate(task.goal, innerW - 6).trim()}`);
  lines.push(
    `${bold('Source:')} ${task.source}  ${bold('Risk:')} ${task.riskScore?.toFixed(2) ?? '-'}` +
      `  ${bold('Level:')} L${task.routingLevel}  ${bold('Worker:')} ${task.workerId ?? '-'}`,
  );
  lines.push('');

  // Pipeline progress
  lines.push(bold('Pipeline:'));
  lines.push(renderPipelineProgress(task.pipeline));
  lines.push('');

  // Oracle verdicts
  lines.push(bold('Oracle Verdicts:'));
  if (task.oracleVerdicts.length === 0) {
    lines.push(dim('  No verdicts yet'));
  } else {
    for (const v of task.oracleVerdicts) {
      const icon = v.verified ? color('PASS', ANSI.green) : color('FAIL', ANSI.red);
      lines.push(`  ${padEnd(v.name, 10)} ${icon} (${v.confidence.toFixed(2)})`);
    }
  }

  // Approval pending
  if (task.pendingApproval) {
    lines.push('');
    lines.push(color('  ⚠ APPROVAL REQUIRED', ANSI.bold, ANSI.yellow));
    lines.push(`  Risk: ${task.pendingApproval.riskScore.toFixed(2)}  Reason: ${task.pendingApproval.reason}`);
    lines.push(dim('  Press [a] to approve, [r] to reject'));
  }

  return panel(`Task: ${task.id.slice(0, 20)}`, lines.join('\n'), width, height, focused);
}

// ── Pipeline Progress Widget ────────────────────────────────────────

const PIPELINE_STEPS: PipelineStep[] = ['perceive', 'predict', 'plan', 'generate', 'verify', 'learn'];

function renderPipelineProgress(pipeline: Record<PipelineStep, PipelineStepStatus>): string {
  return PIPELINE_STEPS.map((step, i) => {
    const status = pipeline[step];
    const label = `[${i + 1}] ${capitalize(step)}`;
    switch (status) {
      case 'done':
        return color(`${label} ✓`, ANSI.green);
      case 'running':
        return color(`${label} ▸`, ANSI.bold, ANSI.blue);
      case 'skipped':
        return dim(`${label} ○`);
      case 'pending':
      default:
        return dim(`${label} ○`);
    }
  }).join('  ');
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
