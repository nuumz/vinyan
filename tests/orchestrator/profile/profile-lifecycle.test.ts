/**
 * ProfileLifecycle tests — the generic FSM without depending on any concrete
 * gate implementation. Uses a tiny in-memory ProfileStore + stub gates so we
 * exercise transitions, I8, demotionCount cap, cooldown, and emergency paths.
 */

import { describe, expect, test } from 'bun:test';
import {
  type AgentProfileBase,
  type AgentProfileStatus,
  type ProfileStore,
} from '../../../src/orchestrator/profile/agent-profile.ts';
import {
  type LifecycleGates,
  ProfileLifecycle,
} from '../../../src/orchestrator/profile/profile-lifecycle.ts';

interface TestProfile extends AgentProfileBase {
  // carries nothing extra — pure FSM under test
}

class InMemoryStore implements ProfileStore<TestProfile> {
  readonly map = new Map<string, TestProfile>();
  add(p: TestProfile) {
    this.map.set(p.id, { ...p });
  }
  findById(id: string) {
    return this.map.get(id) ?? null;
  }
  findByStatus(status: AgentProfileStatus) {
    return [...this.map.values()].filter((p) => p.status === status);
  }
  findActive() {
    return this.findByStatus('active');
  }
  updateStatus(id: string, status: AgentProfileStatus, reason?: string) {
    const p = this.map.get(id);
    if (!p) return;
    if (status === 'demoted') {
      p.demotionCount += 1;
      p.demotedAt = Date.now();
      p.demotionReason = reason;
    }
    if (status === 'active' && p.status === 'probation') {
      p.promotedAt = Date.now();
    }
    p.status = status;
  }
  reEnroll(id: string) {
    const p = this.map.get(id);
    if (!p) return;
    p.status = 'probation';
    p.demotedAt = undefined;
    p.demotionReason = undefined;
  }
}

function mkProfile(id: string, status: AgentProfileStatus, demotionCount = 0): TestProfile {
  return {
    id,
    status,
    createdAt: 0,
    demotionCount,
  };
}

describe('ProfileLifecycle — promotion', () => {
  test('promotes a probation profile when gate returns promote=true', () => {
    const store = new InMemoryStore();
    store.add(mkProfile('p1', 'probation'));
    const gates: LifecycleGates<TestProfile> = {
      shouldPromote: () => ({ promote: true, reason: 'ok' }),
      shouldDemote: () => ({ demote: false, reason: '' }),
    };
    const life = new ProfileLifecycle<TestProfile>({ kind: 'worker', store, gates });
    const verdict = life.evaluatePromotion('p1');
    expect(verdict.promote).toBe(true);
    expect(store.findById('p1')?.status).toBe('active');
  });

  test('skips when profile is not on probation', () => {
    const store = new InMemoryStore();
    store.add(mkProfile('p1', 'active'));
    const gates: LifecycleGates<TestProfile> = {
      shouldPromote: () => ({ promote: true, reason: 'ok' }),
      shouldDemote: () => ({ demote: false, reason: '' }),
    };
    const life = new ProfileLifecycle<TestProfile>({ kind: 'worker', store, gates });
    expect(life.evaluatePromotion('p1').promote).toBe(false);
  });
});

describe('ProfileLifecycle — demotion', () => {
  test('demotes failing actives but respects I8 floor', () => {
    const store = new InMemoryStore();
    store.add(mkProfile('a1', 'active'));
    store.add(mkProfile('a2', 'active'));
    const gates: LifecycleGates<TestProfile> = {
      shouldPromote: () => ({ promote: false, reason: '' }),
      shouldDemote: () => ({ demote: true, reason: 'bad' }),
    };
    const life = new ProfileLifecycle<TestProfile>({ kind: 'worker', store, gates });
    const t = life.checkDemotions();
    // I8: with 2 active + both trip, only 1 should be demoted (floor of 1)
    expect(t.length).toBe(1);
    expect(store.findActive().length).toBe(1);
  });

  test('demotionCount cap promotes to retired', () => {
    const store = new InMemoryStore();
    store.add(mkProfile('a1', 'active', 2)); // 3rd demotion should retire
    store.add(mkProfile('a2', 'active'));
    const gates: LifecycleGates<TestProfile> = {
      shouldPromote: () => ({ promote: false, reason: '' }),
      shouldDemote: (p) => ({ demote: p.id === 'a1', reason: 'bad' }),
    };
    const life = new ProfileLifecycle<TestProfile>({
      kind: 'worker',
      store,
      gates,
      maxDemotions: 3,
    });
    const t = life.checkDemotions();
    expect(t).toHaveLength(1);
    expect(t[0]!.permanent).toBe(true);
    expect(store.findById('a1')?.status).toBe('retired');
  });
});

describe('ProfileLifecycle — re-enrollment', () => {
  test('skips demoted profile until cooldown elapses', () => {
    const store = new InMemoryStore();
    const now = Date.now();
    store.add({ ...mkProfile('d1', 'demoted', 1), demotedAt: now - 1000 });
    const gates: LifecycleGates<TestProfile> = {
      shouldPromote: () => ({ promote: false, reason: '' }),
      shouldDemote: () => ({ demote: false, reason: '' }),
    };
    const life = new ProfileLifecycle<TestProfile>({
      kind: 'worker',
      store,
      gates,
      reentryCooldownMs: 5000,
    });
    const reactivated = life.reEnrollExpired(now);
    expect(reactivated).toHaveLength(0);
    // Fast-forward past cooldown
    const reactivatedLater = life.reEnrollExpired(now + 10_000);
    expect(reactivatedLater).toEqual(['d1']);
    expect(store.findById('d1')?.status).toBe('probation');
  });

  test('retires profile that hit demotionCount cap', () => {
    const store = new InMemoryStore();
    store.add({ ...mkProfile('d1', 'demoted', 3), demotedAt: 0 });
    const gates: LifecycleGates<TestProfile> = {
      shouldPromote: () => ({ promote: false, reason: '' }),
      shouldDemote: () => ({ demote: false, reason: '' }),
    };
    const life = new ProfileLifecycle<TestProfile>({ kind: 'worker', store, gates, maxDemotions: 3 });
    life.reEnrollExpired();
    expect(store.findById('d1')?.status).toBe('retired');
  });
});

describe('ProfileLifecycle — emergency reactivation', () => {
  test('recovers when no actives remain', () => {
    const store = new InMemoryStore();
    store.add(mkProfile('d1', 'demoted', 1));
    const gates: LifecycleGates<TestProfile> = {
      shouldPromote: () => ({ promote: false, reason: '' }),
      shouldDemote: () => ({ demote: false, reason: '' }),
    };
    const life = new ProfileLifecycle<TestProfile>({ kind: 'worker', store, gates });
    const id = life.emergencyReactivation();
    expect(id).toBe('d1');
    expect(store.findById('d1')?.status).toBe('active');
  });

  test('no-op when actives exist', () => {
    const store = new InMemoryStore();
    store.add(mkProfile('a1', 'active'));
    store.add(mkProfile('d1', 'demoted'));
    const gates: LifecycleGates<TestProfile> = {
      shouldPromote: () => ({ promote: false, reason: '' }),
      shouldDemote: () => ({ demote: false, reason: '' }),
    };
    const life = new ProfileLifecycle<TestProfile>({ kind: 'worker', store, gates });
    expect(life.emergencyReactivation()).toBeNull();
  });
});
