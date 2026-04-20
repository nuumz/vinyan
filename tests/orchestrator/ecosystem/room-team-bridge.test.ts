/**
 * Room ↔ Team blackboard bridge tests.
 *
 * We exercise the dispatcher's bridge logic directly on the
 * RoomBlackboard and TeamManager — running a full room round would
 * require agent-loop + fleet which is out of scope for a bridge unit
 * test. These tests cover: import at open, export on converged close,
 * no-export on non-converged status.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { TeamStore } from '../../../src/db/team-store.ts';
import { migration033 } from '../../../src/db/migrations/033_add_teams.ts';
import { TeamBlackboardFs } from '../../../src/orchestrator/ecosystem/team-blackboard-fs.ts';
import { TeamManager } from '../../../src/orchestrator/ecosystem/team.ts';
import { RoomBlackboard } from '../../../src/orchestrator/room/room-blackboard.ts';
import type { RoleSpec } from '../../../src/orchestrator/room/types.ts';

const fixtures: Array<{ workspace: string }> = [];

afterEach(() => {
  for (const f of fixtures) rmSync(f.workspace, { recursive: true, force: true });
  fixtures.length = 0;
});

function makeTeamManager() {
  const workspace = mkdtempSync(join(tmpdir(), 'vinyan-bridge-test-'));
  fixtures.push({ workspace });
  const db = new Database(':memory:');
  migration033.up(db);
  const fs = new TeamBlackboardFs({ root: workspace });
  const store = new TeamStore(db, { fsBlackboard: fs });
  const mgr = new TeamManager({ store, fsBlackboard: fs, now: () => 1_000 });
  return { mgr, store };
}

const WRITER_ROLE: RoleSpec = {
  name: 'writer',
  responsibility: 'writes plan',
  writableBlackboardKeys: ['plan', 'notes/*'],
  maxTurns: 3,
  canWriteFiles: false,
};

describe('Room-Team bridge — import', () => {
  it('seeds room blackboard from team blackboard with author-role=team-bridge', () => {
    const { mgr } = makeTeamManager();
    const team = mgr.create({ name: 'squad' });
    mgr.setState(team.teamId, 'plan', { v: 1, steps: ['a', 'b'] }, 'seed');

    const bb = new RoomBlackboard(() => 2_000);

    // Simulate the dispatcher import loop
    const baseline = new Map<string, number>();
    for (const key of ['plan']) {
      const value = mgr.getState(team.teamId, key);
      if (value !== undefined) {
        const entry = bb.systemSeed(key, value, 'team-bridge');
        baseline.set(key, entry.version);
      }
    }

    const planEntry = bb.read('plan')!;
    expect(planEntry.authorRole).toBe('team-bridge');
    expect(planEntry.value).toEqual({ v: 1, steps: ['a', 'b'] });
    expect(baseline.get('plan')).toBe(0);
  });

  it('leaves blackboard empty when team has no matching key', () => {
    const { mgr } = makeTeamManager();
    const team = mgr.create({ name: 'empty-team' });
    const bb = new RoomBlackboard(() => 2_000);

    const baseline = new Map<string, number>();
    const value = mgr.getState(team.teamId, 'missing');
    if (value !== undefined) {
      const e = bb.systemSeed('missing', value, 'team-bridge');
      baseline.set('missing', e.version);
    }

    expect(bb.size()).toBe(0);
    expect(baseline.size).toBe(0);
  });
});

describe('Room-Team bridge — export (converged only)', () => {
  it('writes changed shared keys back to the team blackboard', () => {
    const { mgr } = makeTeamManager();
    const team = mgr.create({ name: 'squad' });
    mgr.setState(team.teamId, 'plan', { v: 1 }, 'seed');

    const bb = new RoomBlackboard(() => 2_000);
    const baseline = new Map<string, number>();
    baseline.set('plan', bb.systemSeed('plan', { v: 1 }, 'team-bridge').version);

    // Simulate a participant writing an update
    bb.write('plan', { v: 2 }, WRITER_ROLE);

    // Simulate dispatcher export (converged path)
    const sharedKeys = new Set(['plan']);
    const changed = bb.entriesChangedSince(baseline);
    for (const entry of changed) {
      if (!sharedKeys.has(entry.key)) continue;
      mgr.setState(team.teamId, entry.key, entry.value, 'room:r-1');
    }

    expect(mgr.getState<{ v: number }>(team.teamId, 'plan')).toEqual({ v: 2 });
  });

  it('does NOT write back unchanged imported keys (same version as baseline)', () => {
    const { mgr } = makeTeamManager();
    const team = mgr.create({ name: 'squad' });
    mgr.setState(team.teamId, 'plan', { v: 1 }, 'seed');
    const versionBeforeRoom = mgr.getStateEntry(team.teamId, 'plan')!.version;

    const bb = new RoomBlackboard(() => 2_000);
    const baseline = new Map<string, number>();
    baseline.set('plan', bb.systemSeed('plan', { v: 1 }, 'team-bridge').version);

    // No participant writes happen

    const changed = bb.entriesChangedSince(baseline);
    const sharedKeys = new Set(['plan']);
    for (const entry of changed) {
      if (!sharedKeys.has(entry.key)) continue;
      mgr.setState(team.teamId, entry.key, entry.value, 'room:r-1');
    }

    const versionAfterRoom = mgr.getStateEntry(team.teamId, 'plan')!.version;
    expect(versionAfterRoom).toBe(versionBeforeRoom);
  });

  it('adds new keys created inside the room (not imported, but in shared list)', () => {
    const { mgr } = makeTeamManager();
    const team = mgr.create({ name: 'squad' });
    const bb = new RoomBlackboard(() => 2_000);
    const baseline = new Map<string, number>();

    // Participant creates a fresh key
    bb.write('notes/progress', 'half done', WRITER_ROLE);

    const sharedKeys = new Set(['notes/progress']);
    const changed = bb.entriesChangedSince(baseline);
    for (const entry of changed) {
      if (!sharedKeys.has(entry.key)) continue;
      mgr.setState(team.teamId, entry.key, entry.value, 'room:r-1');
    }

    expect(mgr.getState<string>(team.teamId, 'notes/progress')).toBe('half done');
  });

  it('does NOT write back keys outside the contract.teamSharedKeys list', () => {
    const { mgr } = makeTeamManager();
    const team = mgr.create({ name: 'squad' });
    const bb = new RoomBlackboard(() => 2_000);
    const baseline = new Map<string, number>();

    // Participant writes both shared + room-only keys
    bb.write('plan', { v: 2 }, WRITER_ROLE);
    bb.write('notes/scratch', 'don’t persist', WRITER_ROLE);

    const sharedKeys = new Set(['plan']); // only `plan` is exported
    const changed = bb.entriesChangedSince(baseline);
    for (const entry of changed) {
      if (!sharedKeys.has(entry.key)) continue;
      mgr.setState(team.teamId, entry.key, entry.value, 'room:r-1');
    }

    expect(mgr.getState<{ v: number }>(team.teamId, 'plan')).toEqual({ v: 2 });
    expect(mgr.getState(team.teamId, 'notes/scratch')).toBeUndefined();
  });
});

describe('Room-Team bridge — safety invariants', () => {
  it('dispatcher export path only runs on status=converged (simulated)', () => {
    const { mgr } = makeTeamManager();
    const team = mgr.create({ name: 'squad' });
    mgr.setState(team.teamId, 'plan', { v: 1 }, 'seed');

    const bb = new RoomBlackboard(() => 2_000);
    const baseline = new Map<string, number>();
    baseline.set('plan', bb.systemSeed('plan', { v: 1 }, 'team-bridge').version);

    // Simulate participant writing — then room closes with status != converged.
    bb.write('plan', { v: 99, dirty: true }, WRITER_ROLE);

    const status: string = 'failed';
    // Dispatcher gate: only run export on converged.
    if (status === 'converged') {
      const changed = bb.entriesChangedSince(baseline);
      for (const entry of changed) {
        mgr.setState(team.teamId, entry.key, entry.value, 'room:r-1');
      }
    }

    // Team blackboard should NOT reflect the dirty room write
    expect(mgr.getState<{ v: number }>(team.teamId, 'plan')).toEqual({ v: 1 });
  });

  it('two rounds: Room A converges and persists, Room B reads fresh state', () => {
    const { mgr } = makeTeamManager();
    const team = mgr.create({ name: 'long-running' });

    // Room A — converges, writes `plan` = {v: 2}
    {
      const bb = new RoomBlackboard(() => 2_000);
      const baseline = new Map<string, number>();
      // No prior state to import
      bb.write('plan', { v: 2, author: 'A' }, WRITER_ROLE);
      const changed = bb.entriesChangedSince(baseline);
      for (const e of changed) mgr.setState(team.teamId, e.key, e.value, 'room:A');
    }

    // Room B — opens, imports `plan`, reads it
    {
      const bb = new RoomBlackboard(() => 3_000);
      const imported = mgr.getState<{ v: number; author: string }>(team.teamId, 'plan');
      expect(imported).toEqual({ v: 2, author: 'A' });
      if (imported !== undefined) bb.systemSeed('plan', imported, 'team-bridge');
      expect(bb.read('plan')!.value).toEqual({ v: 2, author: 'A' });
    }
  });
});
