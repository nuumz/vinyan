import { describe, expect, it, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { AgentRuntimeStore } from '../../../src/db/agent-runtime-store.ts';
import { createBus, type VinyanBus } from '../../../src/core/bus.ts';
import {
  RuntimeStateManager,
  isTransitionAllowed,
  type RuntimeTransition,
} from '../../../src/orchestrator/ecosystem/runtime-state.ts';
import { migration031 } from '../../../src/db/migrations/031_add_agent_runtime.ts';

function makeDb(): Database {
  const db = new Database(':memory:');
  migration031.up(db);
  return db;
}

function captureEvents(bus: VinyanBus): RuntimeTransition[] {
  const seen: RuntimeTransition[] = [];
  bus.on('ecosystem:runtime_transition', (t) => seen.push(t));
  return seen;
}

describe('RuntimeState FSM rules', () => {
  it('allows dormant → awakening, awakening → standby, standby → working', () => {
    expect(isTransitionAllowed('dormant', 'awakening')).toBe(true);
    expect(isTransitionAllowed('awakening', 'standby')).toBe(true);
    expect(isTransitionAllowed('standby', 'working')).toBe(true);
  });

  it('allows working → standby (task done) and working → working (capacity)', () => {
    expect(isTransitionAllowed('working', 'standby')).toBe(true);
    expect(isTransitionAllowed('working', 'working')).toBe(true);
  });

  it('allows shutdown transitions to dormant', () => {
    expect(isTransitionAllowed('standby', 'dormant')).toBe(true);
    expect(isTransitionAllowed('awakening', 'dormant')).toBe(true);
    expect(isTransitionAllowed('working', 'dormant')).toBe(true);
  });

  it('rejects illegal transitions', () => {
    expect(isTransitionAllowed('dormant', 'standby')).toBe(false);
    expect(isTransitionAllowed('dormant', 'working')).toBe(false);
    expect(isTransitionAllowed('awakening', 'working')).toBe(false);
    expect(isTransitionAllowed('standby', 'awakening')).toBe(false);
  });
});

describe('RuntimeStateManager — happy path', () => {
  let db: Database;
  let store: AgentRuntimeStore;
  let bus: VinyanBus;
  let mgr: RuntimeStateManager;
  let events: RuntimeTransition[];

  beforeEach(() => {
    db = makeDb();
    store = new AgentRuntimeStore(db);
    bus = createBus();
    events = captureEvents(bus);
    mgr = new RuntimeStateManager({ store, bus });
  });

  it('register creates a dormant row when none exists', () => {
    const snap = mgr.register('worker-a');
    expect(snap.state).toBe('dormant');
    expect(snap.activeTaskCount).toBe(0);
    expect(snap.capacityMax).toBe(1);
  });

  it('register is idempotent — second call returns existing snapshot', () => {
    const first = mgr.register('worker-a', 3);
    const second = mgr.register('worker-a', 99);
    expect(second.capacityMax).toBe(first.capacityMax);
    expect(second.capacityMax).toBe(3); // not 99 — idempotent, does not overwrite
  });

  it('walks the normal lifecycle: dormant → awakening → standby → working → standby', () => {
    mgr.register('worker-a');
    mgr.awaken('worker-a', 'boot');
    mgr.markReady('worker-a');
    mgr.markWorking('worker-a', 'task-1');
    expect(mgr.get('worker-a')!.state).toBe('working');
    expect(mgr.get('worker-a')!.activeTaskCount).toBe(1);

    mgr.markTaskComplete('worker-a', 'task-1');
    expect(mgr.get('worker-a')!.state).toBe('standby');
    expect(mgr.get('worker-a')!.activeTaskCount).toBe(0);

    // Four transitions emitted (awaken, ready, working, complete)
    expect(events).toHaveLength(4);
    expect(events.map((e) => `${e.from}→${e.to}`)).toEqual([
      'dormant→awakening',
      'awakening→standby',
      'standby→working',
      'working→standby',
    ]);
  });

  it('supports multi-task capacity: working → working while not at cap', () => {
    mgr.register('worker-a', 3); // capacity 3
    mgr.awaken('worker-a');
    mgr.markReady('worker-a');
    mgr.markWorking('worker-a', 'task-1');
    mgr.markWorking('worker-a', 'task-2');
    mgr.markWorking('worker-a', 'task-3');
    expect(mgr.get('worker-a')!.activeTaskCount).toBe(3);
    expect(mgr.get('worker-a')!.state).toBe('working');

    // First completion keeps state=working (still 2 tasks in flight)
    mgr.markTaskComplete('worker-a', 'task-1');
    expect(mgr.get('worker-a')!.state).toBe('working');
    expect(mgr.get('worker-a')!.activeTaskCount).toBe(2);

    // Last completion flips to standby
    mgr.markTaskComplete('worker-a', 'task-2');
    mgr.markTaskComplete('worker-a', 'task-3');
    expect(mgr.get('worker-a')!.state).toBe('standby');
    expect(mgr.get('worker-a')!.activeTaskCount).toBe(0);
  });

  it('rejects markWorking when at capacity', () => {
    mgr.register('worker-a', 1);
    mgr.awaken('worker-a');
    mgr.markReady('worker-a');
    mgr.markWorking('worker-a', 'task-1');
    expect(() => mgr.markWorking('worker-a', 'task-2')).toThrow(/at capacity/);
  });

  it('rejects markTaskComplete when not working', () => {
    mgr.register('worker-a');
    mgr.awaken('worker-a');
    mgr.markReady('worker-a');
    expect(() => mgr.markTaskComplete('worker-a', 'task-1')).toThrow(/not working/);
  });

  it('rejects illegal transitions (dormant → working)', () => {
    mgr.register('worker-a');
    expect(() => mgr.markWorking('worker-a', 'task-1')).toThrow(/illegal transition/);
  });

  it('markDormant works from any state (shutdown escape hatch)', () => {
    mgr.register('worker-a');
    mgr.awaken('worker-a');
    mgr.markReady('worker-a');
    mgr.markWorking('worker-a', 'task-1');

    mgr.markDormant('worker-a', 'shutdown');
    const snap = mgr.get('worker-a')!;
    expect(snap.state).toBe('dormant');
    expect(snap.activeTaskCount).toBe(0); // delta -1 from working → floor 0
  });

  it('emits bus events with matching payloads', () => {
    mgr.register('worker-a');
    mgr.awaken('worker-a', 'boot');
    const ev = events[0]!;
    expect(ev.agentId).toBe('worker-a');
    expect(ev.from).toBe('dormant');
    expect(ev.to).toBe('awakening');
    expect(ev.reason).toBe('boot');
    expect(typeof ev.at).toBe('number');
  });

  it('throws when transitioning an unregistered agent', () => {
    expect(() => mgr.awaken('ghost')).toThrow(/not registered/);
  });
});

describe('RuntimeStateManager — list queries', () => {
  it('listByState returns only agents in the requested state', () => {
    const db = makeDb();
    const store = new AgentRuntimeStore(db);
    const mgr = new RuntimeStateManager({ store });

    mgr.register('a');
    mgr.register('b');
    mgr.register('c');
    mgr.awaken('a');
    mgr.awaken('b');
    mgr.markReady('b');

    const dormant = mgr.listByState('dormant').map((s) => s.agentId);
    const awakening = mgr.listByState('awakening').map((s) => s.agentId);
    const standby = mgr.listByState('standby').map((s) => s.agentId);

    expect(dormant).toEqual(['c']);
    expect(awakening).toEqual(['a']);
    expect(standby).toEqual(['b']);
  });
});

describe('RuntimeStateManager — crash recovery', () => {
  it('recovers working and awakening agents to standby on startup', () => {
    const db = makeDb();
    const store = new AgentRuntimeStore(db);
    const bus = createBus();
    const events = captureEvents(bus);
    const mgr = new RuntimeStateManager({ store, bus });

    // Simulate a pre-crash state: 2 workers in-flight, 1 warming up
    mgr.register('w1', 2);
    mgr.register('w2');
    mgr.register('w3');
    mgr.awaken('w1');
    mgr.markReady('w1');
    mgr.markWorking('w1', 't1');
    mgr.markWorking('w1', 't2');
    mgr.awaken('w2');
    mgr.markReady('w2');
    mgr.markWorking('w2', 't3');
    mgr.awaken('w3'); // still warming up

    const priorEventCount = events.length;
    const recovered = mgr.recoverFromCrash();

    expect(recovered).toHaveLength(3);
    expect(mgr.get('w1')!.state).toBe('standby');
    expect(mgr.get('w1')!.activeTaskCount).toBe(0);
    expect(mgr.get('w2')!.state).toBe('standby');
    expect(mgr.get('w2')!.activeTaskCount).toBe(0);
    expect(mgr.get('w3')!.state).toBe('standby');
    expect(mgr.get('w3')!.activeTaskCount).toBe(0);

    // Recovery emitted events with reason=crash-recovered
    const recoveryEvents = events.slice(priorEventCount);
    expect(recoveryEvents.every((e) => e.reason === 'crash-recovered')).toBe(true);
    expect(recoveryEvents.every((e) => e.to === 'standby')).toBe(true);
  });

  it('is a no-op when no agents are in working/awakening', () => {
    const db = makeDb();
    const store = new AgentRuntimeStore(db);
    const mgr = new RuntimeStateManager({ store });

    mgr.register('a');
    mgr.register('b');
    // Both dormant — nothing to recover

    const recovered = mgr.recoverFromCrash();
    expect(recovered).toHaveLength(0);
  });
});

describe('AgentRuntimeStore — audit log', () => {
  it('records one transition row per FSM move', () => {
    const db = makeDb();
    const store = new AgentRuntimeStore(db);
    const mgr = new RuntimeStateManager({ store });

    mgr.register('a');
    mgr.awaken('a');
    mgr.markReady('a');
    mgr.markWorking('a', 't1');
    mgr.markTaskComplete('a', 't1');

    expect(store.countTransitions('a')).toBe(4);
  });

  it('atomic commit — if row update succeeds, log row is also present', () => {
    const db = makeDb();
    const store = new AgentRuntimeStore(db);
    const mgr = new RuntimeStateManager({ store });

    mgr.register('a');
    mgr.awaken('a');

    // Both state and audit log must agree
    expect(mgr.get('a')!.state).toBe('awakening');
    expect(store.countTransitions('a')).toBe(1);
  });
});
