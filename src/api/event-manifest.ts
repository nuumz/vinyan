/**
 * Event Delivery Manifest — single source of truth for which bus events are
 * UI-visible and how they should be delivered (live SSE, durable record, or
 * both). Replaces three previously-unsynchronized allowlists:
 *
 *   - `SSE_EVENTS` in `src/api/sse.ts`
 *   - `membershipFilteredEvents` / `unconditionalStepEvents` inside
 *     `createSessionSSEStream`
 *   - `RECORDED_EVENTS` in
 *     `src/orchestrator/observability/task-event-recorder.ts`
 *
 * Each entry declares delivery flags. Generated lists are derived by simple
 * filters so adding a new UI-visible event is a one-line manifest change,
 * not a synchronized edit across three files. Contract tests
 * (`tests/api/event-manifest.contract.test.ts`) assert that every UI-visible
 * workflow event carries `taskId` in its declared payload type — so the
 * recorder can persist it and the session SSE stream can membership-filter
 * deterministically. See docs/design/multi-agent-hardening-roadmap.md.
 *
 * Sensitive / internal events (auth tokens, raw oracle stdout, evolution
 * scoring internals) are intentionally NOT in the manifest. Adding them here
 * is the explicit gate that makes them external-visible.
 */
import type { BusEventName } from '../core/bus.ts';

/**
 * `task` — payload carries (or must carry) `taskId`. Live SSE filters per
 *   task; recorder persists keyed by `task_id`.
 * `session` — events that are session-lifecycle only (no taskId). Forwarded
 *   on session-scoped streams; not persisted in `task_events` (no key).
 * `global` — system-wide signals (sleep/evolution/graph). Forwarded on
 *   session streams as informational; not persisted per-task.
 */
export type EventScope = 'task' | 'session' | 'global';

export interface EventManifestEntry {
  event: BusEventName;
  /** Forward live to SSE clients. */
  sse: boolean;
  /** Persist to `task_events` for historical replay (requires task scope). */
  record: boolean;
  scope: EventScope;
  /**
   * For session-scoped SSE streams: when true, the event is forwarded to the
   * subscribed session even without a taskId membership match. Used for
   * pure session-lifecycle events that don't belong to one task. UI-visible
   * task events MUST set this to false — the membership filter is what
   * keeps cross-session leakage out of the wire.
   */
  sessionBypass?: boolean;
}

/**
 * Manifest of every UI-visible bus event. Order is informational
 * (grouped by subsystem); generated lists do not depend on order.
 *
 * Adding a new entry is the only place you should ever touch when surfacing
 * a new event to the chat UI / VS Code extension. If you also need
 * historical replay, set `record: true`; the contract test enforces that the
 * payload type carries `taskId` so the recorder can persist it.
 */
export const EVENT_MANIFEST: readonly EventManifestEntry[] = [
  // ── Task lifecycle ───────────────────────────────────────────────────
  { event: 'task:start', sse: true, record: true, scope: 'task' },
  { event: 'task:complete', sse: true, record: false, scope: 'task' },
  { event: 'task:escalate', sse: true, record: true, scope: 'task' },
  { event: 'task:timeout', sse: true, record: true, scope: 'task' },
  { event: 'task:stage_update', sse: true, record: true, scope: 'task' },
  { event: 'task:approval_required', sse: true, record: false, scope: 'task' },
  { event: 'task:retry_requested', sse: true, record: false, scope: 'task' },

  // ── Pipeline timing / grounding ─────────────────────────────────────
  { event: 'phase:timing', sse: true, record: true, scope: 'task' },
  { event: 'trace:record', sse: true, record: false, scope: 'task' },
  { event: 'grounding:checked', sse: true, record: false, scope: 'task' },
  { event: 'degradation:triggered', sse: true, record: false, scope: 'task' },

  // ── Worker / oracle / critic / shadow ───────────────────────────────
  { event: 'worker:dispatch', sse: true, record: true, scope: 'task' },
  { event: 'worker:selected', sse: true, record: true, scope: 'task' },
  { event: 'worker:complete', sse: true, record: true, scope: 'task' },
  { event: 'worker:error', sse: true, record: true, scope: 'task' },
  { event: 'oracle:verdict', sse: true, record: true, scope: 'task' },
  { event: 'critic:verdict', sse: true, record: true, scope: 'task' },
  { event: 'shadow:complete', sse: true, record: true, scope: 'task' },
  { event: 'skill:match', sse: true, record: true, scope: 'task' },
  { event: 'skill:miss', sse: true, record: true, scope: 'task' },
  { event: 'tools:executed', sse: true, record: true, scope: 'task' },

  // ── Agent Conversation: per-turn observability ──────────────────────
  { event: 'agent:session_start', sse: true, record: false, scope: 'session', sessionBypass: true },
  { event: 'agent:session_end', sse: true, record: false, scope: 'session', sessionBypass: true },
  { event: 'agent:turn_complete', sse: true, record: true, scope: 'task' },
  { event: 'agent:tool_started', sse: true, record: true, scope: 'task' },
  { event: 'agent:tool_executed', sse: true, record: true, scope: 'task' },
  { event: 'agent:tool_denied', sse: true, record: true, scope: 'task' },
  { event: 'agent:text_delta', sse: true, record: true, scope: 'task' },
  { event: 'agent:thinking', sse: true, record: true, scope: 'task' },
  { event: 'agent:contract_violation', sse: true, record: true, scope: 'task' },
  { event: 'agent:plan_update', sse: true, record: true, scope: 'task' },
  { event: 'llm:stream_delta', sse: true, record: true, scope: 'task' },
  { event: 'agent:clarification_requested', sse: true, record: true, scope: 'task' },

  // ── Capability-first observability (process timeline cards) ─────────
  { event: 'agent:routed', sse: true, record: true, scope: 'task' },
  { event: 'agent:synthesized', sse: true, record: true, scope: 'task' },
  { event: 'agent:synthesis-failed', sse: true, record: true, scope: 'task' },
  { event: 'agent:capability-research', sse: true, record: true, scope: 'task' },
  { event: 'agent:capability-research-failed', sse: true, record: true, scope: 'task' },

  // ── Workflow: approval gate + step transitions + delegation ─────────
  { event: 'workflow:plan_ready', sse: true, record: true, scope: 'task' },
  { event: 'workflow:plan_approved', sse: true, record: true, scope: 'task' },
  { event: 'workflow:plan_rejected', sse: true, record: true, scope: 'task' },
  { event: 'workflow:step_start', sse: true, record: true, scope: 'task' },
  { event: 'workflow:step_complete', sse: true, record: true, scope: 'task' },
  { event: 'workflow:step_fallback', sse: true, record: true, scope: 'task' },
  { event: 'workflow:delegate_dispatched', sse: true, record: true, scope: 'task' },
  { event: 'workflow:delegate_completed', sse: true, record: true, scope: 'task' },
  { event: 'workflow:delegate_timeout', sse: true, record: true, scope: 'task' },
  { event: 'workflow:human_input_needed', sse: true, record: true, scope: 'task' },
  { event: 'workflow:human_input_provided', sse: true, record: true, scope: 'task' },
  { event: 'workflow:partial_failure_decision_needed', sse: true, record: true, scope: 'task' },
  { event: 'workflow:partial_failure_decision_provided', sse: true, record: true, scope: 'task' },
  // Synthesizer / planner observability — recorded for audit replay only.
  { event: 'workflow:synthesizer_compression_detected', sse: false, record: true, scope: 'task' },
  { event: 'workflow:planner_validation_warning', sse: false, record: false, scope: 'global' },

  // ── Guardrails — surfaced live; not persisted per-task. ─────────────
  { event: 'guardrail:injection_detected', sse: true, record: false, scope: 'task' },
  { event: 'guardrail:bypass_detected', sse: true, record: false, scope: 'task' },

  // ── Knowledge surface — system-wide, session-bypass. ────────────────
  { event: 'skill:outcome', sse: true, record: false, scope: 'global', sessionBypass: true },
  { event: 'evolution:rulesApplied', sse: true, record: false, scope: 'global', sessionBypass: true },
  { event: 'evolution:rulePromoted', sse: true, record: false, scope: 'global', sessionBypass: true },
  { event: 'evolution:ruleRetired', sse: true, record: false, scope: 'global', sessionBypass: true },
  { event: 'sleep:cycleComplete', sse: true, record: false, scope: 'global', sessionBypass: true },
  { event: 'graph:fact', sse: true, record: false, scope: 'global', sessionBypass: true },

  // ── Session lifecycle ───────────────────────────────────────────────
  { event: 'session:created', sse: true, record: false, scope: 'session', sessionBypass: true },
  { event: 'session:compacted', sse: true, record: false, scope: 'session', sessionBypass: true },
  { event: 'session:updated', sse: true, record: false, scope: 'session', sessionBypass: true },
  { event: 'session:archived', sse: true, record: false, scope: 'session', sessionBypass: true },
  { event: 'session:unarchived', sse: true, record: false, scope: 'session', sessionBypass: true },
  { event: 'session:deleted', sse: true, record: false, scope: 'session', sessionBypass: true },
  { event: 'session:restored', sse: true, record: false, scope: 'session', sessionBypass: true },
  { event: 'session:purged', sse: true, record: false, scope: 'session', sessionBypass: true },

  // ── Memory review outcomes ──────────────────────────────────────────
  { event: 'memory:approved', sse: true, record: false, scope: 'global', sessionBypass: true },
  { event: 'memory:rejected', sse: true, record: false, scope: 'global', sessionBypass: true },

  // ── External Coding CLI (provider-neutral) ──────────────────────────
  // Every UI-visible event the ExternalCodingCliController emits. Recorded
  // for historical replay so a task event-history endpoint can reconstruct
  // the entire CLI session timeline (state changes, tool/file activity,
  // approvals, verification verdict) after page reload (A8).
  { event: 'coding-cli:session_created', sse: true, record: true, scope: 'task' },
  { event: 'coding-cli:session_started', sse: true, record: true, scope: 'task' },
  { event: 'coding-cli:state_changed', sse: true, record: true, scope: 'task' },
  { event: 'coding-cli:message_sent', sse: true, record: true, scope: 'task' },
  { event: 'coding-cli:output_delta', sse: true, record: true, scope: 'task' },
  { event: 'coding-cli:tool_started', sse: true, record: true, scope: 'task' },
  { event: 'coding-cli:tool_completed', sse: true, record: true, scope: 'task' },
  { event: 'coding-cli:file_changed', sse: true, record: true, scope: 'task' },
  { event: 'coding-cli:command_requested', sse: true, record: true, scope: 'task' },
  { event: 'coding-cli:command_completed', sse: true, record: true, scope: 'task' },
  { event: 'coding-cli:approval_required', sse: true, record: true, scope: 'task' },
  { event: 'coding-cli:approval_resolved', sse: true, record: true, scope: 'task' },
  { event: 'coding-cli:decision_recorded', sse: true, record: true, scope: 'task' },
  { event: 'coding-cli:checkpoint', sse: true, record: true, scope: 'task' },
  { event: 'coding-cli:result_reported', sse: true, record: true, scope: 'task' },
  { event: 'coding-cli:verification_started', sse: true, record: true, scope: 'task' },
  { event: 'coding-cli:verification_completed', sse: true, record: true, scope: 'task' },
  { event: 'coding-cli:completed', sse: true, record: true, scope: 'task' },
  { event: 'coding-cli:failed', sse: true, record: true, scope: 'task' },
  { event: 'coding-cli:stalled', sse: true, record: true, scope: 'task' },
  { event: 'coding-cli:cancelled', sse: true, record: true, scope: 'task' },
];

/** Derived list: every event flagged for SSE forwarding. */
export const SSE_EVENTS: BusEventName[] = EVENT_MANIFEST.filter((e) => e.sse).map((e) => e.event);

/** Derived list: every event flagged for durable recording. */
export const RECORDED_EVENTS: BusEventName[] = EVENT_MANIFEST.filter((e) => e.record).map((e) => e.event);

/**
 * For session-scoped SSE: events that should be forwarded to the active
 * session even when a taskId is absent (or doesn't match the session's task
 * membership set). Examples: session-lifecycle pings, system-wide knowledge
 * updates that surface in the operator panel.
 *
 * Task-scoped events with `sessionBypass: false` go through the membership
 * filter built from `task:start` payloads; those filters are what prevent
 * cross-session leakage.
 */
export const SESSION_BYPASS_EVENTS: BusEventName[] = EVENT_MANIFEST.filter(
  (e) => e.sse && e.sessionBypass === true,
).map((e) => e.event);

/**
 * O(1) lookup index built once at module load. Hot paths (recorder bus
 * handler, SSE filter) hit this on every emit, so a linear scan was a
 * latent perf cliff at large manifest size. The Map stays the truth as
 * long as `EVENT_MANIFEST` is the only place new entries land.
 */
const MANIFEST_BY_EVENT: ReadonlyMap<BusEventName, EventManifestEntry> = (() => {
  const map = new Map<BusEventName, EventManifestEntry>();
  for (const entry of EVENT_MANIFEST) map.set(entry.event, entry);
  return map;
})();

export function lookupManifestEntry(event: BusEventName): EventManifestEntry | undefined {
  return MANIFEST_BY_EVENT.get(event);
}
