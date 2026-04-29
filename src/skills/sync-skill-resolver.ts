/**
 * SyncSkillResolver — pre-loads `.vinyan/skills/` at boot so registry's
 * `getDerivedCapabilities` (sync path) can resolve `SkillRef → SkillMdRecord`
 * without async IO during agent registration.
 *
 * The agent registry composition path is sync by design (skill bindings change
 * at runtime via CLI bind/unbind, the registry re-reads on each call). The
 * artifact store is async. This adapter bridges the two by reading the entire
 * `.vinyan/skills/` tree once at construction time and serving hits from the
 * in-memory map.
 *
 * Trade-offs:
 *   - Skills added/edited mid-session do NOT show up until the registry is
 *     rebuilt (factory restart). Acceptable: persona skill bindings are stable
 *     within a session; live edits target the simple-skills layer (Phase 2)
 *     which has its own watcher.
 *   - Memory cost: O(N × file size). Warns when ≥100 skills loaded.
 *
 * A9 (resilient degradation): missing `.vinyan/skills/` directory or unreadable
 * SKILL.md files do NOT throw — they degrade to an empty resolver with a
 * structured warning. The registry then falls through to its own empty-skill
 * default and the system stays bootable.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parseSkillMd, type SkillMdRecord } from './skill-md/index.ts';
import type { SkillRef } from '../orchestrator/types.ts';
import type { SyncSkillResolver } from '../orchestrator/agents/derive-persona-capabilities.ts';

const PERFORMANCE_WARNING_THRESHOLD = 100;

export interface BuildSyncSkillResolverResult {
  /** The resolver to pass into `loadAgentRegistry({ skillResolver })`. */
  readonly resolver: SyncSkillResolver;
  /** Number of skills successfully pre-loaded. */
  readonly loadedCount: number;
  /** Skill ids that failed to parse. Logged but non-fatal. */
  readonly failedIds: readonly string[];
}

/**
 * Build a sync resolver by pre-scanning `<workspace>/.vinyan/skills/`.
 *
 * Layout (mirrors `SkillArtifactStore`):
 *     <rootDir>/<namespace>/<leaf>/SKILL.md
 *
 * Where `namespace='local'` is implicit for flat ids.
 */
export function buildSyncSkillResolver(rootDir: string): BuildSyncSkillResolverResult {
  const byId = new Map<string, SkillMdRecord>();
  const failedIds: string[] = [];

  if (!existsSync(rootDir)) {
    return { resolver: makeResolver(byId), loadedCount: 0, failedIds };
  }

  let namespaces: string[];
  try {
    namespaces = readdirSync(rootDir);
  } catch (err) {
    console.warn(`[skill:sync-resolver] cannot read ${rootDir}: ${(err as Error).message}`);
    return { resolver: makeResolver(byId), loadedCount: 0, failedIds };
  }

  for (const namespace of namespaces) {
    const nsDir = join(rootDir, namespace);
    if (!safeIsDir(nsDir)) continue;
    let leaves: string[];
    try {
      leaves = readdirSync(nsDir);
    } catch {
      continue;
    }
    for (const leaf of leaves) {
      const leafDir = join(nsDir, leaf);
      if (!safeIsDir(leafDir)) continue;
      const skillMdPath = join(leafDir, 'SKILL.md');
      if (!existsSync(skillMdPath)) continue;
      const id = namespace === 'local' ? leaf : `${namespace}/${leaf}`;
      try {
        const text = readFileSync(skillMdPath, 'utf-8');
        const record = parseSkillMd(text);
        byId.set(id, record);
      } catch (err) {
        failedIds.push(id);
        console.warn(
          `[skill:sync-resolver] skill='${id}' parse-failed: ${(err as Error).message}`,
        );
      }
    }
  }

  if (byId.size >= PERFORMANCE_WARNING_THRESHOLD) {
    console.warn(
      `[skill:sync-resolver] pre-loaded ${byId.size} skills (≥${PERFORMANCE_WARNING_THRESHOLD}) — boot time may degrade. Consider lazy-loading.`,
    );
  }

  return { resolver: makeResolver(byId), loadedCount: byId.size, failedIds };
}

function makeResolver(byId: ReadonlyMap<string, SkillMdRecord>): SyncSkillResolver {
  return {
    resolve(ref: SkillRef): SkillMdRecord | null {
      return byId.get(ref.id) ?? null;
    },
  };
}

function safeIsDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
