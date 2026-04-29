/**
 * ProcessStateReconciler — verifies the durable-history-as-truth
 * reconciliation logic that any UI client (future React hook, VS Code
 * extension) wraps. The class is backend-agnostic; the test injects
 * fake fetchers and asserts replay parity with live SSE.
 *
 * Acceptance focus from the spec:
 *   - missed `human_input_needed` is recovered after reconnect;
 *   - missed delegate `skipped`/`completed` updates the row from
 *     PENDING to skipped/done;
 *   - duplicate (live + replayed) does not double-apply;
 *   - after a critical user action POSTs, reconcile fetches latest
 *     event history.
 */
import { describe, expect, test } from 'bun:test';
import type { PersistedTaskEvent } from '../../src/db/task-event-store.ts';
import { ProcessStateReconciler } from '../../src/observability/process-state-reconciler.ts';

function makeEvent(
  taskId: string,
  seq: number,
  eventType: string,
  payload: unknown,
  sessionId = 'sess',
  ts = seq * 10,
): PersistedTaskEvent {
  return { id: `${taskId}-${seq}`, taskId, sessionId, seq, eventType, payload, ts };
}

interface MockReducerState {
  events: PersistedTaskEvent[];
  byId: Set<string>;
}

function makeReducer(): { state: MockReducerState; apply: (e: PersistedTaskEvent) => void } {
  const state: MockReducerState = { events: [], byId: new Set() };
  return {
    state,
    apply: (event) => {
      // Realistic idempotent reducer — duplicates by id are no-ops.
      if (state.byId.has(event.id)) return;
      state.byId.add(event.id);
      state.events.push(event);
    },
  };
}

describe('ProcessStateReconciler', () => {
  test('recovers a missed workflow:human_input_needed after reconnect', async () => {
    const reducer = makeReducer();
    const sessionEvents = [
      makeEvent('task-1', 1, 'workflow:plan_ready', { taskId: 'task-1' }),
      makeEvent('task-1', 2, 'workflow:step_start', { stepId: 's1' }),
      makeEvent('task-1', 3, 'workflow:human_input_needed', {
        stepId: 's1',
        question: 'pick a file',
      }),
    ];
    let calls = 0;
    const reconciler = new ProcessStateReconciler({
      fetchTaskHistory: async () => ({ events: [], lastSeq: 0 }),
      fetchSessionHistory: async () => {
        calls += 1;
        return calls === 1 ? { events: sessionEvents, nextCursor: '30:task-1-3' } : { events: [] };
      },
      applyEvent: reducer.apply,
    });

    const applied = await reconciler.reconcileSession('sess');
    expect(applied).toBe(3);
    expect(reducer.state.events.map((e) => e.eventType)).toEqual([
      'workflow:plan_ready',
      'workflow:step_start',
      'workflow:human_input_needed',
    ]);
  });

  test('missed delegate_completed (status:skipped) updates the row, not pending', async () => {
    const reducer = makeReducer();
    const reconciler = new ProcessStateReconciler({
      fetchTaskHistory: async () => ({ events: [], lastSeq: 0 }),
      fetchSessionHistory: async () => ({
        events: [
          makeEvent('t', 1, 'workflow:delegate_dispatched', { stepId: 'd1', agentId: 'a' }),
          makeEvent('t', 2, 'workflow:delegate_completed', {
            stepId: 'd1',
            status: 'skipped',
            outputPreview: '',
          }),
        ],
        nextCursor: undefined,
      }),
      applyEvent: reducer.apply,
    });
    await reconciler.reconcileSession('sess');

    const completion = reducer.state.events.find((e) => e.eventType === 'workflow:delegate_completed');
    expect(completion).toBeDefined();
    expect((completion?.payload as { status: string }).status).toBe('skipped');
  });

  test('ingestLive applies + dedupes; later replay does NOT double-apply', async () => {
    const reducer = makeReducer();
    const live = makeEvent('t', 5, 'workflow:step_complete', { stepId: 'x', status: 'completed' });

    const reconciler = new ProcessStateReconciler({
      fetchTaskHistory: async (taskId) => {
        // The reconciler should only ask for events strictly after seq=5.
        expect(taskId).toBe('t');
        return { events: [], lastSeq: 5 };
      },
      fetchSessionHistory: async () => ({
        // Server returns the same event the live SSE already delivered —
        // common race after a reconnect that overlaps the in-flight emit.
        events: [live],
        nextCursor: undefined,
      }),
      applyEvent: reducer.apply,
    });

    // Live path: ONE call dedupes + advances cursor + invokes reducer.
    // The previous API made the host call noteLiveEvent + reducer.apply
    // separately — that footgun is gone.
    const first = reconciler.ingestLive(live);
    expect(first.applied).toBe(true);
    expect(reducer.state.events.length).toBe(1);

    // A second ingestLive on the same id is suppressed.
    const second = reconciler.ingestLive(live);
    expect(second.applied).toBe(false);
    expect(reducer.state.events.length).toBe(1);

    // Reconnect → reconcile session. The seenIds dedupe must suppress.
    const applied = await reconciler.reconcileSession('sess');
    expect(applied).toBe(0);
    expect(reducer.state.events.length).toBe(1);

    // Per-task reconcile must also start from seq=5+1, not seq=1.
    await reconciler.reconcileTask('t');
    expect(reducer.state.events.length).toBe(1);
  });

  test('after a user action, reconcileSession fetches latest history', async () => {
    const reducer = makeReducer();
    let phase: 'before' | 'after' = 'before';
    let beforeServed = false;
    let afterServed = false;
    const reconciler = new ProcessStateReconciler({
      fetchTaskHistory: async () => ({ events: [], lastSeq: 0 }),
      fetchSessionHistory: async () => {
        if (phase === 'before') {
          if (beforeServed) return { events: [], nextCursor: undefined };
          beforeServed = true;
          return {
            events: [makeEvent('t', 1, 'workflow:plan_ready', {})],
            nextCursor: '10:t-1',
          };
        }
        if (afterServed) return { events: [], nextCursor: undefined };
        afterServed = true;
        return {
          events: [makeEvent('t', 2, 'workflow:plan_approved', { auto: false })],
          nextCursor: '20:t-2',
        };
      },
      applyEvent: reducer.apply,
    });

    await reconciler.reconcileSession('sess');
    expect(reducer.state.events.map((e) => e.eventType)).toEqual(['workflow:plan_ready']);

    // Simulate POST /sessions/:id/workflow/approve succeeding.
    phase = 'after';
    await reconciler.reconcileSession('sess');
    expect(reducer.state.events.map((e) => e.eventType)).toEqual(['workflow:plan_ready', 'workflow:plan_approved']);
  });

  test('concurrent reconcileSession calls collapse to one in-flight fetch', async () => {
    const reducer = makeReducer();
    let inFlight = 0;
    let maxConcurrent = 0;
    const reconciler = new ProcessStateReconciler({
      fetchTaskHistory: async () => ({ events: [], lastSeq: 0 }),
      fetchSessionHistory: async () => {
        inFlight += 1;
        maxConcurrent = Math.max(maxConcurrent, inFlight);
        await Bun.sleep(10);
        inFlight -= 1;
        return { events: [], nextCursor: undefined };
      },
      applyEvent: reducer.apply,
    });

    await Promise.all([
      reconciler.reconcileSession('sess'),
      reconciler.reconcileSession('sess'),
      reconciler.reconcileSession('sess'),
    ]);
    // Three concurrent calls must coalesce — the host can fire reconcile
    // freely from visibilitychange + reconnect + post-action without
    // hammering the server.
    expect(maxConcurrent).toBe(1);
  });

  test('reducer error in one event does not stall reconciliation of the rest', async () => {
    const applied: string[] = [];
    const reconciler = new ProcessStateReconciler({
      fetchTaskHistory: async () => ({ events: [], lastSeq: 0 }),
      fetchSessionHistory: async () => ({
        events: [makeEvent('t', 1, 'a', {}), makeEvent('t', 2, 'BOOM', {}), makeEvent('t', 3, 'c', {})],
        nextCursor: undefined,
      }),
      applyEvent: (event) => {
        if (event.eventType === 'BOOM') throw new Error('reducer blew up');
        applied.push(event.eventType);
      },
    });

    await reconciler.reconcileSession('sess');
    // Reducer error skipped — every other event still applied so the UI
    // continues recovering process state instead of freezing.
    expect(applied).toEqual(['a', 'c']);
  });

  test('replayed events produce the same observable state as live SSE', async () => {
    const liveReducer = makeReducer();
    const replayReducer = makeReducer();
    const events = [
      makeEvent('t', 1, 'workflow:plan_ready', { taskId: 't' }),
      makeEvent('t', 2, 'workflow:step_start', { stepId: 'a' }),
      makeEvent('t', 3, 'workflow:step_complete', { stepId: 'a', status: 'completed' }),
    ];

    // Live SSE pipeline: every event flows through the reducer once.
    for (const e of events) liveReducer.apply(e);

    // Replay pipeline: same events arrive via reconciler.
    const replayer = new ProcessStateReconciler({
      fetchTaskHistory: async () => ({ events: [], lastSeq: 0 }),
      fetchSessionHistory: async () => ({ events, nextCursor: undefined }),
      applyEvent: replayReducer.apply,
    });
    await replayer.reconcileSession('sess');

    expect(replayReducer.state.events.map((e) => e.id)).toEqual(liveReducer.state.events.map((e) => e.id));
  });

  test('onSyncing fires around reconciliation so UI can show a "syncing process" hint', async () => {
    const transitions: boolean[] = [];
    const reconciler = new ProcessStateReconciler({
      fetchTaskHistory: async () => ({ events: [], lastSeq: 0 }),
      fetchSessionHistory: async () => ({ events: [], nextCursor: undefined }),
      applyEvent: () => {},
      onSyncing: (state) => transitions.push(state.active),
    });

    await reconciler.reconcileSession('sess');
    expect(transitions).toEqual([true, false]);
  });

  test('runaway pagination is bounded by maxPagesPerReconcile', async () => {
    // A misbehaving server returns a non-empty page with a fresh cursor
    // every time. Without the page cap the reconciler would loop forever;
    // with it, the cycle terminates and onReplayed reports `truncated`.
    let pageNum = 0;
    let onReplayed: { truncated: boolean; appliedCount: number } | undefined;
    const reducer = makeReducer();
    const reconciler = new ProcessStateReconciler(
      {
        fetchTaskHistory: async () => ({ events: [], lastSeq: 0 }),
        fetchSessionHistory: async () => {
          pageNum += 1;
          return {
            events: [makeEvent('t', pageNum, 'phase:timing', { p: pageNum }, 'sess', pageNum * 10)],
            // Always advance the cursor so the loop continues.
            nextCursor: `${pageNum * 10}:t-${pageNum}`,
          };
        },
        applyEvent: reducer.apply,
        onReplayed: (info) => {
          onReplayed = info;
        },
      },
      { maxPagesPerReconcile: 5 },
    );

    const applied = await reconciler.reconcileSession('sess');
    // Bounded: 5 pages × 1 event = 5 applied, then we give up.
    expect(applied).toBe(5);
    expect(onReplayed?.truncated).toBe(true);
    expect(onReplayed?.appliedCount).toBe(5);
  });

  test('maxCursors evicts oldest cursor entries FIFO', async () => {
    const reducer = makeReducer();
    const reconciler = new ProcessStateReconciler(
      {
        fetchTaskHistory: async () => ({ events: [], lastSeq: 0 }),
        fetchSessionHistory: async () => ({ events: [], nextCursor: undefined }),
        applyEvent: reducer.apply,
      },
      { maxCursors: 50 },
    );

    // Force-feed cursor entries via ingestLive — each event mints one.
    for (let i = 0; i < 60; i++) {
      reconciler.ingestLive(makeEvent(`task-${i}`, 1, 'phase:timing', {}));
    }

    expect(reconciler.cursorCount()).toBeLessThanOrEqual(50);
    // The most recent task's cursor must still be present.
    expect(reconciler.getCursor('task', 'task-59')).toBe(1);
    // The oldest few must have been evicted.
    expect(reconciler.getCursor('task', 'task-0')).toBeUndefined();
  });

  test('onReplayed fires once per cycle with appliedCount + scope', async () => {
    const replays: Array<{ scope: string; scopeId: string; appliedCount: number; truncated: boolean }> = [];
    const reconciler = new ProcessStateReconciler({
      fetchTaskHistory: async () => ({ events: [], lastSeq: 0 }),
      fetchSessionHistory: async () => ({
        events: [makeEvent('t', 1, 'workflow:plan_ready', {}), makeEvent('t', 2, 'workflow:step_start', {})],
        nextCursor: undefined,
      }),
      applyEvent: () => {},
      onReplayed: ({ scope, scopeId, appliedCount, truncated }) => {
        replays.push({ scope, scopeId, appliedCount, truncated });
      },
    });

    await reconciler.reconcileSession('sess-x');
    expect(replays.length).toBe(1);
    expect(replays[0]).toMatchObject({
      scope: 'session',
      scopeId: 'sess-x',
      appliedCount: 2,
      truncated: false,
    });
  });

  test('fetchTimeoutMs caps a hung fetch and marks the cycle truncated', async () => {
    let onReplayed: { truncated: boolean; appliedCount: number } | undefined;
    const reconciler = new ProcessStateReconciler(
      {
        fetchTaskHistory: async () => ({ events: [], lastSeq: 0 }),
        fetchSessionHistory: () => new Promise(() => {}), // never resolves
        applyEvent: () => {},
        onReplayed: (info) => {
          onReplayed = info;
        },
      },
      { fetchTimeoutMs: 50 },
    );

    const applied = await reconciler.reconcileSession('sess-hung');
    // No events applied because the fetch timed out before returning.
    // The cycle terminates cleanly with truncated:true rather than
    // hanging the host.
    expect(applied).toBe(0);
    expect(onReplayed?.truncated).toBe(true);
  });

  test('a rejected fetch terminates the cycle without crashing', async () => {
    let onReplayed: { truncated: boolean } | undefined;
    const reconciler = new ProcessStateReconciler({
      fetchTaskHistory: async () => ({ events: [], lastSeq: 0 }),
      fetchSessionHistory: async () => {
        throw new Error('network down');
      },
      applyEvent: () => {},
      onReplayed: (info) => {
        onReplayed = info;
      },
    });

    // Without the runFetch wrapper, this would reject and surface as
    // an unhandled rejection in production. The reconciler maps it to
    // a clean truncated:true cycle so the host can retry on next call.
    await expect(reconciler.reconcileSession('sess-down')).resolves.toBe(0);
    expect(onReplayed?.truncated).toBe(true);
  });
});
