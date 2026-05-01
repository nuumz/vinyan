/**
 * TaskProcessProjectionService — backend-authoritative process state for
 * the operator console.
 *
 * Goal: vinyan-ui must NOT reconstruct canonical workflow / gate / plan /
 * coding-cli state from raw SSE events. It calls
 * `GET /api/v1/tasks/:id/process-state` and renders the projection
 * returned by this service.
 *
 * Inputs (all real durable stores — no stubs):
 *   - TaskEventStore — append-only persisted bus events for the task
 *   - SessionManager — task/session in-memory state
 *   - ApprovalLedgerStore — durable approval lifecycle (R5)
 *   - CodingCliStore — coding-cli sessions / approvals / decisions
 *   - inFlight + asyncResults maps from the API server (live truth)
 *
 * The projection is a pure function of those inputs at the moment of the
 * call. Re-running on the same state must produce byte-identical output
 * (A3 deterministic governance) — every fold below is total over the
 * persisted event sequence.
 *
 * Axioms upheld:
 *   A3 — every classification is rule-based; no LLM, no external clock-
 *        sensitive heuristic beyond an explicit `now`.
 *   A6 — gates are derived from durable event pairs; never silently
 *        treated as resolved when the durable record is open.
 *   A8 — every gate carries the source event id when one is available
 *        so the audit trail can replay the open/close transition.
 *   A9 — when a store is unavailable the projection still returns,
 *        with affected fields populated as `unsupported` rather than
 *        throwing — front-end keeps rendering, operator still sees
 *        what we DO know.
 */
import type { ApprovalLedgerRecord, ApprovalLedgerStore } from '../../db/approval-ledger-store.ts';
import type { ApprovalRow, CodingCliStore } from '../../db/coding-cli-store.ts';
import type { SessionTaskRow } from '../../db/session-store.ts';
import type { PersistedTaskEvent, TaskEventStore } from '../../db/task-event-store.ts';
import type { TaskResult } from '../../orchestrator/types.ts';

// ── Public projection types ─────────────────────────────────────────

export type TaskLifecycleStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'escalated'
  | 'timeout'
  | 'cancelled'
  | 'input-required';

export interface TaskProcessLifecycle {
  taskId: string;
  sessionId?: string;
  status: TaskLifecycleStatus;
  dbStatus?: string;
  resultStatus?: string;
  startedAt?: number;
  updatedAt?: number;
  finishedAt?: number;
  durationMs?: number;
  /** Last terminal event seen on the durable log (one of `task:*` set). */
  terminalEventType?: string;
  /** Free-form reason from a terminal event payload (failureReason / cancelReason / escalationReason / timeout msg). */
  terminalReason?: string;
}

export type TaskProcessCompletenessKind =
  | 'complete'
  | 'terminal-error'
  | 'missing-terminal'
  | 'awaiting-user'
  | 'empty'
  | 'unsupported'
  | 'error';

export interface TaskProcessCompleteness {
  kind: TaskProcessCompletenessKind;
  eventCount: number;
  firstTs?: number;
  lastTs?: number;
  truncated: boolean;
  /** Human-readable summary, mainly for `error` / `unsupported`. */
  reason?: string;
}

export interface TaskProcessGate {
  open: boolean;
  resolved: boolean;
  openedAt?: number;
  resolvedAt?: number;
  /** Source event ids — let the audit log replay the gate transition. */
  openedEventId?: string;
  resolvedEventId?: string;
  /** Free-form payload echoes from the source events (read-only for UI). */
  detail?: Record<string, unknown>;
}

export interface TaskProcessGates {
  /** Approval gate (R5 ledger + in-memory ApprovalGate). */
  approval: TaskProcessGate;
  /** Workflow `human_input_*` pair. */
  workflowHumanInput: TaskProcessGate;
  /** Workflow `partial_failure_decision_*` pair. */
  partialDecision: TaskProcessGate;
  /** Coding-cli `approval_required` / `approval_resolved` pair. */
  codingCliApproval: TaskProcessGate;
}

export interface TaskProcessTodoItem {
  id: string;
  content: string;
  status: 'pending' | 'in_progress' | 'completed' | string;
  activeForm?: string;
}

export interface TaskProcessPlanStep {
  id: string;
  description: string;
  strategy?: string;
  status: 'pending' | 'running' | 'done' | 'failed' | 'skipped' | string;
  agentId?: string;
  subTaskId?: string;
  startedAt?: number;
  finishedAt?: number;
  fallbackUsed?: boolean;
}

export interface TaskProcessSubtask {
  subtaskId: string;
  stepId: string;
  status: string;
  agentId?: string;
  startedAt?: number;
  completedAt?: number;
  errorKind?: string;
  errorMessage?: string;
  outputPreview?: string;
}

export interface TaskProcessPlan {
  decisionStage?: string;
  todoList: TaskProcessTodoItem[];
  steps: TaskProcessPlanStep[];
  multiAgentSubtasks: TaskProcessSubtask[];
  groupMode?: string;
  winner?: { agentId?: string; reasoning?: string; runnerUpAgentId?: string };
}

export interface TaskProcessCodingCliPendingApproval {
  requestId: string;
  command: string;
  reason: string;
  policyDecision: string;
  requestedAt: number;
}

export interface TaskProcessCodingCliResolvedApproval {
  requestId: string;
  command: string;
  policyDecision: string;
  humanDecision: string;
  decidedBy: string;
  decidedAt: number;
  requestedAt: number;
}

/**
 * Per-CLI-session terminal context. Surfaced separately from `state`
 * so the frontend can render rich banners ("Failed: provider quota
 * exhausted", "Cancelled by alice", "Stalled — idle 92s") without
 * folding raw events. Each field is sourced from the most recent
 * matching durable event in `coding_cli_events`. Undefined when the
 * session never reached the corresponding state.
 */
export interface TaskProcessCodingCliFailureDetail {
  reason?: string;
  /** Epoch-ms of the originating `coding-cli:failed` event. */
  at: number;
}

export interface TaskProcessCodingCliCancelDetail {
  by?: string;
  reason?: string;
  at: number;
}

export interface TaskProcessCodingCliStalledDetail {
  /** Idle duration reported on the most recent `coding-cli:stalled` event. */
  idleMs: number;
  at: number;
}

export interface TaskProcessCodingCliSession {
  id: string;
  taskId: string;
  providerId: string;
  state: string;
  startedAt: number;
  updatedAt: number;
  endedAt?: number;
  filesChanged: string[];
  commandsRequested: string[];
  pendingApprovals: TaskProcessCodingCliPendingApproval[];
  resolvedApprovals: TaskProcessCodingCliResolvedApproval[];
  finalResult?: unknown;
  /**
   * Backend-authoritative terminal context derived from the durable
   * event log. Frontend `coding-cli-projection.mergeCodingCliSessions`
   * prefers these over the local SSE-folded fallback fields.
   */
  failureDetail?: TaskProcessCodingCliFailureDetail;
  cancelDetail?: TaskProcessCodingCliCancelDetail;
  stalledDetail?: TaskProcessCodingCliStalledDetail;
}

export interface TaskProcessPhase {
  name: string;
  status: 'started' | 'completed' | 'failed' | string;
  startedAt: number;
  finishedAt?: number;
  durationMs?: number;
}

export interface TaskProcessToolCall {
  callId: string;
  tool: string;
  status: 'started' | 'success' | 'denied' | 'error' | string;
  ts: number;
  outputPreview?: string;
}

export interface TaskProcessOracleVerdict {
  oracle: string;
  verdict: 'verified' | 'refuted' | 'unknown' | string;
  confidence?: number;
  ts: number;
}

export interface TaskProcessEscalation {
  fromLevel?: number;
  toLevel?: number;
  reason?: string;
  ts: number;
}

export interface TaskProcessDiagnostics {
  phases: TaskProcessPhase[];
  toolCalls: TaskProcessToolCall[];
  oracleVerdicts: TaskProcessOracleVerdict[];
  routingLevel?: number;
  escalations: TaskProcessEscalation[];
}

export interface TaskProcessHistory {
  /** Last persisted seq seen — clients pass this as `since` for incremental polls. */
  lastSeq: number;
  eventCount: number;
  /** True iff the projection capped event reads at the store limit. */
  truncated: boolean;
  /** Immediate child task ids dispatched by this task (from `workflow:delegate_dispatched`). */
  descendantTaskIds: string[];
}

export interface TaskProcessProjection {
  lifecycle: TaskProcessLifecycle;
  completeness: TaskProcessCompleteness;
  gates: TaskProcessGates;
  plan: TaskProcessPlan;
  codingCliSessions: TaskProcessCodingCliSession[];
  diagnostics: TaskProcessDiagnostics;
  history: TaskProcessHistory;
}

// ── Service deps + impl ─────────────────────────────────────────────

export interface TaskProcessProjectionDeps {
  taskEventStore?: TaskEventStore;
  approvalLedgerStore?: ApprovalLedgerStore;
  codingCliStore?: CodingCliStore;
  /**
   * Cross-session task lookup. Returns the durable `session_tasks` row
   * for `taskId` regardless of which session owns it, or `undefined`
   * when the task has never been persisted (orphan async result).
   */
  findTaskRow: (taskId: string) => SessionTaskRow | undefined;
  /** TaskIds that are awaiting in-memory ApprovalGate resolution right now. */
  pendingApprovalTaskIds: () => ReadonlySet<string>;
  /** Async results published outside a session (`POST /tasks/async`). */
  asyncResults: () => ReadonlyMap<string, TaskResult>;
  /** TaskIds the orchestrator is actively executing right now. */
  inFlightTaskIds: () => ReadonlySet<string>;
  /** Test/clock injection. Defaults to `Date.now`. */
  now?: () => number;
  /** Hard cap on persisted events read per call. Matches TaskEventStore default. */
  maxEvents?: number;
}

const TERMINAL_EVENTS: ReadonlySet<string> = new Set([
  'task:complete',
  'task:done',
  'task:failed',
  'task:escalate',
  'task:timeout',
  'task:cancelled',
]);

/**
 * Every bus event the projection service folds into the returned
 * shape. When you add a `case 'foo:bar':` to any of the build* methods
 * (or read a new event payload anywhere in this file), mirror the
 * entry here. The contract test in
 * `tests/api/projection-coverage.contract.test.ts` walks the event
 * manifest and fails if a recorded projection-relevant event is
 * neither here nor in `PROJECTION_IGNORED_EVENTS`.
 *
 * Events listed here MUST exist in `EVENT_MANIFEST` — the contract
 * test asserts that too, so an interpreted-but-unmanifested event
 * surfaces as an orphan rather than silently rotting.
 *
 * `task:done` is intentionally not present: the manifest never emits
 * it; the service still defends against it in `TERMINAL_EVENTS` for
 * safety only.
 */
export const PROJECTION_INTERPRETED_EVENTS: ReadonlySet<string> = new Set([
  // Task lifecycle (terminal + start)
  'task:start',
  'task:complete',
  'task:escalate',
  'task:timeout',
  'task:cancelled',
  // Workflow stage manifest (plan / todos / subtasks / winner)
  'workflow:decision_recorded',
  'workflow:todo_created',
  'workflow:todo_updated',
  'workflow:subtasks_planned',
  'workflow:subtask_updated',
  'workflow:winner_determined',
  'workflow:step_start',
  'workflow:step_complete',
  // Workflow gates
  'workflow:plan_ready',
  'workflow:plan_approved',
  'workflow:plan_rejected',
  'workflow:human_input_needed',
  'workflow:human_input_provided',
  'workflow:partial_failure_decision_needed',
  'workflow:partial_failure_decision_provided',
  // Delegate dispatch (descendant resolution via TaskEventStore.listChildTaskIds)
  'workflow:delegate_dispatched',
  // Coding-CLI gate
  'coding-cli:approval_required',
  'coding-cli:approval_resolved',
  // Coding-CLI terminal context (read from coding_cli_events to fill
  // failureDetail / cancelDetail / stalledDetail on the projection).
  'coding-cli:failed',
  'coding-cli:cancelled',
  'coding-cli:stalled',
  // Durable approval ledger
  'approval:ledger_pending',
  'approval:ledger_resolved',
  // Diagnostics
  'phase:timing',
  'oracle:verdict',
  'agent:tool_started',
  'agent:tool_executed',
  'agent:routed',
]);

/**
 * Events that ARE recorded and projection-relevant by prefix, but the
 * service intentionally does not fold. Each entry must carry a
 * one-line rationale so a future contributor can understand why
 * projection skips it. Adding a new entry here is a deliberate
 * decision, not a default.
 *
 * Every entry must exist in `EVENT_MANIFEST` (asserted by the contract
 * test).
 */
export const PROJECTION_IGNORED_EVENTS: ReadonlyMap<string, string> = new Map<string, string>([
  // Workflow planner pre-finalization audit row.
  [
    'workflow:plan_created',
    'pre-finalization planner output — recorded for audit/replay diff against the executor run-time plan in workflow:plan_ready; the rendered plan surface is built from plan_ready + stage_manifest events post-finalization',
  ],
  // Task lifecycle (audit-only events that don't change projection state)
  [
    'task:stage_update',
    'live progress label only — projection lifecycle is derived from terminal events, not stage labels',
  ],
  [
    'task:retry_requested',
    'lineage is exposed via TaskInput.parentTaskId on the new task — the event is audit-only',
  ],
  // Workflow step retry / fallback observability — final step state is in workflow:step_complete
  [
    'workflow:step_fallback',
    'fallback usage is reflected in the final step status (fallbackUsed); event is audit-only',
  ],
  [
    'workflow:step_retry',
    'retry attempts are observability — projection surfaces only the final step outcome',
  ],
  [
    'workflow:step_retry_skipped',
    'budget-veto observability — projection lifecycle reflects the resulting failure',
  ],
  // Delegate sub-task lifecycle — projection.plan.multiAgentSubtasks already tracks via subtask_updated
  [
    'workflow:delegate_completed',
    'workflow:subtask_updated already carries the same lifecycle data; this event duplicates for live UX',
  ],
  [
    'workflow:delegate_timeout',
    'workflow:subtask_updated reports the timeout outcome on the subtask',
  ],
  [
    'workflow:delegate_failed',
    'workflow:subtask_updated reports the failure outcome on the subtask',
  ],
  [
    'workflow:synthesizer_compression_detected',
    'synthesizer telemetry — not part of process state surface',
  ],
  // Coding-CLI session lifecycle — projection reads CodingCliStore session row directly,
  // not by folding events. The store column already carries the durable state.
  ['coding-cli:session_created', 'projection reads session row from CodingCliStore.getByTaskId, not from events'],
  ['coding-cli:session_started', 'session row in CodingCliStore carries startedAt / state'],
  ['coding-cli:state_changed', 'session.state in CodingCliStore is updated synchronously with this event'],
  ['coding-cli:message_sent', 'inter-process liveness signal — not surface state'],
  ['coding-cli:output_delta', 'live stdout buffer — frontend keeps this transiently, projection does not'],
  ['coding-cli:tool_started', 'live tool activity — not in projection scope (yet)'],
  ['coding-cli:tool_completed', 'live tool activity — not in projection scope (yet)'],
  ['coding-cli:file_changed', 'CodingCliStore session.filesChanged carries the durable list'],
  ['coding-cli:command_requested', 'CodingCliStore session.commandsRequested carries the durable list'],
  ['coding-cli:command_completed', 'liveness signal — not surface state'],
  ['coding-cli:decision_recorded', 'decisions table read directly when needed; not in projection surface'],
  ['coding-cli:checkpoint', 'checkpoint observability — not in projection surface'],
  ['coding-cli:result_reported', 'result captured on session.finalResult column'],
  ['coding-cli:verification_started', 'verification handled outside projection (separate trace)'],
  ['coding-cli:verification_completed', 'verification verdict surfaced via finalResult'],
  ['coding-cli:completed', 'session.state column is the durable terminal status'],
  // Tool-call audit
  [
    'agent:tool_denied',
    'tool denial is observability — projection surfaces tool_executed status field for granted/denied/error',
  ],
]);

const DEFAULT_MAX_EVENTS = 5000;

const EMPTY_GATE: TaskProcessGate = Object.freeze({ open: false, resolved: false });

export class TaskProcessProjectionService {
  constructor(private readonly deps: TaskProcessProjectionDeps) {}

  /**
   * Build the projection for a task. Returns null when the task is
   * unknown to every backing store (no session row, no async result,
   * no events) — callers translate that to HTTP 404.
   */
  build(taskId: string): TaskProcessProjection | null {
    const events = this.loadEvents(taskId);
    const taskRow = this.deps.findTaskRow(taskId);
    const result = this.findResult(taskId, taskRow);
    const isInFlight = this.deps.inFlightTaskIds().has(taskId);
    const pendingApproval = this.deps.pendingApprovalTaskIds().has(taskId);
    const codingCliPresent =
      !!this.deps.codingCliStore && this.deps.codingCliStore.getByTaskId(taskId).length > 0;

    // Existence check — every signal is empty AND the task is unknown.
    if (
      events.length === 0 &&
      !taskRow &&
      !result &&
      !isInFlight &&
      !pendingApproval &&
      !codingCliPresent
    ) {
      return null;
    }

    const lifecycle = this.buildLifecycle({ taskId, events, taskRow, result, isInFlight });
    const completeness = this.buildCompleteness(events);
    const gates = this.buildGates({ taskId, events, pendingApproval });
    const plan = this.buildPlan(events);
    const codingCliSessions = this.buildCodingCliSessions(taskId);
    const diagnostics = this.buildDiagnostics(events);
    const history = this.buildHistory(taskId, events);
    return { lifecycle, completeness, gates, plan, codingCliSessions, diagnostics, history };
  }

  // ── private builders ────────────────────────────────────────────────

  private loadEvents(taskId: string): PersistedTaskEvent[] {
    const store = this.deps.taskEventStore;
    if (!store) return [];
    const limit = this.deps.maxEvents ?? DEFAULT_MAX_EVENTS;
    try {
      return store.listForTask(taskId, { limit });
    } catch {
      return [];
    }
  }

  private findResult(taskId: string, taskRow: SessionTaskRow | undefined): TaskResult | undefined {
    // 1. Session-attached durable result.
    if (taskRow?.result_json) {
      try {
        return JSON.parse(taskRow.result_json) as TaskResult;
      } catch {
        // fall through
      }
    }
    // 2. Async result map (orphaned sync result not bound to a session).
    return this.deps.asyncResults().get(taskId);
  }

  private buildLifecycle(args: {
    taskId: string;
    events: readonly PersistedTaskEvent[];
    taskRow: SessionTaskRow | undefined;
    result: TaskResult | undefined;
    isInFlight: boolean;
  }): TaskProcessLifecycle {
    const { taskId, events, taskRow, result, isInFlight } = args;
    const dbStatus = taskRow?.status;
    const resultStatus = result?.status;
    const startEvent = events.find((e) => e.eventType === 'task:start');
    const terminalEvent = lastTerminalEvent(events);
    const startedAt = startEvent?.ts ?? taskRow?.created_at;
    const updatedAt = taskRow?.updated_at ?? events[events.length - 1]?.ts;
    const finishedAt = terminalEvent?.ts;
    const durationMs =
      typeof result?.trace?.durationMs === 'number'
        ? result.trace.durationMs
        : startedAt && finishedAt && finishedAt >= startedAt
          ? finishedAt - startedAt
          : undefined;

    const status: TaskLifecycleStatus = (() => {
      if (isInFlight) return 'running';
      if (resultStatus === 'completed') return 'completed';
      if (resultStatus === 'input-required') return 'input-required';
      if (resultStatus === 'failed') return 'failed';
      if (resultStatus === 'escalated') return 'escalated';
      if (resultStatus === 'partial') return 'completed'; // partial result is a completion type
      if (terminalEvent?.eventType === 'task:cancelled') return 'cancelled';
      if (terminalEvent?.eventType === 'task:timeout') return 'timeout';
      if (terminalEvent?.eventType === 'task:failed' || terminalEvent?.eventType === 'task:escalate')
        return 'failed';
      if (terminalEvent?.eventType === 'task:complete' || terminalEvent?.eventType === 'task:done')
        return 'completed';
      if (dbStatus === 'running') return 'running';
      if (dbStatus === 'completed') return 'completed';
      if (dbStatus === 'failed') return 'failed';
      if (dbStatus === 'cancelled') return 'cancelled';
      return 'pending';
    })();

    const terminalReason = (() => {
      if (!terminalEvent) return undefined;
      const p = terminalEvent.payload as Record<string, unknown> | null;
      if (!p) return undefined;
      const candidate =
        (typeof p.reason === 'string' && p.reason) ||
        (typeof p.cancelReason === 'string' && p.cancelReason) ||
        (typeof p.failureReason === 'string' && p.failureReason) ||
        (typeof p.escalationReason === 'string' && p.escalationReason) ||
        (typeof p.error === 'string' && p.error) ||
        undefined;
      return typeof candidate === 'string' && candidate.length > 0 ? candidate : undefined;
    })();

    const lifecycle: TaskProcessLifecycle = {
      taskId,
      status,
    };
    if (taskRow?.session_id) lifecycle.sessionId = taskRow.session_id;
    if (dbStatus) lifecycle.dbStatus = dbStatus;
    if (resultStatus) lifecycle.resultStatus = resultStatus;
    if (typeof startedAt === 'number') lifecycle.startedAt = startedAt;
    if (typeof updatedAt === 'number') lifecycle.updatedAt = updatedAt;
    if (typeof finishedAt === 'number') lifecycle.finishedAt = finishedAt;
    if (typeof durationMs === 'number') lifecycle.durationMs = durationMs;
    if (terminalEvent) lifecycle.terminalEventType = terminalEvent.eventType;
    if (terminalReason) lifecycle.terminalReason = terminalReason;
    return lifecycle;
  }

  /**
   * Mirror of the frontend's old `replayCompleteness` algorithm — but
   * authoritative because it runs against the durable event log on the
   * server side. Frontend will downgrade its copy to a display adapter
   * that reads this field instead of re-classifying.
   */
  private buildCompleteness(events: readonly PersistedTaskEvent[]): TaskProcessCompleteness {
    if (events.length === 0) {
      return { kind: 'empty', eventCount: 0, truncated: false };
    }
    let gateDepth = 0;
    let terminal: PersistedTaskEvent | undefined;
    for (const ev of events) {
      if (TERMINAL_EVENTS.has(ev.eventType)) {
        terminal = ev;
        gateDepth = 0; // terminal collapses all open gates from a UX perspective
        continue;
      }
      if (isGateOpenEvent(ev)) gateDepth += 1;
      else if (isGateCloseEvent(ev.eventType)) gateDepth = Math.max(0, gateDepth - 1);
    }
    const firstTs = events[0]!.ts;
    const lastTs = events[events.length - 1]!.ts;
    const base = { eventCount: events.length, firstTs, lastTs, truncated: false };
    if (terminal) {
      const terminalEventType = terminal.eventType;
      if (
        terminalEventType === 'task:failed' ||
        terminalEventType === 'task:escalate' ||
        terminalEventType === 'task:timeout' ||
        terminalEventType === 'task:cancelled'
      ) {
        return { kind: 'terminal-error', ...base, reason: terminalEventType };
      }
      return { kind: 'complete', ...base };
    }
    if (gateDepth > 0) return { kind: 'awaiting-user', ...base };
    return { kind: 'missing-terminal', ...base };
  }

  private buildGates(args: {
    taskId: string;
    events: readonly PersistedTaskEvent[];
    pendingApproval: boolean;
  }): TaskProcessGates {
    const { taskId, events, pendingApproval } = args;
    return {
      approval: this.buildApprovalGate(taskId, events, pendingApproval),
      workflowHumanInput: pairGate(
        events,
        'workflow:human_input_needed',
        'workflow:human_input_provided',
      ),
      partialDecision: pairGate(
        events,
        'workflow:partial_failure_decision_needed',
        'workflow:partial_failure_decision_provided',
      ),
      codingCliApproval: this.buildCodingCliGate(taskId, events),
    };
  }

  private buildApprovalGate(
    taskId: string,
    events: readonly PersistedTaskEvent[],
    pendingApproval: boolean,
  ): TaskProcessGate {
    // Prefer the durable ledger when wired — it survives restart and
    // carries the open/resolved record the in-memory ApprovalGate
    // alone cannot replay.
    const ledger = this.deps.approvalLedgerStore;
    if (ledger) {
      const open = safeOpenLedger(ledger, taskId);
      if (open) {
        return {
          open: true,
          resolved: false,
          openedAt: open.requestedAt,
          ...(open.id ? { openedEventId: `approval-ledger:${open.id}` } : {}),
          detail: {
            ledgerId: open.id,
            riskScore: open.riskScore,
            reason: open.reason,
            source: open.source,
          },
        };
      }
      const records = safeFindByTask(ledger, taskId);
      const lastResolved = records.find((r) => r.resolvedAt !== null);
      if (lastResolved) {
        return {
          open: false,
          resolved: true,
          openedAt: lastResolved.requestedAt,
          ...(lastResolved.resolvedAt !== null ? { resolvedAt: lastResolved.resolvedAt } : {}),
          openedEventId: `approval-ledger:${lastResolved.id}`,
          resolvedEventId: `approval-ledger:${lastResolved.id}`,
          detail: {
            ledgerId: lastResolved.id,
            decision: lastResolved.decision,
            source: lastResolved.source,
          },
        };
      }
    }
    // Fallback to durable bus events (`approval:ledger_pending` / `_resolved`),
    // then to the in-memory ApprovalGate map.
    const eventGate = pairGate(events, 'approval:ledger_pending', 'approval:ledger_resolved');
    if (eventGate.open || eventGate.resolved) return eventGate;
    if (pendingApproval) return { open: true, resolved: false };
    return EMPTY_GATE;
  }

  private buildCodingCliGate(
    taskId: string,
    events: readonly PersistedTaskEvent[],
  ): TaskProcessGate {
    // Prefer the durable approval row from CodingCliStore — it is the
    // ground truth used by `/api/v1/coding-cli/...` resolution. Falls
    // back to the bus-event pair if the store is not wired.
    const store = this.deps.codingCliStore;
    if (store) {
      try {
        if (store.hasOpenApprovalForTask(taskId)) {
          const openRows = store.listOpenApprovalsForTasks([taskId]).get(taskId) ?? [];
          const oldest = openRows[0];
          return {
            open: true,
            resolved: false,
            ...(oldest ? { openedAt: oldest.requested_at, openedEventId: `coding-cli:${oldest.id}` } : {}),
            ...(oldest
              ? {
                  detail: {
                    sessionId: oldest.coding_cli_session_id,
                    requestId: oldest.request_id,
                    command: oldest.command,
                    reason: oldest.reason,
                    policyDecision: oldest.policy_decision,
                    pendingCount: openRows.length,
                  },
                }
              : {}),
          };
        }
        // Walk session approvals to surface the most recently resolved
        // row so the gate reads `resolved: true` instead of empty —
        // matches the workflow gate semantics above.
        const sessions = store.getByTaskId(taskId);
        let lastResolved: ApprovalRow | undefined;
        for (const session of sessions) {
          for (const row of store.listApprovals(session.id)) {
            if (row.human_decision !== null && row.decided_at !== null) {
              if (!lastResolved || row.decided_at > (lastResolved.decided_at ?? 0)) {
                lastResolved = row;
              }
            }
          }
        }
        if (lastResolved) {
          return {
            open: false,
            resolved: true,
            openedAt: lastResolved.requested_at,
            ...(lastResolved.decided_at !== null ? { resolvedAt: lastResolved.decided_at } : {}),
            openedEventId: `coding-cli:${lastResolved.id}`,
            resolvedEventId: `coding-cli:${lastResolved.id}`,
            detail: {
              sessionId: lastResolved.coding_cli_session_id,
              requestId: lastResolved.request_id,
              humanDecision: lastResolved.human_decision,
              decidedBy: lastResolved.decided_by,
              policyDecision: lastResolved.policy_decision,
            },
          };
        }
      } catch {
        // Store error → fall through to event-pair gate.
      }
    }
    return pairGate(events, 'coding-cli:approval_required', 'coding-cli:approval_resolved');
  }

  private buildPlan(events: readonly PersistedTaskEvent[]): TaskProcessPlan {
    let decisionStage: string | undefined;
    let groupMode: string | undefined;
    let winner: TaskProcessPlan['winner'];
    const todoMap = new Map<string, TaskProcessTodoItem>();
    const stepMap = new Map<string, TaskProcessPlanStep>();
    const subtaskMap = new Map<string, TaskProcessSubtask>();

    for (const ev of events) {
      const p = (ev.payload ?? {}) as Record<string, unknown>;
      switch (ev.eventType) {
        case 'workflow:decision_recorded': {
          if (typeof p.stage === 'string') decisionStage = p.stage;
          else if (typeof p.decisionStage === 'string') decisionStage = p.decisionStage;
          if (typeof p.groupMode === 'string') groupMode = p.groupMode;
          if (Array.isArray(p.steps)) {
            for (const step of p.steps as Array<Record<string, unknown>>) {
              if (typeof step.id !== 'string') continue;
              const existing = stepMap.get(step.id);
              stepMap.set(step.id, {
                id: step.id,
                description: typeof step.description === 'string' ? step.description : (existing?.description ?? ''),
                strategy: typeof step.strategy === 'string' ? step.strategy : existing?.strategy,
                status: existing?.status ?? 'pending',
                ...(typeof step.agentId === 'string' ? { agentId: step.agentId } : {}),
                ...(typeof step.subTaskId === 'string' ? { subTaskId: step.subTaskId } : {}),
              });
            }
          }
          break;
        }
        case 'workflow:todo_created': {
          if (Array.isArray(p.todos)) {
            for (const todo of p.todos as Array<Record<string, unknown>>) {
              if (typeof todo.id !== 'string') continue;
              todoMap.set(todo.id, {
                id: todo.id,
                content: typeof todo.content === 'string' ? todo.content : '',
                status: typeof todo.status === 'string' ? todo.status : 'pending',
                ...(typeof todo.activeForm === 'string' ? { activeForm: todo.activeForm } : {}),
              });
            }
          }
          break;
        }
        case 'workflow:todo_updated': {
          if (Array.isArray(p.todos)) {
            for (const todo of p.todos as Array<Record<string, unknown>>) {
              if (typeof todo.id !== 'string') continue;
              const existing = todoMap.get(todo.id);
              todoMap.set(todo.id, {
                id: todo.id,
                content:
                  typeof todo.content === 'string' ? todo.content : (existing?.content ?? ''),
                status: typeof todo.status === 'string' ? todo.status : (existing?.status ?? 'pending'),
                ...(typeof todo.activeForm === 'string'
                  ? { activeForm: todo.activeForm }
                  : existing?.activeForm
                    ? { activeForm: existing.activeForm }
                    : {}),
              });
            }
          }
          break;
        }
        case 'workflow:subtasks_planned': {
          if (typeof p.groupMode === 'string') groupMode = p.groupMode;
          if (Array.isArray(p.subtasks)) {
            for (const st of p.subtasks as Array<Record<string, unknown>>) {
              if (typeof st.subtaskId !== 'string') continue;
              subtaskMap.set(st.subtaskId, {
                subtaskId: st.subtaskId,
                stepId: typeof st.stepId === 'string' ? st.stepId : '',
                status: typeof st.status === 'string' ? st.status : 'planned',
                ...(typeof st.agentId === 'string' ? { agentId: st.agentId } : {}),
              });
            }
          }
          break;
        }
        case 'workflow:subtask_updated': {
          const subtaskId = typeof p.subtaskId === 'string' ? p.subtaskId : undefined;
          if (!subtaskId) break;
          const existing = subtaskMap.get(subtaskId) ?? {
            subtaskId,
            stepId: typeof p.stepId === 'string' ? p.stepId : '',
            status: 'unknown',
          };
          subtaskMap.set(subtaskId, {
            ...existing,
            ...(typeof p.stepId === 'string' ? { stepId: p.stepId } : {}),
            status: typeof p.status === 'string' ? p.status : existing.status,
            ...(typeof p.agentId === 'string' ? { agentId: p.agentId } : {}),
            ...(typeof p.startedAt === 'number' ? { startedAt: p.startedAt } : {}),
            ...(typeof p.completedAt === 'number' ? { completedAt: p.completedAt } : {}),
            ...(typeof p.errorKind === 'string' ? { errorKind: p.errorKind } : {}),
            ...(typeof p.errorMessage === 'string' ? { errorMessage: p.errorMessage } : {}),
            ...(typeof p.outputPreview === 'string' ? { outputPreview: p.outputPreview } : {}),
          });
          break;
        }
        case 'workflow:step_start': {
          if (typeof p.stepId !== 'string') break;
          const existing = stepMap.get(p.stepId) ?? {
            id: p.stepId,
            description: '',
            status: 'pending',
          };
          stepMap.set(p.stepId, {
            ...existing,
            status: 'running',
            ...(typeof p.startedAt === 'number'
              ? { startedAt: p.startedAt }
              : { startedAt: ev.ts }),
          });
          break;
        }
        case 'workflow:step_complete': {
          if (typeof p.stepId !== 'string') break;
          const existing = stepMap.get(p.stepId) ?? {
            id: p.stepId,
            description: '',
            status: 'pending',
          };
          stepMap.set(p.stepId, {
            ...existing,
            status: typeof p.status === 'string' ? p.status : 'done',
            ...(typeof p.finishedAt === 'number'
              ? { finishedAt: p.finishedAt }
              : { finishedAt: ev.ts }),
            ...(typeof p.fallbackUsed === 'boolean' ? { fallbackUsed: p.fallbackUsed } : {}),
          });
          break;
        }
        case 'workflow:winner_determined': {
          winner = {
            ...(typeof p.winner === 'string' ? { agentId: p.winner } : {}),
            ...(typeof p.runnerUpAgentId === 'string' ? { runnerUpAgentId: p.runnerUpAgentId } : {}),
            ...(typeof p.reasoning === 'string' ? { reasoning: p.reasoning } : {}),
          };
          break;
        }
        default:
          break;
      }
    }

    return {
      ...(decisionStage ? { decisionStage } : {}),
      ...(groupMode ? { groupMode } : {}),
      ...(winner ? { winner } : {}),
      todoList: Array.from(todoMap.values()),
      steps: Array.from(stepMap.values()),
      multiAgentSubtasks: Array.from(subtaskMap.values()),
    };
  }

  private buildCodingCliSessions(taskId: string): TaskProcessCodingCliSession[] {
    const store = this.deps.codingCliStore;
    if (!store) return [];
    let sessions: ReturnType<typeof store.getByTaskId>;
    try {
      sessions = store.getByTaskId(taskId);
    } catch {
      return [];
    }
    return sessions.map((session) => {
      let approvals: ApprovalRow[] = [];
      try {
        approvals = store.listApprovals(session.id);
      } catch {
        approvals = [];
      }
      const pendingApprovals: TaskProcessCodingCliPendingApproval[] = [];
      const resolvedApprovals: TaskProcessCodingCliResolvedApproval[] = [];
      for (const row of approvals) {
        if (row.human_decision === null) {
          pendingApprovals.push({
            requestId: row.request_id,
            command: row.command,
            reason: row.reason,
            policyDecision: row.policy_decision,
            requestedAt: row.requested_at,
          });
        } else {
          resolvedApprovals.push({
            requestId: row.request_id,
            command: row.command,
            policyDecision: row.policy_decision,
            humanDecision: row.human_decision,
            decidedBy: row.decided_by ?? 'unknown',
            decidedAt: row.decided_at ?? row.requested_at,
            requestedAt: row.requested_at,
          });
        }
      }
      const terminalContext = readTerminalContext(store, session.id, session.state);
      const out: TaskProcessCodingCliSession = {
        id: session.id,
        taskId: session.taskId,
        providerId: session.providerId,
        state: session.state,
        startedAt: session.startedAt,
        updatedAt: session.updatedAt,
        ...(session.endedAt !== null ? { endedAt: session.endedAt } : {}),
        filesChanged: [...session.filesChanged],
        commandsRequested: [...session.commandsRequested],
        pendingApprovals,
        resolvedApprovals,
        ...(session.finalResult ? { finalResult: session.finalResult } : {}),
        ...(terminalContext.failureDetail ? { failureDetail: terminalContext.failureDetail } : {}),
        ...(terminalContext.cancelDetail ? { cancelDetail: terminalContext.cancelDetail } : {}),
        ...(terminalContext.stalledDetail ? { stalledDetail: terminalContext.stalledDetail } : {}),
      };
      return out;
    });
  }

  private buildDiagnostics(events: readonly PersistedTaskEvent[]): TaskProcessDiagnostics {
    const phases = new Map<string, TaskProcessPhase>();
    const toolCalls = new Map<string, TaskProcessToolCall>();
    const oracleVerdicts: TaskProcessOracleVerdict[] = [];
    const escalations: TaskProcessEscalation[] = [];
    let routingLevel: number | undefined;

    for (const ev of events) {
      const p = (ev.payload ?? {}) as Record<string, unknown>;
      switch (ev.eventType) {
        case 'phase:timing':
        case 'phase:start':
        case 'phase:complete': {
          const name = typeof p.phase === 'string' ? p.phase : typeof p.name === 'string' ? p.name : undefined;
          if (!name) break;
          const existing = phases.get(name) ?? { name, status: 'started', startedAt: ev.ts };
          if (ev.eventType === 'phase:complete' || typeof p.durationMs === 'number') {
            phases.set(name, {
              ...existing,
              status: 'completed',
              finishedAt: ev.ts,
              ...(typeof p.durationMs === 'number'
                ? { durationMs: p.durationMs }
                : { durationMs: ev.ts - existing.startedAt }),
            });
          } else {
            phases.set(name, existing);
          }
          break;
        }
        case 'agent:tool_started': {
          const callId = typeof p.callId === 'string' ? p.callId : undefined;
          const tool = typeof p.tool === 'string' ? p.tool : 'unknown';
          if (!callId) break;
          toolCalls.set(callId, { callId, tool, status: 'started', ts: ev.ts });
          break;
        }
        case 'agent:tool_executed': {
          const callId = typeof p.callId === 'string' ? p.callId : undefined;
          const tool = typeof p.tool === 'string' ? p.tool : 'unknown';
          if (!callId) break;
          const existing = toolCalls.get(callId) ?? { callId, tool, status: 'started', ts: ev.ts };
          toolCalls.set(callId, {
            ...existing,
            status: typeof p.status === 'string' ? p.status : 'success',
            ts: ev.ts,
            ...(typeof p.outputPreview === 'string' ? { outputPreview: p.outputPreview } : {}),
          });
          break;
        }
        case 'oracle:verdict': {
          const oracle = typeof p.oracle === 'string' ? p.oracle : undefined;
          if (!oracle) break;
          oracleVerdicts.push({
            oracle,
            verdict: typeof p.verdict === 'string' ? p.verdict : 'unknown',
            ...(typeof p.confidence === 'number' ? { confidence: p.confidence } : {}),
            ts: ev.ts,
          });
          break;
        }
        case 'task:escalate': {
          escalations.push({
            ...(typeof p.fromLevel === 'number' ? { fromLevel: p.fromLevel } : {}),
            ...(typeof p.toLevel === 'number' ? { toLevel: p.toLevel } : {}),
            ...(typeof p.reason === 'string' ? { reason: p.reason } : {}),
            ts: ev.ts,
          });
          break;
        }
        case 'task:start': {
          if (typeof p.routingLevel === 'number') routingLevel = p.routingLevel;
          break;
        }
        case 'agent:routed': {
          if (typeof p.routingLevel === 'number') routingLevel = p.routingLevel;
          break;
        }
        default:
          break;
      }
    }
    return {
      phases: Array.from(phases.values()),
      toolCalls: Array.from(toolCalls.values()),
      oracleVerdicts,
      escalations,
      ...(typeof routingLevel === 'number' ? { routingLevel } : {}),
    };
  }

  private buildHistory(taskId: string, events: readonly PersistedTaskEvent[]): TaskProcessHistory {
    const lastSeq = events.length > 0 ? events[events.length - 1]!.seq : 0;
    const limit = this.deps.maxEvents ?? DEFAULT_MAX_EVENTS;
    const truncated = events.length >= limit;
    const descendants = (() => {
      const store = this.deps.taskEventStore;
      if (!store) return [];
      try {
        return store.listChildTaskIds(taskId);
      } catch {
        return [];
      }
    })();
    return {
      lastSeq,
      eventCount: events.length,
      truncated,
      descendantTaskIds: descendants,
    };
  }
}

// ── Helpers ─────────────────────────────────────────────────────────

function lastTerminalEvent(events: readonly PersistedTaskEvent[]): PersistedTaskEvent | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i]!;
    if (TERMINAL_EVENTS.has(ev.eventType)) return ev;
  }
  return undefined;
}

const GATE_OPEN_EVENT_TYPES: ReadonlySet<string> = new Set([
  'workflow:human_input_needed',
  'workflow:partial_failure_decision_needed',
  'coding-cli:approval_required',
  'approval:ledger_pending',
]);

const GATE_CLOSE_EVENT_TYPES: ReadonlySet<string> = new Set([
  'workflow:human_input_provided',
  'workflow:partial_failure_decision_provided',
  'coding-cli:approval_resolved',
  'approval:ledger_resolved',
  'approval:ledger_superseded',
]);

function isGateOpenEvent(ev: PersistedTaskEvent): boolean {
  if (GATE_OPEN_EVENT_TYPES.has(ev.eventType)) return true;
  // `workflow:plan_ready` only counts as a gate when the payload says so.
  if (ev.eventType === 'workflow:plan_ready') {
    const p = ev.payload as { awaitingApproval?: unknown } | null;
    return !!(p && p.awaitingApproval === true);
  }
  return false;
}

function isGateCloseEvent(eventType: string): boolean {
  if (GATE_CLOSE_EVENT_TYPES.has(eventType)) return true;
  if (eventType === 'workflow:plan_approved' || eventType === 'workflow:plan_rejected') return true;
  return false;
}

function pairGate(
  events: readonly PersistedTaskEvent[],
  openedType: string,
  resolvedType: string,
): TaskProcessGate {
  let open = 0;
  let lastOpened: PersistedTaskEvent | undefined;
  let lastResolved: PersistedTaskEvent | undefined;
  for (const ev of events) {
    if (ev.eventType === openedType) {
      open += 1;
      lastOpened = ev;
    } else if (ev.eventType === resolvedType) {
      open = Math.max(0, open - 1);
      lastResolved = ev;
    }
  }
  if (open > 0 && lastOpened) {
    return {
      open: true,
      resolved: false,
      openedAt: lastOpened.ts,
      openedEventId: lastOpened.id,
      detail: detailFromPayload(lastOpened.payload),
    };
  }
  if (lastResolved && lastOpened) {
    return {
      open: false,
      resolved: true,
      openedAt: lastOpened.ts,
      resolvedAt: lastResolved.ts,
      openedEventId: lastOpened.id,
      resolvedEventId: lastResolved.id,
      detail: detailFromPayload(lastResolved.payload),
    };
  }
  return EMPTY_GATE;
}

function detailFromPayload(payload: unknown): Record<string, unknown> | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const o = payload as Record<string, unknown>;
  // Strip any `taskId` / `sessionId` echoes — those are already on the
  // projection. Keep everything else for the UI to render verbatim.
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) {
    if (k === 'taskId' || k === 'sessionId') continue;
    out[k] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function safeOpenLedger(store: ApprovalLedgerStore, taskId: string): ApprovalLedgerRecord | null {
  try {
    return store.findOpenByTask(taskId);
  } catch {
    return null;
  }
}

function safeFindByTask(
  store: ApprovalLedgerStore,
  taskId: string,
): readonly ApprovalLedgerRecord[] {
  try {
    return store.findByTask(taskId);
  } catch {
    return [];
  }
}

interface TerminalContext {
  readonly failureDetail?: TaskProcessCodingCliFailureDetail;
  readonly cancelDetail?: TaskProcessCodingCliCancelDetail;
  readonly stalledDetail?: TaskProcessCodingCliStalledDetail;
}

/**
 * Walk the per-session `coding_cli_events` log and pick out the most
 * recent failure / cancel / stalled events, extracting reason fields
 * from their payloads. The result is the backend-authoritative replacement
 * for the frontend reducer's `failureReason` / `cancelled` / `stalled`
 * fields — the `coding-cli:failed`, `coding-cli:cancelled`, and
 * `coding-cli:stalled` events ARE persisted (manifest entries flagged
 * `record: true`), so this is non-stub authority.
 *
 * Stalled is a non-terminal hint, so we always read it; cancel/failure
 * are only read when the session's `state` matches — defensive against
 * an old stalled event lingering on a successful session.
 */
function readTerminalContext(
  store: CodingCliStore,
  sessionId: string,
  state: string,
): TerminalContext {
  let events: ReadonlyArray<{
    event_type: string;
    payload_json: string;
    ts: number;
  }>;
  try {
    events = store.listEvents(sessionId, { limit: 5000 });
  } catch {
    return {};
  }
  let failureDetail: TaskProcessCodingCliFailureDetail | undefined;
  let cancelDetail: TaskProcessCodingCliCancelDetail | undefined;
  let stalledDetail: TaskProcessCodingCliStalledDetail | undefined;
  // Walk newest-to-oldest so the FIRST match per kind is the most
  // recent — typical retries / re-stalls preserve only the latest.
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i]!;
    if (state === 'failed' && !failureDetail && ev.event_type === 'coding-cli:failed') {
      const payload = safeParsePayload(ev.payload_json);
      const reason = pickStringField(payload, 'reason') ?? pickStringField(payload, 'error');
      failureDetail = { ...(reason ? { reason } : {}), at: ev.ts };
    } else if (
      state === 'cancelled' &&
      !cancelDetail &&
      ev.event_type === 'coding-cli:cancelled'
    ) {
      const payload = safeParsePayload(ev.payload_json);
      const by = pickStringField(payload, 'by') ?? pickStringField(payload, 'cancelledBy');
      const reason = pickStringField(payload, 'reason');
      cancelDetail = {
        ...(by ? { by } : {}),
        ...(reason ? { reason } : {}),
        at: ev.ts,
      };
    } else if (!stalledDetail && ev.event_type === 'coding-cli:stalled') {
      const payload = safeParsePayload(ev.payload_json);
      const idleMs = pickNumberField(payload, 'idleMs');
      stalledDetail = { idleMs: typeof idleMs === 'number' ? idleMs : 0, at: ev.ts };
    }
    if (failureDetail && cancelDetail && stalledDetail) break;
  }
  return {
    ...(failureDetail ? { failureDetail } : {}),
    ...(cancelDetail ? { cancelDetail } : {}),
    ...(stalledDetail ? { stalledDetail } : {}),
  };
}

function safeParsePayload(json: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(json) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // ignore — corrupt payload row degrades to no-context
  }
  return null;
}

function pickStringField(payload: Record<string, unknown> | null, key: string): string | undefined {
  if (!payload) return undefined;
  const v = payload[key];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function pickNumberField(payload: Record<string, unknown> | null, key: string): number | undefined {
  if (!payload) return undefined;
  const v = payload[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}
