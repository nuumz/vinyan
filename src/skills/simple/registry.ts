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
import { filterSkillsForAgent, loadSimpleSkills, type LoadSimpleSkillsOptions, type SimpleSkill } from './loader.ts';
import {
  startSimpleSkillWatcher,
  type SimpleSkillWatcher,
  type SimpleSkillWatcherOptions,
} from './watcher.ts';

export interface SimpleSkillRegistry {
  /**
   * Full snapshot — every loaded skill across all 4 scopes (shared + every
   * agent's per-agent dirs). Use `getForAgent` for the dispatch-time view
   * filtered to a specific persona.
   */
  getAll(): readonly SimpleSkill[];
  /**
   * Per-agent snapshot. Returns shared-scope skills + the supplied agent's
   * per-agent skills. Other agents' per-agent skills are filtered OUT
   * (per-persona privacy isolation).
   *
   * Pass `undefined` to get only the shared scopes (no agent context).
   */
  getForAgent(agentId: string | undefined): readonly SimpleSkill[];
  /**
   * Look up a skill by name in the FULL snapshot (no agent filtering). Mainly
   * for CLI tooling — use `getForAgent` then `find` for dispatch-time lookups.
   */
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
    // Prefer shared-scope first so CLI's `getByName('code-review')` returns
    // the user/project version rather than picking a per-agent variant by
    // accident. Per-agent variants of the same name are still reachable via
    // `getForAgent(agentId)` then by-name search, or via the FULL snapshot.
    for (const skill of skills) {
      if (skill.scope === 'user' || skill.scope === 'project') {
        byName.set(skill.name, skill);
      }
    }
    for (const skill of skills) {
      if (!byName.has(skill.name)) byName.set(skill.name, skill);
    }
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
    getForAgent(agentId: string | undefined): readonly SimpleSkill[] {
      return filterSkillsForAgent(skills, agentId);
    },
    getByName(name: string): SimpleSkill | null {
      // First match in the FULL snapshot. With per-agent skills, multiple
      // entries may share a name (one per agent + shared); the first match
      // by stable order is good enough for CLI tooling. The dispatch path
      // uses `getForAgent` instead.
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
