/**
 * MCP JSON loader — Claude-Code-compatible `.mcp.json` parser (G11 — interop).
 *
 * Loads MCP server definitions from the project's `.mcp.json` (workspace root)
 * so users coming from Claude Code or thClaws can keep their existing config
 * file without rewriting it as `vinyan.json` `network.mcp.client_servers`.
 *
 * Format (matches the `mcpServers` shape Anthropic ships and thClaws honors):
 *   {
 *     "mcpServers": {
 *       "github": {
 *         "command": "npx",
 *         "args": ["-y", "@modelcontextprotocol/server-github"]
 *       },
 *       "fs": {
 *         "type": "stdio",
 *         "command": "/usr/local/bin/mcp-fs",
 *         "args": ["--root", "/srv"]
 *       }
 *     }
 *   }
 *
 * Trust level: not present in the upstream format, so we default to
 * `'untrusted'` — the safest setting under A5 (Tiered Trust). Users who
 * want Vinyan-specific trust must declare the server in `vinyan.json`
 * (which wins on name conflict — the caller merges, see factory.ts).
 *
 * The loader never throws on malformed input — it logs a warning and returns
 * an empty list so a broken `.mcp.json` cannot block orchestrator startup.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod/v4';

/**
 * Subset of the Claude-Code `mcpServers` schema that Vinyan understands.
 * Unknown fields are tolerated (passthrough, with warning) so future Anthropic
 * extensions don't break Vinyan startup.
 */
const McpServerEntrySchema = z
  .object({
    type: z.enum(['stdio']).optional(),
    command: z.string().min(1),
    args: z.array(z.string()).optional(),
  })
  .passthrough();

const McpJsonSchema = z
  .object({
    mcpServers: z.record(z.string(), McpServerEntrySchema).optional(),
  })
  .passthrough();

export interface LoadedMcpServer {
  name: string;
  command: string;
  args?: string[];
  /** Always `'untrusted'` for `.mcp.json` entries — declare in vinyan.json to upgrade. */
  trustLevel: 'untrusted';
  /** File path the entry came from — used for diagnostics. */
  source: string;
}

export interface LoadMcpJsonResult {
  servers: LoadedMcpServer[];
  /** Files attempted, in load order. Useful for tracing in tests. */
  attemptedPaths: string[];
  /** Files that were present but malformed. */
  invalidPaths: string[];
}

/**
 * Read all `.mcp.json` files Vinyan honors, in precedence order.
 *
 * Order (later files override earlier on name conflict):
 *   1. `<workspace>/.mcp.json`           (project-level, primary)
 *   2. `<workspace>/.claude/mcp.json`    (Claude Code legacy nested location)
 *
 * NOTE: home-level `~/.claude/mcp.json` is intentionally NOT read — Vinyan
 * keeps user-global MCP config in `vinyan.json` to avoid accidental cross-
 * project tool exposure. If a user wants global servers, they declare them
 * in their personal vinyan.json.
 */
export function loadMcpJsonServers(workspace: string): LoadMcpJsonResult {
  const candidates = [join(workspace, '.mcp.json'), join(workspace, '.claude', 'mcp.json')];
  const seen = new Map<string, LoadedMcpServer>(); // name → server (last wins)
  const attemptedPaths: string[] = [];
  const invalidPaths: string[] = [];

  for (const path of candidates) {
    if (!existsSync(path)) continue;
    attemptedPaths.push(path);
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(path, 'utf8'));
    } catch (err) {
      invalidPaths.push(path);
      console.warn(`[vinyan] .mcp.json parse error at ${path}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    const parsed = McpJsonSchema.safeParse(raw);
    if (!parsed.success) {
      invalidPaths.push(path);
      console.warn(`[vinyan] .mcp.json schema mismatch at ${path}: ${parsed.error.message}`);
      continue;
    }
    const serverMap = parsed.data.mcpServers ?? {};
    for (const [name, entry] of Object.entries(serverMap)) {
      seen.set(name, {
        name,
        command: entry.command,
        ...(entry.args ? { args: entry.args } : {}),
        trustLevel: 'untrusted',
        source: path,
      });
    }
  }

  return {
    servers: Array.from(seen.values()),
    attemptedPaths,
    invalidPaths,
  };
}
