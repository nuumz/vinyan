/**
 * Tasks View — Tab 1: Task list (left) + task detail (right).
 * Two-pane left-right layout with compact pipeline notation.
 */

import {
  ANSI,
  bold,
  color,
  compactPipeline,
  confidenceGauge,
  dim,
  formatDuration,
  padEnd,
  panel,
  sideBySide,
  truncate,
} from '../renderer.ts';
import type { PipelineStep, PipelineStepStatus, SortField, TaskDisplayState, TUIState } from '../types.ts';

export function renderTasks(state: TUIState): string {
  const { termWidth, termHeight } = state;
  const leftWidth = Math.floor(termWidth * 0.55);
  const rightWidth = termWidth - leftWidth - 1;
  const panelHeight = termHeight - 4; // header + spacing (1/2) + tab bar + hints

  const listPanel = renderTaskList(state, leftWidth, panelHeight, state.focusedPanel === 0);
  const detailPanel = renderTaskDetail(state, rightWidth, panelHeight, state.focusedPanel === 1);

  return sideBySide(listPanel, detailPanel);
}

export const TASKS_PANEL_COUNT = 2;

// ── Status Icons ────────────────────────────────────────────────────

function statusIcon(status: TaskDisplayState['status']): string {
  switch (status) {
    case 'running':
      return color('●', ANSI.blue);
    case 'completed':
      return color('✓', ANSI.green);
    case 'failed':
      return color('✗', ANSI.red);
    case 'escalated':
      return color('↑', ANSI.magenta);
    case 'uncertain':
      return color('?', ANSI.yellow);
    case 'approval_required':
      return color('⚠', ANSI.bold, ANSI.yellow);
    case 'input-required':
      // Agent paused to ask the user — similar to approval_required in that
      // it's awaiting human input, but specific to the conversational flow.
      return color('⁇', ANSI.bold, ANSI.yellow);
  }
}

// ── Sort ────────────────────────────────────────────────────────────

const STATUS_PRIORITY: Record<string, number> = {
  approval_required: 0,
  'input-required': 0,
  running: 1,
  uncertain: 2,
  completed: 3,
  failed: 4,
  escalated: 5,
};

function sortTasks(tasks: TaskDisplayState[], state: TUIState): TaskDisplayState[] {
  const sortConfig = state.sort.tasks;
  const field = sortConfig?.field ?? 'startedAt';
  const dir = sortConfig?.direction ?? 'desc';
  const mult = dir === 'desc' ? -1 : 1;

  return [...tasks].sort((a, b) => {
    switch (field) {
      case 'status':
        return mult * ((STATUS_PRIORITY[a.status] ?? 9) - (STATUS_PRIORITY[b.status] ?? 9));
      case 'routingLevel':
        return mult * (a.routingLevel - b.routingLevel);
      case 'quality':
        return mult * ((a.qualityScore ?? 0) - (b.qualityScore ?? 0));
      case 'startedAt':
      default:
        return mult * (a.startedAt - b.startedAt);
    }
  });
}

// ── Memoization Cache ────────────────────────────────────────────────

let _taskCache: {
  size: number;
  generation: number;
  filterQuery: string;
  sortField: string;
  sortDir: string;
  result: TaskDisplayState[];
} | null = null;

function getCachedTasks(state: TUIState): TaskDisplayState[] {
  const sortConfig = state.sort.tasks;
  const field = sortConfig?.field ?? 'startedAt';
  const dir = sortConfig?.direction ?? 'desc';

  if (
    _taskCache &&
    _taskCache.size === state.tasks.size &&
    _taskCache.generation === state.stateGeneration &&
    _taskCache.filterQuery === state.filterQuery &&
    _taskCache.sortField === field &&
    _taskCache.sortDir === dir &&
    // Safety: never return empty cache when tasks exist
    (_taskCache.result.length > 0 || state.tasks.size === 0)
  ) {
    return _taskCache.result;
  }

  const allTasks = [...state.tasks.values()];
  const filtered = state.filterQuery
    ? allTasks.filter(
        (t) =>
          t.id.includes(state.filterQuery) ||
          t.goal.includes(state.filterQuery) ||
          t.status.includes(state.filterQuery),
      )
    : allTasks;
  const result = sortTasks(filtered, state);

  _taskCache = {
    size: state.tasks.size,
    generation: state.stateGeneration,
    filterQuery: state.filterQuery,
    sortField: field,
    sortDir: dir,
    result,
  };
  return result;
}

// ── Task List (Left Pane) ───────────────────────────────────────────

function renderTaskList(state: TUIState, width: number, height: number, focused: boolean): string {
  const innerW = width - 2;
  const tasks = getCachedTasks(state);
  const visibleRows = height - 3;

  const lines: string[] = [];

  if (tasks.length === 0) {
    lines.push(dim('  No tasks yet. Use :run "goal" to submit.'));
  } else {
    const startIdx = state.taskListScroll;
    // Each task takes 2 rows
    const maxTasks = Math.floor(visibleRows / 2);
    const slice = tasks.slice(startIdx, startIdx + maxTasks);

    for (const task of slice) {
      const selected = task.id === state.selectedTaskId;
      const prefix = selected ? color('▸', ANSI.cyan) : ' ';
      const id = padEnd(task.id.slice(0, 7), 8);
      const pipeStr = compactPipeline(task.pipeline);
      const goalWidth = Math.max(10, innerW - 20);
      const goal = padEnd(truncate(task.goal, goalWidth), goalWidth);

      // Row 1: prefix id goal [pipeline]
      lines.push(truncate(`${prefix} ${id}${goal}${pipeStr}`, innerW));

      // Row 2: status icon, level, risk/quality, duration
      const icon = statusIcon(task.status);
      const level = `L${task.routingLevel}`;
      const riskOrQuality = task.pendingApproval
        ? color(`risk:${task.pendingApproval.riskScore.toFixed(2)}`, ANSI.yellow)
        : task.qualityScore != null
          ? `q:${task.qualityScore.toFixed(2)}`
          : '';
      const duration = task.durationMs
        ? formatDuration(task.durationMs)
        : task.status === 'running'
          ? formatDuration(Date.now() - task.startedAt)
          : '';
      lines.push(
        truncate(`  ${icon} ${level}  ${riskOrQuality}${' '.repeat(Math.max(1, innerW - 30))}${duration}`, innerW),
      );
    }
  }

  while (lines.length < visibleRows) lines.push('');

  const sortLabel = state.sort.tasks ? ` [sort:${state.sort.tasks.field}]` : '';
  const filterLabel = state.filterQuery ? ` [/${state.filterQuery}]` : '';
  return panel(`Tasks (${tasks.length})${filterLabel}${sortLabel}`, lines.join('\n'), width, height, focused);
}

// ── Task Detail (Right Pane) ────────────────────────────────────────

function renderTaskDetail(state: TUIState, width: number, height: number, focused: boolean): string {
  const task = state.selectedTaskId ? state.tasks.get(state.selectedTaskId) : undefined;

  if (!task) {
    return panel('Task Detail', dim('Select a task to view details.'), width, height, focused);
  }

  const lines: string[] = [];
  const innerW = width - 4;

  lines.push(`${bold('Goal:')} ${truncate(task.goal, innerW - 6).trim()}`);
  lines.push(`${bold('Source:')} ${task.source}  ${bold('Worker:')} ${task.workerId ?? '-'}`);
  lines.push(`${bold('Risk:')} ${task.riskScore?.toFixed(2) ?? '-'}  ${bold('Level:')} L${task.routingLevel}`);

  // Phase 0 W4: surface what the perception compressor dropped (e.g.
  // "lintWarnings: dropped 47 entries"). Rendered only when present.
  if (task.compressionNotes && task.compressionNotes.length > 0) {
    lines.push(color('[PERCEPTION TRUNCATED]', ANSI.yellow));
    for (const note of task.compressionNotes) {
      lines.push(truncate(`  • ${note}`, innerW));
    }
  }
  lines.push('');

  // Pipeline 2×3 grid
  lines.push(bold('Pipeline:'));
  lines.push(renderPipelineGrid(task.pipeline));
  lines.push('');

  // Oracle verdicts with confidence gauges
  lines.push(bold('Verdicts:'));
  if (task.oracleVerdicts.length === 0) {
    lines.push(dim('  No verdicts yet'));
  } else {
    for (const v of task.oracleVerdicts) {
      lines.push(` ${confidenceGauge(v.name, v.verified, v.confidence)}`);
    }
  }

  // Approval section
  if (task.pendingApproval) {
    lines.push('');
    lines.push(color('⚠ APPROVAL REQUIRED', ANSI.bold, ANSI.yellow));
    lines.push(`Risk: ${task.pendingApproval.riskScore.toFixed(2)}`);
    lines.push(`Reason: ${task.pendingApproval.reason}`);
    lines.push(dim('Press [a] approve [r] reject'));
  }

  return panel(`task-${task.id.slice(0, 12)}`, lines.join('\n'), width, height, focused);
}

// ── Pipeline Grid ───────────────────────────────────────────────────

const PIPELINE_STEPS: PipelineStep[] = ['perceive', 'predict', 'plan', 'generate', 'verify', 'learn'];

function renderPipelineGrid(pipeline: Record<PipelineStep, PipelineStepStatus>): string {
  const row1 = PIPELINE_STEPS.slice(0, 3)
    .map((step, i) => formatPipelineStep(step, pipeline[step], i + 1))
    .join('   ');
  const row2 = PIPELINE_STEPS.slice(3)
    .map((step, i) => formatPipelineStep(step, pipeline[step], i + 4))
    .join('   ');
  return `${row1}\n${row2}`;
}

function formatPipelineStep(step: PipelineStep, status: PipelineStepStatus, num: number): string {
  const label = `[${num}] ${capitalize(step)}`;
  switch (status) {
    case 'done':
      return color(`${label} ✓`, ANSI.green);
    case 'running':
      return color(`${label} ▸`, ANSI.bold, ANSI.blue);
    case 'skipped':
      return dim(`${label} ⊘`);
    default:
      return dim(`${label} ○`);
  }
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
