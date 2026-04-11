/**
 * Config Loader — reads vinyan.json, validates with Zod, returns typed config.
 * Caches per workspace path (config doesn't change during a run).
 */
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { type VinyanConfig, VinyanConfigSchema } from './schema.ts';

const configCache = new Map<string, VinyanConfig>();

/** Clear cached configs (for testing). */
export function clearConfigCache(): void {
  configCache.clear();
}

/**
 * Load vinyan.json from workspace root. Validates and applies defaults.
 * Results are cached per workspace path.
 * @throws Error with clear Zod error messages on invalid config.
 */
export function loadConfig(workspacePath: string): VinyanConfig {
  const cached = configCache.get(workspacePath);
  if (cached) return cached;
  const configPath = join(workspacePath, 'vinyan.json');

  if (!existsSync(configPath)) {
    // Return defaults when no config file exists
    const defaults = VinyanConfigSchema.parse({});
    configCache.set(workspacePath, defaults);
    return defaults;
  }

  const raw = readFileSync(configPath, 'utf-8');

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`Invalid JSON in vinyan.json: ${e instanceof Error ? e.message : String(e)}`);
  }

  const result = VinyanConfigSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid vinyan.json:\n${issues}`);
  }

  configCache.set(workspacePath, result.data);
  return result.data;
}
