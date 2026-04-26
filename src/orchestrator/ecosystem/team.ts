/**
 * TeamManager — durable rosters with persistent shared blackboards.
 *
 * A Team is a group of engines that share state across many tasks. It is
 * distinct from a Room (task-scoped, dissolves on close) in three ways:
 *
 *  1. **Durability** — a team survives restart; its blackboard is in SQLite.
 *  2. **Composition** — membership is explicit (join/leave), not implicit
 *     from auction winners.
 *  3. **Scope** — a single team can participate in many rooms over time.
 *
 * Teams are optional; the system works without them. Use them when you
 * want cross-task memory for a specific agent group.
 *
 * Source of truth: docs/design/vinyan-os-ecosystem-plan.md §2.2, §3.1
 */

import { randomUUID } from 'crypto';

import type { VinyanBus } from '../../core/bus.ts';
import type { TeamBlackboardEntry, TeamMemberRecord, TeamRecord, TeamStore } from '../../db/team-store.ts';
import type { TeamBlackboardFs, FsBlackboardEntry } from './team-blackboard-fs.ts';

// ── Config ───────────────────────────────────────────────────────────

export interface TeamManagerConfig {
  readonly store: TeamStore;
  readonly now?: () => number;
  readonly idFactory?: () => string;
  /**
   * Ecosystem Phase 3: when wired, TeamManager emits
   * `team:blackboard_updated` on every write (internal + external via
   * watcher) and caches the latest version in memory for fast reads.
   * Optional so unit tests / legacy paths don't need a bus.
   */
  readonly bus?: VinyanBus;
  /**
   * Ecosystem Phase 3: filesystem backend handle. The watcher (owned by
   * `attachBlackboardWatcher()`) uses it to re-read changed files. When
   * omitted, the manager still works over DB-only stores — the watcher
   * simply isn't attachable.
   */
  readonly fsBlackboard?: TeamBlackboardFs;
}

export interface CreateTeamParams {
  name: string;
  departmentId?: string;
  initialMembers?: ReadonlyArray<{ engineId: string; role?: string }>;
}

// ── Manager ──────────────────────────────────────────────────────────

export class TeamManager {
  private readonly store: TeamStore;
  private readonly now: () => number;
  private readonly newId: () => string;
  private readonly bus?: VinyanBus;
  private readonly fsBlackboard?: TeamBlackboardFs;
  /** Latest observed (version, timestamp) per (teamId, key) — used to
   *  distinguish internal vs external writes in watcher callbacks. */
  private readonly seen = new Map<string, { version: number; at: number }>();

  constructor(config: TeamManagerConfig) {
    this.store = config.store;
    this.now = config.now ?? (() => Date.now());
    this.newId = config.idFactory ?? (() => randomUUID());
    this.bus = config.bus;
    this.fsBlackboard = config.fsBlackboard;
  }

  private seenKey(teamId: string, key: string): string {
    return `${teamId}\u0000${key}`;
  }

  // ── Roster ───────────────────────────────────────────────────────

  create(params: CreateTeamParams): TeamRecord {
    const teamId = this.newId();
    const createdAt = this.now();
    this.store.createTeam({
      teamId,
      name: params.name,
      departmentId: params.departmentId,
      createdAt,
    });
    if (params.initialMembers) {
      for (const m of params.initialMembers) {
        this.store.addMember({
          teamId,
          engineId: m.engineId,
          role: m.role,
          joinedAt: createdAt,
        });
      }
    }
    return this.store.getTeam(teamId)!;
  }

  get(teamId: string): TeamRecord | null {
    return this.store.getTeam(teamId);
  }

  listActive(): readonly TeamRecord[] {
    return this.store.listActiveTeams();
  }

  archive(teamId: string): boolean {
    return this.store.archiveTeam(teamId, this.now());
  }

  members(teamId: string): readonly TeamMemberRecord[] {
    return this.store.listMembers(teamId);
  }

  addMember(teamId: string, engineId: string, role?: string): void {
    if (!this.store.getTeam(teamId)) {
      throw new Error(`team: unknown team ${teamId}`);
    }
    // Skip if the engine is already an active member
    const existing = this.store.listMembers(teamId).find((m) => m.engineId === engineId);
    if (existing) return;
    this.store.addMember({ teamId, engineId, role, joinedAt: this.now() });
  }

  removeMember(teamId: string, engineId: string): boolean {
    return this.store.removeMember(teamId, engineId, this.now());
  }

  // ── Blackboard (persistent shared state) ─────────────────────────

  /**
   * Write a new version for (teamId, key). Returns the assigned version.
   * The value is JSON-serialized; pass anything serializable.
   *
   * When the bus is wired, emits `team:blackboard_updated` with
   * `source: 'internal'`. The filesystem write will ALSO be observed by
   * the watcher attached via `attachBlackboardWatcher()` — that path
   * dedupes against the cached version we just wrote, so no duplicate
   * event fires.
   */
  setState(teamId: string, key: string, value: unknown, authorId: string): number {
    if (!this.store.getTeam(teamId)) {
      throw new Error(`team: unknown team ${teamId}`);
    }
    const updatedAt = this.now();
    const version = this.store.writeBlackboard({
      teamId,
      key,
      value,
      authorId,
      updatedAt,
    });
    this.seen.set(this.seenKey(teamId, key), { version, at: updatedAt });
    this.bus?.emit('team:blackboard_updated', {
      teamId,
      key,
      version,
      author: authorId,
      source: 'internal',
      path: this.fsBlackboard?.filePath(teamId, key) ?? `(db:${teamId}/${key})`,
    });
    return version;
  }

  // ── Watcher (Phase 3) ────────────────────────────────────────────

  /**
   * Attach a chokidar watcher on `<workspace>/.vinyan/teams/**\/*.md`.
   * On change, re-reads the file and emits `team:blackboard_updated`
   * with `source: 'external'` UNLESS the observed version matches what
   * this manager just wrote internally (dedup).
   *
   * Returns a disposer; callers (factory.ts / coordinator.stop) MUST
   * invoke it to free the chokidar handle.
   *
   * No-op when `fsBlackboard`, `bus`, or chokidar is unavailable.
   */
  attachBlackboardWatcher(workspace: string): () => void {
    if (!this.fsBlackboard || !this.bus) {
      return () => {};
    }
    // Dynamic import so test environments that don't exercise the watcher
    // avoid paying chokidar's startup cost.
    let chokidar: typeof import('chokidar');
    try {
      chokidar = require('chokidar') as typeof import('chokidar');
    } catch {
      return () => {};
    }
    const { join } = require('path') as typeof import('path');
    const watchRoot = join(workspace, '.vinyan', 'teams');
    const debounceMs = 100;
    const timers = new Map<string, ReturnType<typeof setTimeout>>();

    const handler = (path: string) => {
      if (!path.endsWith('.md')) return;
      // Debounce rapid successive events on the same path.
      const pending = timers.get(path);
      if (pending) clearTimeout(pending);
      timers.set(
        path,
        setTimeout(() => {
          timers.delete(path);
          this.onWatcherEvent(path);
        }, debounceMs),
      );
    };

    const watcher = chokidar.watch(watchRoot, {
      persistent: true,
      ignoreInitial: true,
      ignorePermissionErrors: true,
      ignored: (p: string) => /\/\.test-workspace[^/]*(\/|$)/.test(p),
    });
    watcher.on('add', handler);
    watcher.on('change', handler);
    watcher.on('error', (err: unknown) => {
      const e = err as { code?: string; message?: string };
      console.warn(
        `[vinyan] team-blackboard-watcher: ${e.code ?? 'error'} ${e.message ?? String(err)} (continuing)`,
      );
    });

    return () => {
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
      void watcher.close();
    };
  }

  /**
   * Callback invoked from the watcher after debounce. Re-reads the file,
   * extracts the (teamId, key, version) triple, and emits an external
   * event when the version differs from what we cached internally.
   */
  private onWatcherEvent(path: string): void {
    if (!this.fsBlackboard || !this.bus) return;
    // Derive teamId from the directory name; the FS layout is
    // `<root>/.vinyan/teams/<teamId>/<sanitized_key>.md`.
    const { dirname, basename } = require('path') as typeof import('path');
    const teamDir = dirname(path);
    const teamId = basename(teamDir);
    // Parse the file to extract the *original* key + version (filename is
    // sanitized). Reuse fsBlackboard.read by walking via listKeys pattern
    // — cheaper: read the file directly via a generic parser.
    let entry: FsBlackboardEntry | null = null;
    try {
      // fsBlackboard.read needs an un-sanitized key, but we don't have
      // one yet. Read the raw file and parse via readFromPath.
      entry = this.readEntryByPath(path, teamId);
    } catch {
      return;
    }
    if (!entry) return;

    const cacheKey = this.seenKey(teamId, entry.key);
    const cached = this.seen.get(cacheKey);
    if (cached && cached.version === entry.version) {
      // Either our own write landed, or a duplicate event — suppress.
      return;
    }
    this.seen.set(cacheKey, { version: entry.version, at: entry.updatedAt });
    this.bus.emit('team:blackboard_updated', {
      teamId,
      key: entry.key,
      version: entry.version,
      author: entry.authorId,
      source: 'external',
      path,
    });
  }

  /**
   * Read-by-absolute-path helper used only by the watcher callback. Keeps
   * the concern inside TeamManager so callers don't need to reach into
   * TeamBlackboardFs internals.
   */
  private readEntryByPath(path: string, teamId: string): FsBlackboardEntry | null {
    if (!this.fsBlackboard) return null;
    // We don't have the original key — scan listKeys until one matches
    // the sanitized file. This is O(team size) but teams are small.
    const sanitizedBase = (require('path') as typeof import('path'))
      .basename(path, '.md');
    for (const key of this.fsBlackboard.listKeys(teamId)) {
      const filePath = this.fsBlackboard.filePath(teamId, key);
      if ((require('path') as typeof import('path')).basename(filePath, '.md') === sanitizedBase) {
        return this.fsBlackboard.read(teamId, key);
      }
    }
    return null;
  }

  /** Latest version for (teamId, key). `undefined` if the key has never been set. */
  getState<T = unknown>(teamId: string, key: string): T | undefined {
    const row = this.store.readBlackboard(teamId, key);
    return row ? (row.value as T) : undefined;
  }

  /** Full entry (with version + author + timestamp) for (teamId, key). */
  getStateEntry(teamId: string, key: string): TeamBlackboardEntry | null {
    return this.store.readBlackboard(teamId, key);
  }

  listStateKeys(teamId: string): readonly string[] {
    return this.store.listBlackboardKeys(teamId);
  }

  deleteState(teamId: string, key: string): number {
    return this.store.deleteBlackboardKey(teamId, key);
  }
}
