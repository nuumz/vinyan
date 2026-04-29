/**
 * Simple skill registry — in-memory cache of loaded skills, refreshed by the
 * filesystem watcher. The factory builds one instance and threads it into the
 * prompt-builder + outcome telemetry so all consumers see the same set of
 * skills at any moment in time.
 *
 * Lifecycle:
 *   1. Factory calls `createSimpleSkillRegistry(opts)` at boot — initial scan
 *      via `loadSimpleSkills`.
 *   2. Watcher fires on SKILL.md changes → registry calls `refresh()` which
 *      re-runs the loader + bumps the version counter. Consumers (prompt
 *      sections) read the version to know when to invalidate caches.
 *   3. Factory calls `close()` at shutdown to release the watcher handle.
 *
 * Why a separate registry rather than direct watcher → loader composition?
 *   - Consumers shouldn't care about IO. They want `getAll()` and `getVersion()`.
 *   - Tests can inject a static registry without spinning up a real filesystem
 *     watcher (the prompt-section tests in Phase 3 will use this).
 */
import { loadSimpleSkills, type LoadSimpleSkillsOptions, type SimpleSkill } from './loader.ts';
import {
  startSimpleSkillWatcher,
  type SimpleSkillWatcher,
  type SimpleSkillWatcherOptions,
} from './watcher.ts';

export interface SimpleSkillRegistry {
  /** Snapshot of currently loaded skills, sorted by name. */
  getAll(): readonly SimpleSkill[];
  /** Look up a skill by name. */
  getByName(name: string): SimpleSkill | null;
  /**
   * Monotonic counter — increments on every refresh. Consumers cache against
   * this so they invalidate when a skill is added/changed/removed.
   */
  getVersion(): number;
  /** Release watcher handles. Idempotent. */
  close(): void;
}

export interface CreateSimpleSkillRegistryOptions extends LoadSimpleSkillsOptions {
  /** When false, skip the watcher entirely (tests / one-shot CLIs). */
  readonly watch?: boolean;
  /** Watcher debounce override (forwarded to startSimpleSkillWatcher). */
  readonly watcherDebounceMs?: number;
}

export function createSimpleSkillRegistry(
  opts: CreateSimpleSkillRegistryOptions,
): SimpleSkillRegistry {
  let skills: readonly SimpleSkill[] = [];
  const byName = new Map<string, SimpleSkill>();
  let version = 0;

  const refresh = (): void => {
    const result = loadSimpleSkills(opts);
    skills = result.skills;
    byName.clear();
    for (const skill of skills) byName.set(skill.name, skill);
    version += 1;
  };

  refresh();

  let watcher: SimpleSkillWatcher | null = null;
  if (opts.watch !== false) {
    const watcherOpts: SimpleSkillWatcherOptions = {
      workspace: opts.workspace,
      ...(opts.userSkillsDir !== undefined ? { userSkillsDir: opts.userSkillsDir } : {}),
      ...(opts.projectSkillsDir !== undefined ? { projectSkillsDir: opts.projectSkillsDir } : {}),
      ...(opts.watcherDebounceMs !== undefined ? { debounceMs: opts.watcherDebounceMs } : {}),
      onChange: refresh,
    };
    watcher = startSimpleSkillWatcher(watcherOpts);
  }

  return {
    getAll(): readonly SimpleSkill[] {
      return skills;
    },
    getByName(name: string): SimpleSkill | null {
      return byName.get(name) ?? null;
    },
    getVersion(): number {
      return version;
    },
    close(): void {
      if (watcher) {
        watcher.close();
        watcher = null;
      }
    },
  };
}
