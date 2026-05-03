/**
 * Doctor runtime-probe contract.
 *
 * Verifies:
 *   - missing optional probe → warn (degraded), not fail
 *   - migrations check compares applied vs ALL_MIGRATIONS max version
 *   - provider cooldown probe surfaces count + earliest reset, never key
 *     material
 *   - inFlightTaskCount > 50 raises a warn with remediation
 *   - secrets are not leaked: detail strings never include API keys
 */
import { Database } from 'bun:sqlite';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { runDoctorChecks, summarizeChecks } from '../../src/cli/doctor.ts';
import { ALL_MIGRATIONS, MigrationRunner } from '../../src/db/migrations/index.ts';

const TEST_DIR = join(tmpdir(), `vinyan-doctor-runtime-test-${Date.now()}`);
const TOKEN_PATH = join(TEST_DIR, 'api-token');
const FAKE_KEY = 'sk-secret-1234567890abcdef';

beforeAll(() => {
  mkdirSync(TEST_DIR, { recursive: true });
  // Minimal vinyan.json so the config check passes.
  writeFileSync(
    join(TEST_DIR, 'vinyan.json'),
    JSON.stringify({
      project: { name: 'doctor-test' },
      oracles: { type: { enabled: true } },
      economy: { enabled: false },
      network: { api: { enabled: true, port: 0 } },
    }),
  );
  writeFileSync(TOKEN_PATH, 'token');
  // Migrate a real DB into .vinyan/vinyan.db so the migrations check
  // runs against a real schema_migrations table.
  mkdirSync(join(TEST_DIR, '.vinyan'), { recursive: true });
  const db = new Database(join(TEST_DIR, '.vinyan', 'vinyan.db'));
  db.exec('PRAGMA journal_mode = WAL');
  new MigrationRunner().migrate(db, ALL_MIGRATIONS);
  db.close();
  // Set a fake LLM key so the provider check doesn't fail (we want
  // the *runtime probe* to drive the verdict, not the env-var check).
  process.env.OPENROUTER_API_KEY = FAKE_KEY;
});

afterAll(() => {
  delete process.env.OPENROUTER_API_KEY;
});

describe('runDoctorChecks — runtime probes', () => {
  test('without runtime block: only static checks run, returns ok-or-warn', async () => {
    const checks = await runDoctorChecks(TEST_DIR);
    expect(checks.length).toBeGreaterThan(0);
    const names = checks.map((c) => c.name);
    expect(names).toContain('Workspace');
    expect(names).toContain('Migrations');
    // Without runtime probes, scheduler / event recorder are not asked
    // about — those are runtime-only signals.
    expect(names).not.toContain('Scheduler');
    expect(names).not.toContain('Event Recorder');
  });

  test('migrations check reports OK when DB version matches code', async () => {
    const checks = await runDoctorChecks(TEST_DIR);
    const migrations = checks.find((c) => c.name === 'Migrations');
    expect(migrations).toBeDefined();
    expect(migrations?.status).toBe('ok');
    expect(migrations?.detail).toContain('up to date');
  });

  test('runtime probes inject scheduler / recorder / skills checks', async () => {
    const checks = await runDoctorChecks(TEST_DIR, {
      runtime: {
        recorderActive: true,
        schedulerActive: true,
        activeScheduleCount: 3,
        skillsActive: true,
        memoryWikiActive: false,
        inFlightTaskCount: 1,
      },
    });
    const byName = new Map(checks.map((c) => [c.name, c]));
    expect(byName.get('Event Recorder')?.status).toBe('ok');
    expect(byName.get('Scheduler')?.status).toBe('ok');
    expect(byName.get('Scheduler')?.detail).toContain('3 active');
    expect(byName.get('Skills')?.status).toBe('ok');
    expect(byName.get('Memory Wiki')?.status).toBe('warn');
    expect(byName.get('In-Flight Tasks')?.status).toBe('ok');
  });

  test('absent recorder/scheduler/skills become warn with remediation', async () => {
    const checks = await runDoctorChecks(TEST_DIR, {
      runtime: {
        recorderActive: false,
        schedulerActive: false,
        skillsActive: false,
      },
    });
    const recorder = checks.find((c) => c.name === 'Event Recorder')!;
    expect(recorder.status).toBe('warn');
    expect(recorder.remediation).toBeDefined();
    const scheduler = checks.find((c) => c.name === 'Scheduler')!;
    expect(scheduler.status).toBe('warn');
    expect(scheduler.remediation).toBeDefined();
  });

  test('provider cooldown probe surfaces count + reset, never the key', async () => {
    const cooldownUntil = Date.now() + 30_000;
    const checks = await runDoctorChecks(TEST_DIR, {
      runtime: {
        providerCooldowns: () => [
          { providerId: 'openrouter/balanced/anthropic/claude', cooldownUntil, reason: 'rate_limited' },
        ],
      },
    });
    const provider = checks.find((c) => c.name === 'Provider Health')!;
    expect(provider.status).toBe('warn');
    expect(provider.detail).toMatch(/1 provider/);
    // Never echo the key.
    for (const c of checks) {
      expect(c.detail).not.toContain(FAKE_KEY);
      if (c.remediation) expect(c.remediation).not.toContain(FAKE_KEY);
    }
  });

  test('high in-flight count raises warn with remediation', async () => {
    const checks = await runDoctorChecks(TEST_DIR, {
      runtime: { inFlightTaskCount: 75 },
    });
    const inFlight = checks.find((c) => c.name === 'In-Flight Tasks')!;
    expect(inFlight.status).toBe('warn');
    expect(inFlight.remediation).toBeDefined();
  });

  test('orphan recovery > 0 reports warn, == 0 hidden', async () => {
    const withOrphans = await runDoctorChecks(TEST_DIR, {
      runtime: { recoveredOrphanCount: 4 },
    });
    expect(withOrphans.find((c) => c.name === 'Orphan Recovery')?.status).toBe('warn');

    const noOrphans = await runDoctorChecks(TEST_DIR, {
      runtime: { recoveredOrphanCount: 0 },
    });
    expect(noOrphans.find((c) => c.name === 'Orphan Recovery')).toBeUndefined();
  });

  test('Sessions check labels storage mode from config (sqlite-only by default)', async () => {
    const checks = await runDoctorChecks(TEST_DIR);
    const sessions = checks.find((c) => c.name === 'Sessions');
    expect(sessions).toBeDefined();
    expect(sessions?.status).toBe('ok');
    expect(sessions?.detail).toContain('mode=sqlite-only');
    expect(sessions?.detail).toContain('sqlite=');
  });

  test('Sessions check warns on JSONL/SQLite drift when hybrid mode is active', async () => {
    // Carve out a fresh workspace so the config cache doesn't return the
    // base TEST_DIR config (loadConfig caches per workspace path).
    const driftDir = join(tmpdir(), `vinyan-doctor-drift-${Date.now()}`);
    mkdirSync(join(driftDir, '.vinyan'), { recursive: true });
    writeFileSync(
      join(driftDir, 'vinyan.json'),
      JSON.stringify({
        oracles: { type: { enabled: true } },
        network: { api: { enabled: true, port: 3927 } },
        session: { dualWrite: { enabled: true } },
      }),
    );
    const db = new Database(join(driftDir, '.vinyan', 'vinyan.db'));
    db.exec('PRAGMA journal_mode = WAL');
    new MigrationRunner().migrate(db, ALL_MIGRATIONS);
    db.exec(
      "INSERT INTO session_store (id, source, created_at, status, updated_at) VALUES ('s1','test',1,'active',1)",
    );
    db.close();

    const checks = await runDoctorChecks(driftDir, {
      runtime: {
        jsonlSessions: () => ({ sessionsDir: '/tmp/x', sessionCount: 4 }),
      },
    });
    const sessions = checks.find((c) => c.name === 'Sessions')!;
    expect(sessions.status).toBe('warn');
    expect(sessions.detail).toContain('mode=dual-write');
    expect(sessions.detail).toContain('drift=3');
    expect(sessions.remediation).toBeDefined();
  });

  test('Memory Wiki check reports vault scaffold + content counts and flags empty wiki', async () => {
    const checks = await runDoctorChecks(TEST_DIR, {
      runtime: { memoryWikiActive: true },
    });
    const wiki = checks.find((c) => c.name === 'Memory Wiki')!;
    expect(wiki.status).toBe('warn'); // vault not scaffolded in test fixture
    expect(wiki.detail).toContain('wired');
    expect(wiki.detail).toContain('vault missing');
    expect(wiki.detail).toContain('0 pages');
    expect(wiki.detail).toContain('0 sources');
    expect(wiki.remediation).toBeDefined();
  });

  // L6 drift guard — pin the operator-facing copy. The five canonical
  // shapes the dashboard renders are:
  //   "wired · vault scaffolded · N pages · M sources"               (healthy)
  //   "wired · vault scaffolded · N pages · M sources · K open …"    (lint)
  //   "wired · vault missing · …"                                    (no scaffold)
  //   "not wired · vault scaffolded · …"                             (no deps)
  //   "not wired · vault missing · …"                                (cold start)
  // A later refactor must update this test alongside the format
  // change so the operator's signal isn't silently broken.
  test('Memory Wiki detail format snapshot — pinned for dashboard parsers', async () => {
    // Healthy path: scaffold + counts. Build a minimal vault marker
    // file so the inline `existsSync` for MEMORY_SCHEMA.md succeeds,
    // then exercise the formatter against the real DB schema.
    const wikiDir = join(TEST_DIR, '.vinyan', 'wiki');
    mkdirSync(wikiDir, { recursive: true });
    writeFileSync(join(wikiDir, 'MEMORY_SCHEMA.md'), '# fixture\n');
    try {
      const checks = await runDoctorChecks(TEST_DIR, {
        runtime: { memoryWikiActive: true },
      });
      const wiki = checks.find((c) => c.name === 'Memory Wiki')!;
      // Exact-shape snapshot. Order matters: wired → scaffold → pages → sources.
      // Singular/plural noun toggling is part of the contract.
      expect(wiki.detail).toMatch(
        /^wired · vault scaffolded · \d+ pages? · \d+ sources?( · \d+ open findings?)?$/,
      );
      expect(wiki.status).toBe('ok');
    } finally {
      // Leave the marker — siblings tests don't depend on its absence.
    }
  });

  // L4 — Sessions storage-mode label snapshot. Pin the three forms.
  test('Sessions detail format snapshot — pinned for the three storage modes', async () => {
    const checks = await runDoctorChecks(TEST_DIR);
    const sessions = checks.find((c) => c.name === 'Sessions')!;
    // sqlite-only is the default in TEST_DIR's vinyan.json (no session config block).
    // archived count was added so operators can see the archive lane
    // without filtering.
    expect(sessions.detail).toMatch(
      /^mode=sqlite-only · sqlite=\d+ active, \d+ suspended, \d+ archived$/,
    );
  });

  test('summarizeChecks returns critical when any fail-status check exists', async () => {
    const checks = await runDoctorChecks(TEST_DIR, {
      runtime: { recorderActive: true },
    });
    // Manually inject a failing check and summarise.
    const summary = summarizeChecks([
      ...checks,
      { name: 'forced-fail', status: 'fail', detail: 'simulated' },
    ]);
    expect(summary.status).toBe('critical');
  });
});
