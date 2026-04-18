/**
 * Phase 7d-2: Permission config loader — reads `.vinyan/permissions.json`,
 * validates with Zod, returns a typed `PermissionConfig`. A missing file
 * yields the empty default so the DSL is opt-in per workspace.
 *
 * Results are cached per workspace path, mirroring `hook-loader.ts`.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { EMPTY_PERMISSION_CONFIG, type PermissionConfig, PermissionConfigSchema } from './permission-schema.ts';

const cache = new Map<string, PermissionConfig>();

/** Clear cached permission configs. Intended for tests only. */
export function clearPermissionConfigCache(): void {
  cache.clear();
}

/**
 * Load `.vinyan/permissions.json` from the given workspace. Returns the
 * empty default config when the file is absent. Throws with a clear message
 * on invalid JSON or a schema violation.
 */
export function loadPermissionConfig(workspacePath: string): PermissionConfig {
  const cached = cache.get(workspacePath);
  if (cached) return cached;

  const configPath = join(workspacePath, '.vinyan', 'permissions.json');
  if (!existsSync(configPath)) {
    cache.set(workspacePath, EMPTY_PERMISSION_CONFIG);
    return EMPTY_PERMISSION_CONFIG;
  }

  const raw = readFileSync(configPath, 'utf-8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`Invalid JSON in .vinyan/permissions.json: ${e instanceof Error ? e.message : String(e)}`);
  }

  const result = PermissionConfigSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid .vinyan/permissions.json:\n${issues}`);
  }

  cache.set(workspacePath, result.data);
  return result.data;
}
