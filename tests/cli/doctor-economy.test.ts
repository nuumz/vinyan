/**
 * `vinyan doctor` — the Economy check must probe the runtime, not the config.
 *
 * The factory only constructs the cost ledger when `economy.enabled && db`,
 * and `db` is undefined whenever opening SQLite throws (the factory swallows
 * that and degrades to in-memory). A check that reads `enabled: true` and
 * prints "Active" therefore lies on exactly the workspace where nothing is
 * being recorded.
 */
import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { runDoctorChecks } from '../../src/cli/doctor.ts';
import { ALL_MIGRATIONS, MigrationRunner } from '../../src/db/migrations/index.ts';

const dirs: string[] = [];

function makeWorkspace(economy?: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 'vinyan-doctor-econ-'));
  dirs.push(dir);
  const config: Record<string, unknown> = {
    project: { name: 'doctor-econ' },
    oracles: { type: { enabled: true } },
  };
  if (economy) config.economy = economy;
  writeFileSync(join(dir, 'vinyan.json'), JSON.stringify(config));
  return dir;
}

function migratedDb(dir: string): void {
  mkdirSync(join(dir, '.vinyan'), { recursive: true });
  const db = new Database(join(dir, '.vinyan', 'vinyan.db'));
  new MigrationRunner().migrate(db, ALL_MIGRATIONS);
  db.close();
}

async function economyCheck(dir: string) {
  const checks = await runDoctorChecks(dir);
  const check = checks.find((c) => c.name === 'Economy');
  expect(check).toBeDefined();
  return check!;
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('doctor — Economy check', () => {
  test('a migrated workspace with no economy block reports Active', async () => {
    const dir = makeWorkspace();
    migratedDb(dir);

    const check = await economyCheck(dir);
    expect(check.status).toBe('ok');
    expect(check.detail).toContain('Active');
    expect(check.detail).toContain('enforcement: warn');
    expect(check.detail).toContain('market + federation off');
  });

  test('a database without the cost_ledger table is reported inert, not Active', async () => {
    const dir = makeWorkspace();
    mkdirSync(join(dir, '.vinyan'), { recursive: true });
    // A real SQLite file that never ran the economy migration.
    const db = new Database(join(dir, '.vinyan', 'vinyan.db'));
    db.run('CREATE TABLE unrelated (id TEXT PRIMARY KEY)');
    db.close();

    const check = await economyCheck(dir);
    expect(check.status).toBe('warn');
    expect(check.detail).toContain('inert');
    expect(check.detail).toContain('cost_ledger');
    expect(check.detail).not.toContain('Active');
  });

  test('a workspace that has never run says so instead of claiming Active', async () => {
    const dir = makeWorkspace();

    const check = await economyCheck(dir);
    expect(check.status).toBe('warn');
    expect(check.detail).toContain('no vinyan.db yet');
    expect(check.detail).not.toContain('Active');
  });

  test('the documented off-switch is reported as a choice, not a problem', async () => {
    const dir = makeWorkspace({ enabled: false });
    migratedDb(dir);

    const check = await economyCheck(dir);
    expect(check.status).toBe('ok');
    expect(check.detail).toContain('economy.enabled: false');
    expect(check.detail).toContain('no cost rows are recorded');
  });
});
