/**
 * Simple skill watcher — behaviour tests.
 *
 * The watcher used to hand `{ recursive: true }` to `fs.watch` and trust it.
 * Under Bun on Linux that reports a nested file appearing, then drops later
 * modifications and deletions of it — so editing or removing
 * `<scope>/<name>/SKILL.md` never reached the registry and the stale skill
 * stayed live until restart. These tests pin the symmetric behaviour —
 * create / modify / delete all refresh — plus the two scopes the watcher used
 * to ignore entirely: per-agent skill dirs, and a scope root that does not
 * exist yet at boot.
 *
 * Each test starts exactly one watcher over exactly one scope. Watch handles
 * are a shared process resource, and a test file holding dozens of them at
 * once destabilises whatever `bun test` runs next; unused scopes are pointed
 * at an unanchorable path so they cost nothing.
 *
 * Filesystem events are timing-sensitive, so every assertion waits on a
 * predicate with a generous ceiling rather than a fixed sleep.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { type SimpleSkillWatcher, startSimpleSkillWatcher } from '../../../src/skills/simple/watcher.ts';

const DEBOUNCE_MS = 20;
const WAIT_MS = 3000;

let root: string;
let open: SimpleSkillWatcher[];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'simple-watch-'));
  open = [];
});

afterEach(async () => {
  // Close every watch BEFORE deleting the tree underneath it. Removing a
  // directory out from under a live `fs.watch` handle leaves the handle stuck,
  // and a stuck handle outlives the test file.
  for (const w of open) w.close();
  await new Promise((r) => setTimeout(r, 10));
  rmSync(root, { recursive: true, force: true });
});

interface Harness {
  readonly watcher: SimpleSkillWatcher;
  /** How many times onChange has fired so far. */
  hits(): number;
}

/**
 * A path whose parent does not exist either, so the watcher skips that scope
 * outright instead of anchoring on it. Keeps each test to one live watch.
 */
function unwatched(): string {
  return join(root, 'absent', 'scope');
}

interface StartOptions {
  readonly userSkillsDir?: string;
  readonly projectSkillsDir?: string;
  readonly userAgentsDir?: string;
  readonly projectAgentsDir?: string;
  readonly onChange?: () => void;
}

function start(opts: StartOptions): Harness {
  let hits = 0;
  const watcher = startSimpleSkillWatcher({
    workspace: root,
    userSkillsDir: opts.userSkillsDir ?? unwatched(),
    projectSkillsDir: opts.projectSkillsDir ?? unwatched(),
    userAgentsDir: opts.userAgentsDir ?? unwatched(),
    projectAgentsDir: opts.projectAgentsDir ?? unwatched(),
    debounceMs: DEBOUNCE_MS,
    onChange:
      opts.onChange ??
      (() => {
        hits += 1;
      }),
  });
  open.push(watcher);
  return { watcher, hits: () => hits };
}

/** Create `<parent>/<name>/SKILL.md` and return the file path. */
function plant(parent: string, name: string, body = 'body'): string {
  const dir = join(parent, name);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'SKILL.md');
  writeFileSync(file, `---\nname: ${name}\ndescription: d\n---\n${body}\n`);
  return file;
}

/** Fresh empty scope root under the test's temp tree. */
function scope(name: string): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < WAIT_MS) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`waitFor: ${label} did not happen within ${WAIT_MS}ms`);
}

async function settle(): Promise<void> {
  await new Promise((r) => setTimeout(r, DEBOUNCE_MS * 10));
}

describe('startSimpleSkillWatcher — nested SKILL.md changes', () => {
  test('modifying then deleting a nested SKILL.md each fire onChange', async () => {
    const projectDir = scope('project');
    const file = plant(projectDir, 'temp');
    const h = start({ projectSkillsDir: projectDir });

    writeFileSync(file, '---\nname: temp\ndescription: d\n---\nrewritten\n');
    await waitFor(() => h.hits() > 0, 'modify of nested SKILL.md');

    const afterModify = h.hits();
    unlinkSync(file);
    await waitFor(() => h.hits() > afterModify, 'delete of nested SKILL.md');
  });

  test('removing the whole skill dir fires onChange', async () => {
    const userDir = scope('user');
    plant(userDir, 'doomed');
    const h = start({ userSkillsDir: userDir });

    rmSync(join(userDir, 'doomed'), { recursive: true, force: true });

    await waitFor(() => h.hits() > 0, 'removal of skill dir');
  });
});

describe('startSimpleSkillWatcher — watch set stays in sync', () => {
  test('a skill dir added after boot is watched, and a removed one is released', async () => {
    const projectDir = scope('project');
    const h = start({ projectSkillsDir: projectDir });
    expect(h.watcher.watchedDirs()).toContain(projectDir);
    expect(h.watcher.watchedDirs()).not.toContain(join(projectDir, 'late'));

    plant(projectDir, 'late');
    await waitFor(() => h.watcher.watchedDirs().includes(join(projectDir, 'late')), 'new skill dir attached');

    // The fresh watch is live: editing inside it refreshes again.
    const before = h.hits();
    writeFileSync(join(projectDir, 'late', 'SKILL.md'), '---\nname: late\ndescription: d\n---\nv2\n');
    await waitFor(() => h.hits() > before, 'edit inside newly-created skill dir');

    rmSync(join(projectDir, 'late'), { recursive: true, force: true });
    await waitFor(() => !h.watcher.watchedDirs().includes(join(projectDir, 'late')), 'watch released');
  });
});

describe('startSimpleSkillWatcher — per-agent scopes', () => {
  test('a per-agent skill added then deleted each fire onChange', async () => {
    const agentsDir = scope('agents');
    const h = start({ projectAgentsDir: agentsDir });

    const agentSkills = join(agentsDir, 'developer', 'skills');
    mkdirSync(agentSkills, { recursive: true });
    const file = plant(agentSkills, 'reviewer-helper');

    await waitFor(() => h.hits() > 0, 'per-agent skill added');
    await waitFor(
      () => h.watcher.watchedDirs().includes(join(agentSkills, 'reviewer-helper')),
      'per-agent skill dir attached',
    );

    const afterAdd = h.hits();
    unlinkSync(file);
    await waitFor(() => h.hits() > afterAdd, 'per-agent SKILL.md deleted');
  });
});

describe('startSimpleSkillWatcher — scope root missing at boot', () => {
  test('the root is picked up when created, and sibling writes are ignored', async () => {
    const nest = scope('nest');
    const lateRoot = join(nest, 'skills');
    const h = start({ projectSkillsDir: lateRoot });

    // Anchored on the parent, waiting for `skills/` to appear.
    expect(h.watcher.watchedDirs()).toContain(nest);
    expect(h.watcher.watchedDirs()).not.toContain(lateRoot);

    // `.vinyan/` also holds the SQLite file — DB churn beside a not-yet-created
    // skills dir must not trigger a full rescan on every write.
    writeFileSync(join(nest, 'vinyan.db'), 'not a skill');
    await settle();
    expect(h.hits()).toBe(0);

    mkdirSync(lateRoot, { recursive: true });
    await waitFor(() => h.watcher.watchedDirs().includes(lateRoot), 'late scope root attached');

    const before = h.hits();
    plant(lateRoot, 'finally');
    await waitFor(() => h.hits() > before, 'skill planted in late scope root');
  });
});

describe('startSimpleSkillWatcher — lifecycle', () => {
  test('close stops further callbacks and is idempotent', async () => {
    const projectDir = scope('project');
    const file = plant(projectDir, 'quiet');
    const h = start({ projectSkillsDir: projectDir });

    h.watcher.close();
    h.watcher.close(); // second call must not throw
    expect(h.watcher.watchedDirs()).toEqual([]);

    unlinkSync(file);
    await settle();

    expect(h.hits()).toBe(0);
  });

  test('an onChange that throws does not kill the watcher', async () => {
    const projectDir = scope('project');
    let calls = 0;
    const h = start({
      projectSkillsDir: projectDir,
      onChange: () => {
        calls += 1;
        throw new Error('consumer blew up');
      },
    });
    expect(h.watcher.watchedDirs()).toContain(projectDir);

    plant(projectDir, 'first');
    await waitFor(() => calls >= 1, 'first change');

    plant(projectDir, 'second');
    await waitFor(() => calls >= 2, 'second change after a throwing consumer');
  });
});
