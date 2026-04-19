import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { VolunteerStore } from '../../../src/db/volunteer-store.ts';
import { migration034 } from '../../../src/db/migrations/034_add_volunteer.ts';
import { createBus } from '../../../src/core/bus.ts';
import {
  VolunteerRegistry,
  scoreCandidate,
  selectVolunteer,
  type VolunteerCandidate,
  type VolunteerOffer,
} from '../../../src/orchestrator/ecosystem/volunteer-protocol.ts';
import { HelpfulnessTracker } from '../../../src/orchestrator/ecosystem/helpfulness-tracker.ts';

function makeDb(): Database {
  const db = new Database(':memory:');
  migration034.up(db);
  return db;
}

function offer(
  engineId: string,
  taskId = 't-1',
  offeredAt = 1_000,
): VolunteerOffer {
  return {
    offerId: `o-${engineId}`,
    engineId,
    taskId,
    offeredAt,
  };
}

function cand(
  engineId: string,
  ctx: { capability: number; trust: number; currentLoad: number },
  offeredAt = 1_000,
): VolunteerCandidate {
  return { offer: offer(engineId, 't-1', offeredAt), context: ctx };
}

// ── Pure selection rule ──────────────────────────────────────────────

describe('scoreCandidate', () => {
  it('is capability × trust × 1/(1+load)', () => {
    const s = scoreCandidate(cand('e1', { capability: 0.5, trust: 0.8, currentLoad: 0 }));
    expect(s).toBeCloseTo(0.5 * 0.8 * 1, 5);
  });

  it('penalises load: a loaded agent scores lower than an idle one', () => {
    const idle = scoreCandidate(cand('idle', { capability: 0.5, trust: 0.5, currentLoad: 0 }));
    const busy = scoreCandidate(cand('busy', { capability: 0.5, trust: 0.5, currentLoad: 3 }));
    expect(busy).toBeLessThan(idle);
  });

  it('floors capability and trust at 0.01 so cold-start agents can still win', () => {
    const s = scoreCandidate(cand('fresh', { capability: 0, trust: 0, currentLoad: 0 }));
    expect(s).toBeGreaterThan(0);
  });
});

describe('selectVolunteer', () => {
  it('returns the highest-scored candidate', () => {
    const v = selectVolunteer([
      cand('low', { capability: 0.3, trust: 0.3, currentLoad: 0 }),
      cand('high', { capability: 0.9, trust: 0.9, currentLoad: 0 }),
      cand('mid', { capability: 0.6, trust: 0.6, currentLoad: 0 }),
    ]);
    expect(v.winner?.engineId).toBe('high');
    expect(v.scores[0]!.offer.engineId).toBe('high');
  });

  it('breaks ties by earliest offer', () => {
    const v = selectVolunteer([
      cand('late', { capability: 0.5, trust: 0.5, currentLoad: 0 }, 2_000),
      cand('early', { capability: 0.5, trust: 0.5, currentLoad: 0 }, 1_000),
    ]);
    expect(v.winner?.engineId).toBe('early');
  });

  it('returns null when no candidates offered', () => {
    const v = selectVolunteer([]);
    expect(v.winner).toBeNull();
    expect(v.reason).toBe('no volunteers');
  });
});

// ── Registry integration ─────────────────────────────────────────────

describe('VolunteerRegistry', () => {
  it('declareOffer persists the offer and bumps offersMade', () => {
    const db = makeDb();
    const store = new VolunteerStore(db);
    let counter = 0;
    const reg = new VolunteerRegistry({
      store,
      now: () => 1_000,
      idFactory: () => `o-${++counter}`,
    });

    reg.declareOffer({ taskId: 't-1', engineId: 'e1' });
    reg.declareOffer({ taskId: 't-1', engineId: 'e2' });

    expect(reg.offersForTask('t-1')).toHaveLength(2);
    expect(store.getHelpfulness('e1')!.offersMade).toBe(1);
    expect(store.getHelpfulness('e2')!.offersMade).toBe(1);
  });

  it('finalize accepts the winner and declines others', () => {
    const db = makeDb();
    const store = new VolunteerStore(db);
    let counter = 0;
    const reg = new VolunteerRegistry({
      store,
      now: () => 1_000,
      idFactory: () => `o-${++counter}`,
    });
    const o1 = reg.declareOffer({ taskId: 't', engineId: 'e1' });
    const o2 = reg.declareOffer({ taskId: 't', engineId: 'e2' });

    const verdict = reg.finalize(
      't',
      [
        { offer: o1, context: { capability: 0.3, trust: 0.3, currentLoad: 0 } },
        { offer: o2, context: { capability: 0.9, trust: 0.9, currentLoad: 0 } },
      ],
      'c-1',
    );

    expect(verdict.winner?.engineId).toBe('e2');
    expect(store.getOffer(o2.offerId)!.acceptedAt).not.toBeNull();
    expect(store.getOffer(o2.offerId)!.commitmentId).toBe('c-1');
    expect(store.getOffer(o1.offerId)!.declinedReason).toBe('not-selected');
    expect(store.getHelpfulness('e2')!.offersAccepted).toBe(1);
  });

  it('emits ecosystem:volunteer_selected on success', () => {
    const db = makeDb();
    const store = new VolunteerStore(db);
    const bus = createBus();
    const events: unknown[] = [];
    bus.on('ecosystem:volunteer_selected', (p) => events.push(p));

    let counter = 0;
    const reg = new VolunteerRegistry({
      store,
      bus,
      now: () => 1_000,
      idFactory: () => `o-${++counter}`,
    });
    const o1 = reg.declareOffer({ taskId: 't', engineId: 'e1' });
    reg.finalize(
      't',
      [{ offer: o1, context: { capability: 0.5, trust: 0.5, currentLoad: 0 } }],
      'c-1',
    );

    expect(events).toHaveLength(1);
  });
});

// ── Helpfulness tracker ──────────────────────────────────────────────

describe('HelpfulnessTracker', () => {
  it('bumps deliveriesCompleted only when a volunteer commitment resolves as delivered', () => {
    const db = makeDb();
    const store = new VolunteerStore(db);
    const bus = createBus();

    // Register a volunteer offer + accepted → commitment
    let counter = 0;
    const reg = new VolunteerRegistry({
      store,
      bus,
      now: () => 1_000,
      idFactory: () => `o-${++counter}`,
    });
    const o = reg.declareOffer({ taskId: 't', engineId: 'e1' });
    reg.finalize(
      't',
      [{ offer: o, context: { capability: 0.5, trust: 0.5, currentLoad: 0 } }],
      'c-1',
    );

    const tracker = new HelpfulnessTracker({ store, bus, now: () => 2_000 });
    tracker.start();

    bus.emit('commitment:resolved', {
      commitmentId: 'c-1',
      engineId: 'e1',
      taskId: 't',
      kind: 'delivered',
      evidence: 'ok',
      resolvedAt: 2_000,
      latencyMs: 1_000,
    });

    expect(tracker.get('e1')!.deliveriesCompleted).toBe(1);
    tracker.stop();
  });

  it('does NOT count failed or transferred commitments', () => {
    const db = makeDb();
    const store = new VolunteerStore(db);
    const bus = createBus();
    let counter = 0;
    const reg = new VolunteerRegistry({
      store,
      bus,
      now: () => 1_000,
      idFactory: () => `o-${++counter}`,
    });
    for (const kind of ['failed', 'transferred'] as const) {
      const o = reg.declareOffer({ taskId: 't', engineId: 'e1' });
      reg.finalize(
        't',
        [{ offer: o, context: { capability: 0.5, trust: 0.5, currentLoad: 0 } }],
        `c-${kind}`,
      );
    }

    const tracker = new HelpfulnessTracker({ store, bus });
    tracker.start();

    for (const kind of ['failed', 'transferred'] as const) {
      bus.emit('commitment:resolved', {
        commitmentId: `c-${kind}`,
        engineId: 'e1',
        taskId: 't',
        kind,
        evidence: 'x',
        resolvedAt: 2_000,
        latencyMs: 1_000,
      });
    }

    expect(tracker.get('e1')!.deliveriesCompleted).toBe(0);
    tracker.stop();
  });

  it('does NOT count commitments that were not born from a volunteer offer', () => {
    const db = makeDb();
    const store = new VolunteerStore(db);
    const bus = createBus();
    const tracker = new HelpfulnessTracker({ store, bus });
    tracker.start();

    bus.emit('commitment:resolved', {
      commitmentId: 'c-from-auction',
      engineId: 'e1',
      taskId: 't',
      kind: 'delivered',
      evidence: 'ok',
      resolvedAt: 2_000,
      latencyMs: 1_000,
    });

    expect(tracker.get('e1')).toBeNull();
    tracker.stop();
  });

  it('stop() detaches the bus listener', () => {
    const db = makeDb();
    const store = new VolunteerStore(db);
    const bus = createBus();
    const tracker = new HelpfulnessTracker({ store, bus });

    tracker.start();
    tracker.stop();

    // Deliver a resolved event — should not mutate state
    bus.emit('commitment:resolved', {
      commitmentId: 'c',
      engineId: 'e1',
      taskId: 't',
      kind: 'delivered',
      evidence: 'ok',
      resolvedAt: 2_000,
      latencyMs: 1_000,
    });
    expect(tracker.get('e1')).toBeNull();
  });
});
