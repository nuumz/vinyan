/**
 * Config Loader — reads vinyan.json, validates with Zod, returns typed config.
 */
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { VinyanConfigSchema, type VinyanConfig } from "./schema.ts";

/**
 * Load vinyan.json from workspace root. Validates and applies defaults.
 * @throws Error with clear Zod error messages on invalid config.
 */
export function loadConfig(workspacePath: string): VinyanConfig {
  const configPath = join(workspacePath, "vinyan.json");

  if (!existsSync(configPath)) {
    // Return defaults when no config file exists
    return VinyanConfigSchema.parse({});
  }

  const raw = readFileSync(configPath, "utf-8");

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`Invalid JSON in vinyan.json: ${e instanceof Error ? e.message : String(e)}`);
  }

  const result = VinyanConfigSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid vinyan.json:\n${issues}`);
  }

  return result.data;
}
