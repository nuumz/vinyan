/**
 * Phase 7d-1: Hook config loader — reads `.vinyan/hooks.json`, validates
 * with Zod, returns a typed `HookConfig`. A missing file yields the empty
 * default config so hooks are opt-in per workspace.
 *
 * Results are cached per workspace path because hook config doesn't change
 * during a session.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { EMPTY_HOOK_CONFIG, type HookConfig, HookConfigSchema } from './hook-schema.ts';

const cache = new Map<string, HookConfig>();

/** Clear cached hook configs. Intended for tests only. */
export function clearHookConfigCache(): void {
  cache.clear();
}

/**
 * Load `.vinyan/hooks.json` from the given workspace. Returns the empty
 * default config when the file is absent. Throws a `Error` with a clear
 * message on invalid JSON or a schema violation.
 */
export function loadHookConfig(workspacePath: string): HookConfig {
  const cached = cache.get(workspacePath);
  if (cached) return cached;

  const configPath = join(workspacePath, '.vinyan', 'hooks.json');
  if (!existsSync(configPath)) {
    cache.set(workspacePath, EMPTY_HOOK_CONFIG);
    return EMPTY_HOOK_CONFIG;
  }

  const raw = readFileSync(configPath, 'utf-8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`Invalid JSON in .vinyan/hooks.json: ${e instanceof Error ? e.message : String(e)}`);
  }

  const result = HookConfigSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid .vinyan/hooks.json:\n${issues}`);
  }

  cache.set(workspacePath, result.data);
  return result.data;
}
