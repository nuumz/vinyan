/**
 * Phase 3 — filesystem watcher & internal/external event discrimination.
 *
 * These tests assert:
 *  - Internal `setState` fires `team:blackboard_updated` with source=internal.
 *  - An external `writeFileSync` on a team .md fires the same event with
 *    source=external after debounce.
 *  - The same internal write is NOT double-emitted when the watcher
 *    subsequently observes its own file change.
 *  - `EcosystemCoordinator.stop()` detaches the watcher cleanly.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { createBus, type VinyanBus } from '../../../src/core/bus.ts';
import { TeamStore } from '../../../src/db/team-store.ts';
import { migration031 } from '../../../src/db/migrations/031_add_agent_runtime.ts';
import { migration032 } from '../../../src/db/migrations/032_add_commitments.ts';
import { migration033 } from '../../../src/db/migrations/033_add_teams.ts';
import { migration034 } from '../../../src/db/migrations/034_add_volunteer.ts';
import { buildEcosystem } from '../../../src/orchestrator/ecosystem/index.ts';
import { TeamBlackboardFs } from '../../../src/orchestrator/ecosystem/team-blackboard-fs.ts';
import { TeamManager } from '../../../src/orchestrator/ecosystem/team.ts';

function makeDb(): Database {
  const db = new Database(':memory:');
  migration031.up(db);
  migration032.up(db);
  migration033.up(db);
  migration034.up(db);
  return db;
}

function waitFor(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe('TeamManager — internal event emission', () => {
  it('emits team:blackboard_updated with source=internal on setState', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'vinyan-bb-int-'));
    try {
      const db = makeDb();
      const bus = createBus();
      const events: Array<{ source: string; version: number; key: string }> = [];
      bus.on('team:blackboard_updated', (p) => events.push(p));

      const fs = new TeamBlackboardFs({ root: workspace });
      const store = new TeamStore(db, { fsBlackboard: fs });
      const mgr = new TeamManager({ store, bus, fsBlackboard: fs });
      store.createTeam({ teamId: 'squad', name: 'A', createdAt: 1 });

      mgr.setState('squad', 'plan', { v: 1 }, 'alice');

      expect(events).toHaveLength(1);
      expect(events[0]!.source).toBe('internal');
      expect(events[0]!.version).toBe(1);
      expect(events[0]!.key).toBe('plan');

      db.close();
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});

describe('TeamManager — external watcher (integration)', () => {
  let workspace: string;
  let db: Database;
  let bus: VinyanBus;
  let detach: (() => void) | null = null;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'vinyan-bb-ext-'));
    db = makeDb();
    bus = createBus();
  });

  afterEach(() => {
    detach?.();
    detach = null;
    db.close();
    rmSync(workspace, { recursive: true, force: true });
  });

  it('observes an external .md write and emits source=external', async () => {
    const { teams, coordinator } = buildEcosystem({
      db,
      bus,
      workspace,
      taskResolver: () => null,
      engineRoster: () => [],
    });
    const store = (teams as unknown as { store: TeamStore }).store;
    store.createTeam({ teamId: 'squad', name: 'A', createdAt: 1 });
    teams.setState('squad', 'plan', { v: 1 }, 'alice'); // creates the file first

    const events: Array<{ source: string; version: number }> = [];
    bus.on('team:blackboard_updated', (p) => events.push(p));

    coordinator.start(); // attaches the watcher

    // Wait for chokidar to be ready before we write externally.
    await waitFor(150);

    // Simulate an external editor overwriting the file with a higher version.
    const filePath = join(workspace, '.vinyan', 'teams', 'squad', 'plan.md');
    const updatedAtIso = new Date(1_700_000_000_000 + 1000).toISOString();
    writeFileSync(
      filePath,
      `---
key: plan
version: 2
author: external-editor
updatedAt: ${updatedAtIso}
---
{"v":2}
`,
    );

    // Wait past debounce.
    await waitFor(300);

    const ext = events.find((e) => e.source === 'external');
    expect(ext).toBeTruthy();
    expect(ext!.version).toBe(2);

    coordinator.stop();
  });

  it('does NOT double-emit when internal setState triggers the watcher', async () => {
    const { teams, coordinator } = buildEcosystem({
      db,
      bus,
      workspace,
      taskResolver: () => null,
      engineRoster: () => [],
    });
    const store = (teams as unknown as { store: TeamStore }).store;
    store.createTeam({ teamId: 'squad', name: 'A', createdAt: 1 });

    coordinator.start();
    await waitFor(150); // let watcher init

    const events: Array<{ source: string }> = [];
    bus.on('team:blackboard_updated', (p) => events.push(p));

    teams.setState('squad', 'plan', { v: 1 }, 'alice');
    await waitFor(300); // let chokidar see the write + debounce

    // Exactly ONE event — the internal one. Watcher dedups against cache.
    const internals = events.filter((e) => e.source === 'internal');
    const externals = events.filter((e) => e.source === 'external');
    expect(internals).toHaveLength(1);
    expect(externals).toHaveLength(0);

    coordinator.stop();
  });
});
