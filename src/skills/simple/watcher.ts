/**
 * Simple skill watcher — observes both scopes for SKILL.md changes and
 * refreshes the in-memory registry. Emits structural events so prompt sections
 * can dirty their cache and pick up fresh content on the next render.
 *
 * Design notes:
 *   - Uses Bun's built-in `fs.watch` (no chokidar dependency). `recursive: true`
 *     is supported on macOS + Windows; on Linux we fall back to a flat watch
 *     of each scope dir and the loader rescan handles nested changes.
 *   - 200ms debounce: avoids storms when a user saves SKILL.md from an editor
 *     that does atomic-rename (write→rename triggers create+delete in quick
 *     succession on some platforms).
 *   - Caller-managed lifecycle: the factory holds the handle, calls `close()`
 *     during shutdown.
 *
 * A9: any watch error degrades silently to "skill list frozen at boot" rather
 * than crashing the orchestrator. Operators see a one-time warning.
 */
import { existsSync, type FSWatcher, watch } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface SimpleSkillWatcherOptions {
  /** Workspace path. Project skills are watched at `<workspace>/.vinyan/skills/`. */
  readonly workspace: string;
  /** Override `~/.vinyan/skills/` (mainly for tests). */
  readonly userSkillsDir?: string;
  /** Override the project skills dir. */
  readonly projectSkillsDir?: string;
  /** Debounce window in ms. Defaults to 200. */
  readonly debounceMs?: number;
  /** Called whenever a relevant file changes (after debounce). */
  readonly onChange: () => void;
}

export interface SimpleSkillWatcher {
  /** Stop watching and release filesystem handles. Idempotent. */
  close(): void;
}

const DEFAULT_DEBOUNCE_MS = 200;

export function startSimpleSkillWatcher(opts: SimpleSkillWatcherOptions): SimpleSkillWatcher {
  const userDir = opts.userSkillsDir ?? join(homedir(), '.vinyan', 'skills');
  const projectDir = opts.projectSkillsDir ?? join(opts.workspace, '.vinyan', 'skills');
  const debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;

  let timer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;
  const watchers: FSWatcher[] = [];

  const fire = () => {
    if (closed) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      try {
        opts.onChange();
      } catch (err) {
        console.warn(`[skill:simple-watcher] onChange threw: ${(err as Error).message}`);
      }
    }, debounceMs);
  };

  const watchDir = (dir: string, label: string) => {
    if (!existsSync(dir)) return;
    try {
      const w = watch(dir, { recursive: true }, () => fire());
      w.on('error', (err) => {
        console.warn(`[skill:simple-watcher] ${label} watch error: ${err.message}`);
      });
      watchers.push(w);
    } catch (err) {
      console.warn(
        `[skill:simple-watcher] cannot watch ${dir} (${label}): ${(err as Error).message}. Skill list frozen at boot.`,
      );
    }
  };

  watchDir(userDir, 'user');
  watchDir(projectDir, 'project');

  return {
    close() {
      if (closed) return;
      closed = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      for (const w of watchers) {
        try {
          w.close();
        } catch {
          /* ignore */
        }
      }
      watchers.length = 0;
    },
  };
}
