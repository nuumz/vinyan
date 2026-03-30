/**
 * Tool Classification — determines whether a tool is mutating or read-only.
 * Read-only tools skip oracle verification (no mutation to verify).
 *
 * A6 Zero-Trust: unknown tools default to mutating (conservative).
 */

const READONLY_TOOLS = new Set([
  "read_file",
  "search_files",
  "list_directory",
  "grep_search",
  "get_diagnostics",
]);

/** Returns true if the tool may mutate files/state. Unknown tools → true (A6 conservative). */
export function isMutatingTool(toolName: string): boolean {
  return !READONLY_TOOLS.has(toolName);
}
