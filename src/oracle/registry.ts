import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Oracle registry entry — either a path (bun run) or a custom command. */
export interface OracleRegistryEntry {
  /** Path to TypeScript entry point (for built-in oracles). */
  path?: string;
  /** Custom command string (for polyglot/plugin oracles). Overrides path. */
  command?: string;
  /** Languages this oracle supports. */
  languages?: string[];
  /** Trust tier. */
  tier?: "deterministic" | "heuristic" | "probabilistic" | "speculative";
  /** Transport type — how the oracle is invoked. */
  transport?: "stdio" | "websocket" | "http" | "a2a";
  /** Timeout in ms. */
  timeout_ms?: number;
}

/** Built-in oracle paths (Phase 0-4). */
const BUILTIN_ORACLES: Record<string, OracleRegistryEntry> = {
  "ast-oracle": { path: resolve(__dirname, "ast/index.ts"), languages: ["typescript"], tier: "deterministic" },
  "type-oracle": { path: resolve(__dirname, "type/index.ts"), languages: ["typescript"], tier: "deterministic" },
  "dep-oracle": { path: resolve(__dirname, "dep/index.ts"), languages: ["typescript"], tier: "heuristic" },
  "test-oracle": { path: resolve(__dirname, "test/index.ts"), languages: ["typescript"], tier: "deterministic" },
  "lint-oracle": { path: resolve(__dirname, "lint/index.ts"), languages: ["typescript"], tier: "deterministic" },
};

/** Dynamic oracle registry (Phase 5 — polyglot + plugins). */
const dynamicOracles = new Map<string, OracleRegistryEntry>();

export function getOraclePath(name: string): string | undefined {
  const dynamic = dynamicOracles.get(name);
  if (dynamic?.path) return dynamic.path;
  return BUILTIN_ORACLES[name]?.path;
}

/** Get full registry entry (includes command for polyglot oracles). */
export function getOracleEntry(name: string): OracleRegistryEntry | undefined {
  return dynamicOracles.get(name) ?? BUILTIN_ORACLES[name];
}

export function listOracles(): string[] {
  return [...Object.keys(BUILTIN_ORACLES), ...dynamicOracles.keys()];
}

/**
 * Register a dynamic oracle at runtime (PH5.10).
 * Overrides built-in oracles if the name matches.
 */
export function registerOracle(name: string, entry: OracleRegistryEntry): void {
  dynamicOracles.set(name, entry);
}

/** Remove a dynamically registered oracle. */
export function unregisterOracle(name: string): boolean {
  return dynamicOracles.delete(name);
}

/** List oracles that support a given language. */
export function listOraclesForLanguage(language: string): string[] {
  const result: string[] = [];
  for (const [name, entry] of Object.entries(BUILTIN_ORACLES)) {
    if (entry.languages?.includes(language)) result.push(name);
  }
  for (const [name, entry] of dynamicOracles) {
    if (entry.languages?.includes(language)) result.push(name);
  }
  return result;
}

/** Reset dynamic registry (for testing). */
export function clearDynamicOracles(): void {
  dynamicOracles.clear();
}
