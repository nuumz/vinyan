/**
 * AgentProfileStore tests — workspace singleton identity.
 *
 * Verifies:
 *   - loadOrCreate() is idempotent (one row per workspace)
 *   - Singleton CHECK constraint (`id = 'local'`) rejects other IDs
 *   - updatePreferences merges partial + bumps updated_at
 *   - updateCapabilities replaces + dedupes
 *   - summarize() aggregates from deps and caches 60s
 *   - Zod boundary: corrupt row falls back gracefully
 */
import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'bun:test';
import { AgentProfileStore } from '../../src/db/agent-profile-store.ts';
import { ALL_MIGRATIONS, MigrationRunner } from '../../src/db/migrations/index.ts';

const BOOTSTRAP = {
  instanceId: 'uuid-test-1234',
  workspace: '/tmp/agent-profile-test',
};

describe('AgentProfileStore', () => {
  let db: Database;
  let store: AgentProfileStore;

  beforeEach(() => {
    db = new Database(':memory:');
    const runner = new MigrationRunner();
    runner.migrate(db, ALL_MIGRATIONS);
    store = new AgentProfileStore(db);
  });

  test('get() returns null before bootstrap', () => {
    expect(store.get()).toBeNull();
  });

  test('loadOrCreate() inserts default row on first call', () => {
    const profile = store.loadOrCreate(BOOTSTRAP);
    expect(profile.id).toBe('local');
    expect(profile.instanceId).toBe(BOOTSTRAP.instanceId);
    expect(profile.displayName).toBe('vinyan');
    expect(profile.workspacePath).toBe(BOOTSTRAP.workspace);
    expect(profile.preferences.approvalMode).toBe('interactive');
    expect(profile.capabilities).toEqual([]);
  });

  test('loadOrCreate() is idempotent (preserves created_at)', () => {
    const first = store.loadOrCreate(BOOTSTRAP);
    // Second call should NOT create a new row or change timestamps
    const second = store.loadOrCreate(BOOTSTRAP);
    expect(second.createdAt).toBe(first.createdAt);
    expect(second.id).toBe('local');

    const rows = db.prepare(`SELECT COUNT(*) AS c FROM agent_profile`).get() as { c: number };
    expect(rows.c).toBe(1);
  });

  test('displayNameOverride applied on first bootstrap', () => {
    const profile = store.loadOrCreate({ ...BOOTSTRAP, displayNameOverride: 'project-alpha' });
    expect(profile.displayName).toBe('project-alpha');
  });

  test('singleton: inserting id != local throws', () => {
    store.loadOrCreate(BOOTSTRAP);
    expect(() => {
      db.prepare(
        `INSERT INTO agent_profile
         (id, instance_id, display_name, workspace_path, created_at, updated_at)
         VALUES ('other', 'uuid', 'other-agent', '/tmp/x', ?, ?)`,
      ).run(Date.now(), Date.now());
    }).toThrow();
  });

  test('updatePreferences merges partial + bumps updated_at', async () => {
    const initial = store.loadOrCreate(BOOTSTRAP);
    await new Promise((r) => setTimeout(r, 5)); // ensure clock tick

    store.updatePreferences({ language: 'th', verbosity: 'verbose' });
    const after = store.get()!;

    expect(after.preferences.language).toBe('th');
    expect(after.preferences.verbosity).toBe('verbose');
    // Unchanged fields preserved
    expect(after.preferences.approvalMode).toBe('interactive');
    expect(after.preferences.defaultThinkingLevel).toBe('medium');
    expect(after.updatedAt).toBeGreaterThan(initial.updatedAt);
  });

  test('updateCapabilities replaces + dedupes + sorts', () => {
    store.loadOrCreate(BOOTSTRAP);
    store.updateCapabilities(['ast', 'type', 'ast', 'lint']);
    const profile = store.get()!;
    expect(profile.capabilities).toEqual(['ast', 'lint', 'type']);
  });

  test('updateVinyanMdLink persists path + hash', () => {
    store.loadOrCreate(BOOTSTRAP);
    store.updateVinyanMdLink('/tmp/vinyan/VINYAN.md', 'sha256:abc123');
    const profile = store.get()!;
    expect(profile.vinyanMdPath).toBe('/tmp/vinyan/VINYAN.md');
    expect(profile.vinyanMdHash).toBe('sha256:abc123');
  });

  test('summarize() returns zeros when no stores provided', () => {
    store.loadOrCreate(BOOTSTRAP);
    const summary = store.summarize({});
    expect(summary.totalTasks).toBe(0);
    expect(summary.activeSkills).toBe(0);
    expect(summary.activeWorkers).toBe(0);
    expect(summary.sleepCyclesRun).toBe(0);
  });

  test('summarize() reads from store deps', () => {
    store.loadOrCreate(BOOTSTRAP);
    const fakeStores = {
      traceStore: {
        count: () => 42,
        countDistinctTaskTypes: () => 5,
        findRecent: (limit: number) => [
          { outcome: 'success' as const, timestamp: 1000 },
          { outcome: 'success' as const, timestamp: 2000 },
          { outcome: 'failure' as const, timestamp: 1500 },
        ].slice(0, limit),
      },
      skillStore: { countActive: () => 3 },
      workerStore: { countActive: () => 2 },
      patternStore: { countCycleRuns: () => 7 },
    };

    const summary = store.summarize(fakeStores);
    expect(summary.totalTasks).toBe(42);
    expect(summary.distinctTaskTypes).toBe(5);
    expect(summary.activeSkills).toBe(3);
    expect(summary.activeWorkers).toBe(2);
    expect(summary.sleepCyclesRun).toBe(7);
    expect(summary.successRate).toBeCloseTo(2 / 3, 2);
    expect(summary.lastActiveAt).toBe(2000);
  });

  test('summarize() caches result for 60s', () => {
    store.loadOrCreate(BOOTSTRAP);
    let calls = 0;
    const deps = {
      traceStore: {
        count: () => {
          calls++;
          return 1;
        },
        countDistinctTaskTypes: () => 1,
      },
    };

    store.summarize(deps);
    store.summarize(deps);
    store.summarize(deps);

    // Only 1 underlying call — subsequent are cache hits
    expect(calls).toBe(1);

    store.invalidateCache();
    store.summarize(deps);
    expect(calls).toBe(2);
  });

  test('rowToProfile falls back gracefully on corrupt preferences', () => {
    // Insert bootstrap then corrupt the JSON column
    store.loadOrCreate(BOOTSTRAP);
    db.prepare(`UPDATE agent_profile SET preferences_json = '{{invalid json' WHERE id = 'local'`).run();

    // Should not throw — should use defaults for preferences
    const profile = store.get();
    expect(profile).not.toBeNull();
    expect(profile!.id).toBe('local');
    // Preferences default when JSON was malformed
    expect(profile!.preferences.approvalMode).toBe('interactive');
  });
});
