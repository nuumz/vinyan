/**
 * Contract tests for the event delivery manifest. The manifest is the
 * single source of truth for SSE-forwarded and persisted bus events;
 * these tests are the gate that prevents allowlist drift from quietly
 * stranding UI cards in PENDING.
 *
 * Three claims under test:
 *   1. Generated lists (SSE_EVENTS / RECORDED_EVENTS) are exact filters
 *      of the manifest — no manual override leaked back in.
 *   2. Every UI-visible workflow event declares `taskId` in its payload
 *      type — without it, the recorder drops the event and the
 *      session SSE membership filter can't attribute it.
 *   3. The runtime SSE + recorder modules import their lists from the
 *      manifest, not from a forked copy.
 */
import { describe, expect, test } from 'bun:test';
import {
  EVENT_MANIFEST,
  lookupManifestEntry,
  RECORDED_EVENTS,
  SESSION_BYPASS_EVENTS,
  SSE_EVENTS,
} from '../../src/api/event-manifest.ts';
import { SSE_EVENTS as SSE_EXPORTED } from '../../src/api/sse.ts';
import type { VinyanBusEvents } from '../../src/core/bus.ts';
import { RECORDED_EVENTS as RECORDER_EXPORTED } from '../../src/orchestrator/observability/task-event-recorder.ts';

/**
 * The exact set of workflow events the chat UI uses to render the
 * process timeline (approval gate, plan checklist, sub-agent rows,
 * human-input card). The user spec lists each of these explicitly and
 * requires taskId presence — without it, replay loses attribution and
 * the membership filter on session-scoped SSE drops the event.
 *
 * If you add a new UI-visible workflow event, list it here and it must
 * declare `taskId: string` in `VinyanBusEvents` (the type assertion below
 * will fail the build otherwise).
 */
const UI_VISIBLE_WORKFLOW_EVENTS = [
  'workflow:plan_created',
  'workflow:step_start',
  'workflow:step_complete',
  'workflow:step_fallback',
  'workflow:human_input_needed',
  'workflow:human_input_provided',
  'workflow:delegate_dispatched',
  'workflow:delegate_completed',
  'workflow:delegate_timeout',
  'workflow:plan_ready',
  'workflow:plan_approved',
  'workflow:plan_rejected',
] as const;

// Compile-time contract: every UI-visible workflow event payload must
// satisfy `{ taskId: string }`. If a future bus.ts change drops the
// field, this conditional collapses to `never` and TS errors — the
// build fails, the user never sees a stuck PENDING.
type _RequireTaskId<E extends keyof VinyanBusEvents> = VinyanBusEvents[E] extends { taskId: string } ? E : never;
type _HasTaskId = _RequireTaskId<(typeof UI_VISIBLE_WORKFLOW_EVENTS)[number]>;
const _compileTimeProof: _HasTaskId[] = [...UI_VISIBLE_WORKFLOW_EVENTS];
// Reference the symbol so the import isn't elided by the bundler.
void _compileTimeProof;

describe('event manifest contract', () => {
  test('SSE_EVENTS is generated from the manifest (no manual overrides)', () => {
    const fromManifest = EVENT_MANIFEST.filter((e) => e.sse).map((e) => e.event);
    expect([...SSE_EVENTS].sort()).toEqual([...fromManifest].sort());
  });

  test('RECORDED_EVENTS is generated from the manifest (no manual overrides)', () => {
    const fromManifest = EVENT_MANIFEST.filter((e) => e.record).map((e) => e.event);
    expect([...RECORDED_EVENTS].sort()).toEqual([...fromManifest].sort());
  });

  test('sse.ts and task-event-recorder.ts re-export the manifest lists, not forks', () => {
    // Identity-equal exports — the runtime modules must consume the
    // manifest, otherwise drift can sneak back in via copy-paste.
    expect(SSE_EXPORTED).toBe(SSE_EVENTS);
    expect(RECORDER_EXPORTED).toBe(RECORDED_EVENTS);
  });

  test('every UI-visible workflow event is on the SSE manifest', () => {
    for (const event of UI_VISIBLE_WORKFLOW_EVENTS) {
      const entry = lookupManifestEntry(event);
      expect(entry, `manifest entry missing for ${event}`).toBeDefined();
      expect(entry?.sse, `${event} must be SSE-forwarded`).toBe(true);
    }
  });

  test('every UI-visible workflow event is recordable', () => {
    for (const event of UI_VISIBLE_WORKFLOW_EVENTS) {
      const entry = lookupManifestEntry(event);
      expect(entry?.record, `${event} must be persisted to task_events`).toBe(true);
    }
  });

  test('every recordable manifest entry is task-scoped (recorder needs taskId)', () => {
    // The recorder skips events without taskId (see extractIds + the
    // !ids.taskId guard). Marking a non-task event as recordable would
    // silently no-op; surface the mismatch here.
    for (const entry of EVENT_MANIFEST) {
      if (!entry.record) continue;
      expect(entry.scope, `${entry.event} flagged record:true but scope=${entry.scope}`).toBe('task');
    }
  });

  test('SESSION_BYPASS_EVENTS only contains entries flagged sessionBypass:true', () => {
    for (const event of SESSION_BYPASS_EVENTS) {
      const entry = lookupManifestEntry(event);
      expect(entry?.sessionBypass).toBe(true);
      expect(entry?.sse).toBe(true);
    }
  });

  test('manifest is unique by event name', () => {
    const seen = new Set<string>();
    for (const entry of EVENT_MANIFEST) {
      expect(seen.has(entry.event), `duplicate manifest entry for ${entry.event}`).toBe(false);
      seen.add(entry.event);
    }
  });
});
