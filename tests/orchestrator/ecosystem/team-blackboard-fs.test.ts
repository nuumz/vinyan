import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { migration001 } from '../../../src/db/migrations/001_initial_schema.ts';

import { TeamStore } from '../../../src/db/team-store.ts';
import { TeamBlackboardFs } from '../../../src/orchestrator/ecosystem/team-blackboard-fs.ts';
import { TeamManager } from '../../../src/orchestrator/ecosystem/team.ts';

function makeDb(): Database {
  const db = new Database(':memory:');
  migration001.up(db);
  return db;
}

describe('TeamBlackboardFs — write/read roundtrip', () => {
  let workspace: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'vinyan-team-fs-'));
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  it('writes a new key at version 1 and reads it back', () => {
    const fs = new TeamBlackboardFs({ root: workspace, now: () => 1_700_000_000_000 });
    const entry = fs.write({
      teamId: 'squad-a',
      key: 'plan',
      value: { body: 'write tests' },
      authorId: 'alice',
      updatedAt: 1_700_000_000_000,
    });
    expect(entry.version).toBe(1);
    expect(entry.authorId).toBe('alice');

    const read = fs.read('squad-a', 'plan');
    expect(read).not.toBeNull();
    expect(read!.value).toEqual({ body: 'write tests' });
    expect(read!.version).toBe(1);
  });

  it('increments version on repeated writes', () => {
    const fs = new TeamBlackboardFs({ root: workspace });
    expect(fs.write({ teamId: 't', key: 'k', value: 1, authorId: 'a', updatedAt: 1 }).version).toBe(1);
    expect(fs.write({ teamId: 't', key: 'k', value: 2, authorId: 'a', updatedAt: 2 }).version).toBe(2);
    expect(fs.write({ teamId: 't', key: 'k', value: 3, authorId: 'a', updatedAt: 3 }).version).toBe(3);
    expect(fs.read('t', 'k')!.value).toBe(3);
  });

  it('returns null for a missing key', () => {
    const fs = new TeamBlackboardFs({ root: workspace });
    expect(fs.read('t', 'nope')).toBeNull();
  });

  it('listKeys returns the original (non-sanitized) key from frontmatter', () => {
    const fs = new TeamBlackboardFs({ root: workspace });
    fs.write({ teamId: 't', key: 'shared:outline', value: 'x', authorId: 'a', updatedAt: 1 });
    fs.write({ teamId: 't', key: 'critique/concerns', value: 'y', authorId: 'a', updatedAt: 2 });
    expect([...fs.listKeys('t')].sort()).toEqual(['critique/concerns', 'shared:outline']);
  });

  it('delete removes the file', () => {
    const fs = new TeamBlackboardFs({ root: workspace });
    fs.write({ teamId: 't', key: 'k', value: 1, authorId: 'a', updatedAt: 1 });
    expect(fs.read('t', 'k')).not.toBeNull();
    expect(fs.delete('t', 'k')).toBe(1);
    expect(fs.read('t', 'k')).toBeNull();
    expect(fs.delete('t', 'k')).toBe(0); // idempotent
  });
});

describe('TeamBlackboardFs — sanitization', () => {
  let workspace: string;
  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'vinyan-team-fs-san-'));
  });
  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  it('replaces / with __ in filenames', () => {
    const fs = new TeamBlackboardFs({ root: workspace });
    fs.write({ teamId: 't', key: 'critique/concerns', value: 1, authorId: 'a', updatedAt: 1 });
    const dir = fs.teamDir('t');
    const files = readdirSync(dir);
    expect(files.some((f) => f === 'critique__concerns.md')).toBe(true);
  });

  it('rejects characters outside [A-Za-z0-9_\\-:.]', () => {
    const fs = new TeamBlackboardFs({ root: workspace });
    expect(() =>
      fs.write({ teamId: 't', key: 'bad space', value: 1, authorId: 'a', updatedAt: 1 }),
    ).toThrow(/invalid key/);
    expect(() =>
      fs.write({ teamId: 'bad space', key: 'k', value: 1, authorId: 'a', updatedAt: 1 }),
    ).toThrow(/invalid team/);
  });

  it('hash-truncates names longer than 200 chars', () => {
    const longKey = 'x'.repeat(250);
    const fs = new TeamBlackboardFs({ root: workspace });
    fs.write({ teamId: 't', key: longKey, value: 1, authorId: 'a', updatedAt: 1 });
    const files = readdirSync(fs.teamDir('t'));
    expect(files).toHaveLength(1);
    expect(files[0]!.length).toBeLessThanOrEqual(200 + 3); // + '.md'
    // Frontmatter preserves original key.
    expect(fs.listKeys('t')).toEqual([longKey]);
  });
});

describe('TeamBlackboardFs — CAS', () => {
  let workspace: string;
  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'vinyan-team-fs-cas-'));
  });
  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  it('writeWithCas succeeds when baseline matches on-disk version', () => {
    const fs = new TeamBlackboardFs({ root: workspace });
    fs.write({ teamId: 't', key: 'k', value: 1, authorId: 'a', updatedAt: 1 });
    const entry = fs.writeWithCas({
      teamId: 't',
      key: 'k',
      value: 2,
      authorId: 'b',
      baselineVersion: 1,
    });
    expect(entry).not.toBeNull();
    expect(entry!.version).toBe(2);
  });

  it('writeWithCas returns null when baseline is stale', () => {
    const fs = new TeamBlackboardFs({ root: workspace });
    fs.write({ teamId: 't', key: 'k', value: 1, authorId: 'a', updatedAt: 1 });
    fs.write({ teamId: 't', key: 'k', value: 2, authorId: 'a', updatedAt: 2 }); // disk is v2 now
    const entry = fs.writeWithCas({
      teamId: 't',
      key: 'k',
      value: 99,
      authorId: 'b',
      baselineVersion: 1, // stale
    });
    expect(entry).toBeNull();
    expect(fs.read('t', 'k')!.value).toBe(2); // unchanged
  });

  it('write() auto-retries once on CAS miss (simulating concurrent external edit)', () => {
    // A fake external write happens between our baseline-read and our
    // writeWithCas call. We mimic this by monkey-patching the private
    // method; simplest is to write a row first, then call write which
    // reads baseline=v1, internally writeWithCas succeeds at v2. Then
    // we inject a v3 externally (bumping disk), and call write which
    // should retry and end up at v4 (baseline=v3 + 1).
    const fs = new TeamBlackboardFs({ root: workspace });
    fs.write({ teamId: 't', key: 'k', value: 1, authorId: 'a', updatedAt: 1 });

    // Simulate an external writer appending v2 between our baseline-read
    // and our writeWithCas call by wrapping the read once.
    const originalRead = fs.read.bind(fs);
    let externalInjected = false;
    (fs as unknown as { read: typeof fs.read }).read = (teamId, key) => {
      if (!externalInjected && teamId === 't' && key === 'k') {
        externalInjected = true;
        const out = originalRead(teamId, key);
        // Inject external v2 after our baseline-read returns v1.
        fs.write({ teamId: 't', key: 'k', value: 99, authorId: 'external', updatedAt: 2 });
        return out; // we still return v1 so writeWithCas fails; write() retries.
      }
      return originalRead(teamId, key);
    };

    const entry = fs.write({ teamId: 't', key: 'k', value: 'mine', authorId: 'b', updatedAt: 3 });
    expect(entry.version).toBe(3); // v2 from external + our retry = v3
    expect(entry.value).toBe('mine');
  });
});

describe('TeamStore dual-write integration', () => {
  let workspace: string;
  let db: Database;
  let fs: TeamBlackboardFs;
  let store: TeamStore;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'vinyan-team-fs-int-'));
    db = makeDb();
    fs = new TeamBlackboardFs({ root: workspace });
    store = new TeamStore(db, { fsBlackboard: fs });
    // Team row is still in SQLite — only blackboard moves.
    store.createTeam({ teamId: 'squad', name: 'A', createdAt: 1 });
  });
  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
    db.close();
  });

  it('writeBlackboard lands in filesystem with versioned frontmatter', () => {
    const version = store.writeBlackboard({
      teamId: 'squad',
      key: 'plan',
      value: { body: 'hi' },
      authorId: 'alice',
      updatedAt: 1_700_000_000_000,
    });
    expect(version).toBe(1);

    const fsPath = fs.filePath('squad', 'plan');
    expect(existsSync(fsPath)).toBe(true);
    const raw = readFileSync(fsPath, 'utf-8');
    expect(raw).toContain('version: 1');
    expect(raw).toContain('author: alice');
  });

  it('throws when fsBlackboard is missing (post-migration-040 guarantee)', () => {
    const bareStore = new TeamStore(db);
    expect(() =>
      bareStore.writeBlackboard({
        teamId: 'squad',
        key: 'k',
        value: 1,
        authorId: 'a',
        updatedAt: 1,
      }),
    ).toThrow(/fsBlackboard not wired/);
  });

  it('deleteBlackboardKey removes the file', () => {
    store.writeBlackboard({
      teamId: 'squad',
      key: 'plan',
      value: 1,
      authorId: 'alice',
      updatedAt: 1,
    });
    const removed = store.deleteBlackboardKey('squad', 'plan');
    expect(removed).toBeGreaterThanOrEqual(1);
    expect(store.readBlackboard('squad', 'plan')).toBeNull();
  });
});

describe('TeamManager over FS-backed store', () => {
  let workspace: string;
  let db: Database;
  let mgr: TeamManager;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'vinyan-team-mgr-fs-'));
    db = makeDb();
    const fs = new TeamBlackboardFs({ root: workspace });
    const store = new TeamStore(db, { fsBlackboard: fs });
    mgr = new TeamManager({ store });
  });
  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
    db.close();
  });

  it('setState + getState round-trip through filesystem', () => {
    const t = mgr.create({ name: 'squad' });
    mgr.setState(t.teamId, 'plan', { steps: ['a', 'b'] }, 'alice');
    expect(mgr.getState<{ steps: string[] }>(t.teamId, 'plan')).toEqual({ steps: ['a', 'b'] });
  });

  it('persists across TeamManager restart (filesystem is durable)', () => {
    const t = mgr.create({ name: 'keeper' });
    mgr.setState(t.teamId, 'doc', { body: 'hello' }, 'alice');

    // "Restart" by constructing fresh instances on the same workspace.
    const fs2 = new TeamBlackboardFs({ root: workspace });
    const store2 = new TeamStore(db, { fsBlackboard: fs2 });
    const mgr2 = new TeamManager({ store: store2 });
    expect(mgr2.getState<{ body: string }>(t.teamId, 'doc')).toEqual({ body: 'hello' });
  });
});
