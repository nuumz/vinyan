import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Map oracle name → module entry point (relative to this file). */
const ORACLE_PATHS: Record<string, string> = {
  "ast-oracle": resolve(__dirname, "ast/index.ts"),
  "type-oracle": resolve(__dirname, "type/index.ts"),
  "dep-oracle": resolve(__dirname, "dep/index.ts"),
  "test-oracle": resolve(__dirname, "test/index.ts"),
  "lint-oracle": resolve(__dirname, "lint/index.ts"),
};

export function getOraclePath(name: string): string | undefined {
  return ORACLE_PATHS[name];
}

export function listOracles(): string[] {
  return Object.keys(ORACLE_PATHS);
}
