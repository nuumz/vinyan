/**
 * Soul Loader — reads per-agent soul.md from disk.
 *
 * Path resolution:
 *   1. Explicit `soul_path` from config (absolute or workspace-relative)

 *   2. Default: `<workspace>/.vinyan/souls/<id>.soul.md` (Phase 2 unified)
 *
 * Returns null if no file exists on disk (caller falls back to built-in soul).
 *
 * Size cap: 50 KB per file — matches instruction-loader.ts limit.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

const MAX_SOUL_SIZE = 50_000;

/** Cache by absolute path → { hash, content } to avoid repeated reads. */
const soulCache = new Map<string, { contentHash: string; content: string }>();

/**
 * Load an agent's soul from disk. Returns null when no file exists.
 * Content-hash cached so repeated loads across the same process are free.
 */
export function loadAgentSoul(workspace: string, agentId: string, soulPath?: string): string | null {
  const path = resolveSoulPath(workspace, agentId, soulPath);
  if (!existsSync(path)) return null;

  try {
    const stat = statSync(path);
    if (stat.size > MAX_SOUL_SIZE) {
      console.warn(`[soul-loader] Soul file for agent '${agentId}' exceeds ${MAX_SOUL_SIZE} bytes — skipping`);
      return null;
    }

    const cached = soulCache.get(path);
    const content = readFileSync(path, 'utf-8');

    // Quick change detection via content hash
    const contentHash = quickHash(content);
    if (cached && cached.contentHash === contentHash) {
      return cached.content;
    }

    soulCache.set(path, { contentHash, content });
    return content;
  } catch {
    return null;
  }
}

/** Resolve the absolute path of an agent's soul file. */
export function resolveSoulPath(workspace: string, agentId: string, soulPath?: string): string {
  // Phase 2: unified path with SoulStore. Explicit soulPath from config still wins.
  if (soulPath) {
    return isAbsolute(soulPath) ? soulPath : join(workspace, soulPath);
  }
  return join(workspace, '.vinyan', 'souls', `${agentId}.soul.md`);
}

/** Clear the in-process soul cache (testing / config reload). */
export function clearSoulCache(): void {
  soulCache.clear();
}

/** Lightweight content hash — djb2. Good enough for cache invalidation. */
function quickHash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = (h * 33) ^ s.charCodeAt(i);
  }
  return (h >>> 0).toString(16);
}
