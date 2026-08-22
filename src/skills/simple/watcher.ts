/**
 * Simple skill watcher — observes every skill scope for SKILL.md changes and
 * refreshes the in-memory registry. Emits structural events so prompt sections
 * can dirty their cache and pick up fresh content on the next render.
 *
 * Design notes:
 *   - Uses Bun's built-in `fs.watch` (no chokidar dependency) NON-recursively,
 *     and watches every descendant directory of each scope root explicitly.
 *     `recursive: true` is not portable: under Bun on Linux it reports a nested
 *     file being created, then silently drops later *modifications* and
 *     *deletions* of that same file. So editing or removing
 *     `<scope>/<name>/SKILL.md` never reached the registry and the stale skill
 *     stayed live until restart. Watching each skill dir directly makes
 *     create/modify/delete symmetric on every platform.
 *   - The watch set is re-synced after every debounced change, so skill dirs
 *     created or removed at runtime attach/detach their own watch.
 *   - A scope root that does not exist yet is anchored on its parent so
 *     `mkdir ~/.vinyan/skills` starts working without a restart. Anchor watches
 *     are name-filtered to the missing root's basename — `<workspace>/.vinyan/`
 *     also holds the SQLite file, and an unfiltered watch there would rescan on
 *     every database write. If the parent is missing too, that scope stays
 *     unwatched — there is nothing to anchor on.
 *   - 200ms debounce: avoids storms when a user saves SKILL.md from an editor
 *     that does atomic-rename (write→rename triggers create+delete in quick
 *     succession on some platforms).
 *   - Caller-managed lifecycle: the factory holds the handle, calls `close()`
 *     during shutdown.
 *
 * A9: any watch error degrades to "that directory is not watched" rather than
 * crashing the orchestrator. Operators see a warning.
 */
import { type Dirent, existsSync, type FSWatcher, readdirSync, watch } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';

export interface SimpleSkillWatcherOptions {
  /** Workspace path. Project skills are watched at `<workspace>/.vinyan/skills/`. */
  readonly workspace: string;
  /** Override `~/.vinyan/skills/` (mainly for tests). */
  readonly userSkillsDir?: string;
  /** Override the project skills dir. */
  readonly projectSkillsDir?: string;
  /** Override `~/.vinyan/agents/` — per-agent user-scope skills live below it. */
  readonly userAgentsDir?: string;
  /** Override `<workspace>/.vinyan/agents/` — per-agent project-scope skills. */
  readonly projectAgentsDir?: string;
  /** Debounce window in ms. Defaults to 200. */
  readonly debounceMs?: number;
  /** Called whenever a relevant file changes (after debounce). */
  readonly onChange: () => void;
}

export interface SimpleSkillWatcher {
  /** Stop watching and release filesystem handles. Idempotent. */
  close(): void;
  /** Directories currently under watch, sorted. Diagnostic / test surface. */
  watchedDirs(): readonly string[];
}

const DEFAULT_DEBOUNCE_MS = 200;
/**
 * Deepest scope layout is `<agentsDir>/<agentId>/skills/<name>/SKILL.md`, i.e.
 * three directory levels below the root. One level of slack absorbs a skill dir
 * that keeps its assets in a subfolder.
 */
const MAX_WATCH_DEPTH = 4;
/** Backstop against a scope root pointed at something huge by misconfiguration. */
const MAX_WATCHED_DIRS = 512;

/** `null` accepts every event name; a set fires only for those entry names. */
type NameFilter = Set<string> | null;

export function startSimpleSkillWatcher(opts: SimpleSkillWatcherOptions): SimpleSkillWatcher {
  const roots: readonly string[] = [
    opts.userSkillsDir ?? join(homedir(), '.vinyan', 'skills'),
    opts.projectSkillsDir ?? join(opts.workspace, '.vinyan', 'skills'),
    opts.userAgentsDir ?? join(homedir(), '.vinyan', 'agents'),
    opts.projectAgentsDir ?? join(opts.workspace, '.vinyan', 'agents'),
  ];
  const debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;

  const watchers = new Map<string, FSWatcher>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;
  let capWarned = false;

  const collect = (dir: string, depth: number, out: Map<string, NameFilter>): void => {
    if (out.size >= MAX_WATCHED_DIRS) {
      if (!capWarned) {
        capWarned = true;
        console.warn(
          `[skill:simple-watcher] watch cap of ${MAX_WATCHED_DIRS} directories reached at ${dir}. Deeper skill dirs need a manual refresh.`,
        );
      }
      return;
    }
    out.set(dir, null);
    if (depth >= MAX_WATCH_DEPTH) return;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // Raced with a delete, or unreadable — the parent watch still covers it.
    }
    for (const entry of entries) {
      if (entry.isDirectory()) collect(join(dir, entry.name), depth + 1, out);
    }
  };

  /** Directory → which entry names should fire a refresh. */
  const desiredDirs = (): Map<string, NameFilter> => {
    const out = new Map<string, NameFilter>();
    for (const root of roots) {
      if (existsSync(root)) {
        collect(root, 0, out);
        continue;
      }
      // Root not created yet — anchor on the parent and wait for it to appear.
      const parent = dirname(root);
      if (parent === root || !existsSync(parent)) continue;
      const existing = out.get(parent);
      if (existing === null) continue; // Already watched unfiltered.
      const filter = existing ?? new Set<string>();
      filter.add(basename(root));
      out.set(parent, filter);
    }
    return out;
  };

  const sync = (): void => {
    if (closed) return;
    const desired = desiredDirs();

    for (const [dir, w] of watchers) {
      if (desired.has(dir)) continue;
      try {
        w.close();
      } catch {
        /* ignore */
      }
      watchers.delete(dir);
    }

    for (const [dir, filter] of desired) {
      if (watchers.has(dir)) continue;
      try {
        const w = watch(dir, (_event, filename) => {
          if (filter !== null && (filename === null || !filter.has(String(filename)))) return;
          fire();
        });
        w.on('error', (err) => {
          const code = (err as NodeJS.ErrnoException).code;
          try {
            w.close();
          } catch {
            /* ignore */
          }
          watchers.delete(dir);
          if (code === 'ENOENT') {
            // Bun on Linux reports an entry disappearing as an ENOENT *error*
            // on the directory watch instead of a change event. That IS a
            // change — refresh, and let the following `sync()` re-attach the
            // watch if the directory itself survived. Self-limiting: a dir
            // that is really gone is not re-added, so this cannot spin.
            fire();
            return;
          }
          // Anything else (EACCES, EMFILE, …) drops the watch without a
          // refresh: re-attaching on the spot could loop on a dir that keeps
          // failing. The next event elsewhere re-syncs it.
          console.warn(`[skill:simple-watcher] watch error on ${dir}: ${err.message}. Dropping that watch.`);
        });
        watchers.set(dir, w);
      } catch (err) {
        console.warn(
          `[skill:simple-watcher] cannot watch ${dir}: ${(err as Error).message}. Skills below it are frozen until the next manual refresh.`,
        );
      }
    }
  };

  const fire = (): void => {
    if (closed) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      if (closed) return;
      // Re-sync first: a new skill dir needs its own watch, a deleted one
      // needs its handle released, before consumers observe the new state.
      sync();
      try {
        opts.onChange();
      } catch (err) {
        console.warn(`[skill:simple-watcher] onChange threw: ${(err as Error).message}`);
      }
    }, debounceMs);
  };

  sync();

  return {
    close() {
      if (closed) return;
      closed = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      for (const w of watchers.values()) {
        try {
          w.close();
        } catch {
          /* ignore */
        }
      }
      watchers.clear();
    },
    watchedDirs(): readonly string[] {
      return [...watchers.keys()].sort();
    },
  };
}
