import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { TeamStore } from '../../../src/db/team-store.ts';
import { migration033 } from '../../../src/db/migrations/033_add_teams.ts';
import { TeamBlackboardFs } from '../../../src/orchestrator/ecosystem/team-blackboard-fs.ts';
import { TeamManager } from '../../../src/orchestrator/ecosystem/team.ts';

function makeDb(): Database {
  const db = new Database(':memory:');
  migration033.up(db);
  return db;
}

const fixtures: Array<{ workspace: string }> = [];

afterEach(() => {
  for (const f of fixtures) rmSync(f.workspace, { recursive: true, force: true });
  fixtures.length = 0;
});

function makeManager() {
  const workspace = mkdtempSync(join(tmpdir(), 'vinyan-team-test-'));
  fixtures.push({ workspace });
  const db = makeDb();
  const fs = new TeamBlackboardFs({ root: workspace });
  const store = new TeamStore(db, { fsBlackboard: fs });
  let counter = 0;
  const clock = { now: 1_000_000 };
  const mgr = new TeamManager({
    store,
    fsBlackboard: fs,
    now: () => clock.now,
    idFactory: () => `team-${++counter}`,
  });
  return { db, store, mgr, clock, workspace };
}

describe('TeamManager — roster', () => {
  it('creates a team with initial members', () => {
    const { mgr } = makeManager();
    const t = mgr.create({
      name: 'auth squad',
      departmentId: 'code',
      initialMembers: [{ engineId: 'e1', role: 'lead' }, { engineId: 'e2' }],
    });
    expect(t.teamId).toBe('team-1');
    expect(t.name).toBe('auth squad');
    expect(t.departmentId).toBe('code');
    expect(t.archivedAt).toBeNull();

    const members = mgr.members(t.teamId);
    expect(members.map((m) => m.engineId).sort()).toEqual(['e1', 'e2']);
    expect(members.find((m) => m.engineId === 'e1')!.role).toBe('lead');
  });

  it('addMember skips duplicates (idempotent)', () => {
    const { mgr } = makeManager();
    const t = mgr.create({ name: 'x' });
    mgr.addMember(t.teamId, 'e1');
    mgr.addMember(t.teamId, 'e1');
    expect(mgr.members(t.teamId)).toHaveLength(1);
  });

  it('removeMember sets left_at and drops from active list', () => {
    const { mgr } = makeManager();
    const t = mgr.create({ name: 'x', initialMembers: [{ engineId: 'e1' }, { engineId: 'e2' }] });
    expect(mgr.removeMember(t.teamId, 'e1')).toBe(true);
    expect(mgr.members(t.teamId).map((m) => m.engineId)).toEqual(['e2']);
  });

  it('archive hides team from listActive', () => {
    const { mgr } = makeManager();
    const a = mgr.create({ name: 'keeper' });
    const b = mgr.create({ name: 'temp' });
    mgr.archive(b.teamId);
    const active = mgr.listActive().map((t) => t.teamId);
    expect(active).toEqual([a.teamId]);
  });

  it('throws when adding a member to an unknown team', () => {
    const { mgr } = makeManager();
    expect(() => mgr.addMember('ghost', 'e1')).toThrow(/unknown team/);
  });
});

describe('TeamManager — persistent blackboard', () => {
  let mgr: TeamManager;
  let teamId: string;

  beforeEach(() => {
    const h = makeManager();
    mgr = h.mgr;
    const t = mgr.create({ name: 'auth' });
    teamId = t.teamId;
  });

  it('setState + getState round-trips JSON values', () => {
    mgr.setState(teamId, 'plan', { steps: ['a', 'b'], ready: true }, 'e1');
    const v = mgr.getState<{ steps: string[]; ready: boolean }>(teamId, 'plan');
    expect(v).toEqual({ steps: ['a', 'b'], ready: true });
  });

  it('setState returns monotonic versions', () => {
    const v1 = mgr.setState(teamId, 'plan', 1, 'e1');
    const v2 = mgr.setState(teamId, 'plan', 2, 'e2');
    const v3 = mgr.setState(teamId, 'plan', 3, 'e1');
    expect(v1).toBe(1);
    expect(v2).toBe(2);
    expect(v3).toBe(3);
  });

  it('getState returns the latest value, not an older version', () => {
    mgr.setState(teamId, 'plan', { v: 1 }, 'e1');
    mgr.setState(teamId, 'plan', { v: 2 }, 'e1');
    mgr.setState(teamId, 'plan', { v: 3 }, 'e1');
    expect(mgr.getState<{ v: number }>(teamId, 'plan')).toEqual({ v: 3 });
  });

  it('returns undefined for unknown keys', () => {
    expect(mgr.getState(teamId, 'ghost')).toBeUndefined();
  });

  it('listStateKeys returns every key that has ever been written', () => {
    mgr.setState(teamId, 'a', 1, 'e1');
    mgr.setState(teamId, 'b', 2, 'e1');
    mgr.setState(teamId, 'a', 3, 'e1'); // another version of 'a'
    expect(mgr.listStateKeys(teamId)).toEqual(['a', 'b']);
  });

  it('deleteState removes the key (one file per key on filesystem)', () => {
    mgr.setState(teamId, 'plan', 1, 'e1');
    mgr.setState(teamId, 'plan', 2, 'e1');
    const removed = mgr.deleteState(teamId, 'plan');
    expect(removed).toBeGreaterThanOrEqual(1);
    expect(mgr.getState(teamId, 'plan')).toBeUndefined();
  });

  it('throws when setting state on an unknown team', () => {
    expect(() => mgr.setState('ghost', 'k', 1, 'e1')).toThrow(/unknown team/);
  });
});

describe('TeamManager — persistence across restart', () => {
  it('blackboard survives when a new manager is instantiated on the same workspace', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'vinyan-team-restart-'));
    fixtures.push({ workspace });
    const db = makeDb();
    const fs1 = new TeamBlackboardFs({ root: workspace });
    const store1 = new TeamStore(db, { fsBlackboard: fs1 });
    const mgr1 = new TeamManager({
      store: store1,
      fsBlackboard: fs1,
      now: () => 1_000_000,
      idFactory: () => 'team-1',
    });
    const t = mgr1.create({ name: 'durable', initialMembers: [{ engineId: 'e1' }] });
    mgr1.setState(t.teamId, 'doc', { body: 'hello' }, 'e1');

    // Simulate restart — fresh store + manager on the same workspace + db
    const fs2 = new TeamBlackboardFs({ root: workspace });
    const store2 = new TeamStore(db, { fsBlackboard: fs2 });
    const mgr2 = new TeamManager({ store: store2, fsBlackboard: fs2, now: () => 2_000_000 });

    const again = mgr2.get(t.teamId);
    expect(again).not.toBeNull();
    expect(mgr2.getState<{ body: string }>(t.teamId, 'doc')).toEqual({ body: 'hello' });
    expect(mgr2.members(t.teamId).map((m) => m.engineId)).toEqual(['e1']);
  });
});
