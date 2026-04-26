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
 * Unknown fields are tolerated via Zod `passthrough` so future Anthropic
 * extensions don't break Vinyan startup. Note: passthrough silently keeps
 * unknown keys; the loader does NOT log per-key warnings — only top-level
 * parse / schema failures emit a warning.
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
  /**
   * Default trust tier for `.mcp.json` entries — always `'untrusted'`. Declare
   * the server in `vinyan.json` `network.mcp.client_servers` to upgrade.
   *
   * Named `defaultTrust` (not `trustLevel`) deliberately — the rest of the MCP
   * stack uses `MCPClientConfig.trustLevel: McpSourceZone` (`'local' |
   * 'network' | 'remote'`), and a field named `trustLevel` carrying a different
   * vocabulary on this interface would be a footgun for future readers.
   */
  defaultTrust: 'untrusted';
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
        defaultTrust: 'untrusted',
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

/**
 * Merge `.mcp.json` servers (loaded above) with the vinyan.json
 * `network.mcp.client_servers` list. Per-server fields are preserved across
 * the merge — vinyan.json overrides only `command` and trust tier; `args`
 * coming from `.mcp.json` are kept intact since the vinyan.json schema
 * doesn't carry an `args` field today and silently dropping them would
 * break entries like `npx -y @modelcontextprotocol/server-github`.
 *
 * Pure function — no I/O. Exported for unit testing the precedence rules
 * without spinning up the full orchestrator factory.
 *
 * @param mcpJsonServers - parsed `.mcp.json` entries (`defaultTrust` is always
 *                         `'untrusted'`; merged `trustLevel` is set from
 *                         `defaultZone`)
 * @param vinyanClientServers - declared `network.mcp.client_servers` list
 * @param trustMap - mapping from `trust_level` string → McpSourceZone string
 *                  (factory.ts injects the canonical map; tests can pass any).
 */
export function mergeMcpServerSources<TZone extends string>(
  mcpJsonServers: readonly LoadedMcpServer[],
  vinyanClientServers: ReadonlyArray<{ name: string; command: string; trust_level?: string }>,
  trustMap: Readonly<Record<string, TZone>>,
  defaultZone: TZone,
): Array<{ name: string; command: string; args?: string[]; trustLevel: TZone }> {
  const merged = new Map<string, { name: string; command: string; args?: string[]; trustLevel: TZone }>();

  for (const s of mcpJsonServers) {
    merged.set(s.name, {
      name: s.name,
      command: s.command,
      ...(s.args ? { args: s.args } : {}),
      trustLevel: defaultZone,
    });
  }

  for (const s of vinyanClientServers) {
    const existing = merged.get(s.name);
    merged.set(s.name, {
      name: s.name,
      command: s.command,
      ...(existing?.args ? { args: existing.args } : {}),
      trustLevel: trustMap[s.trust_level ?? 'untrusted'] ?? defaultZone,
    });
  }

  return Array.from(merged.values());
}

/**
 * Shape of a bundle-manifest MCP server — same as `LoadedMcpServer` so
 * `dedupePreVinyanSources()` can accept either source uniformly. Defined
 * inline (not imported from `../plugin/`) so this module stays free of
 * plugin-layer dependencies.
 */
export interface BundleMcpEntry {
  name: string;
  command: string;
  args?: string[];
  source: string;
}

/**
 * Dedup `.mcp.json` entries with bundle-manifest entries before they hit
 * `mergeMcpServerSources()`. Bundle wins on name conflict — bundles are
 * the higher-level packaging unit and operators expect the curated entry
 * to override a raw `.mcp.json` declaration when both are present.
 *
 * Pure function — exported for unit-testing the precedence chain
 * (review #38:761).
 */
export function dedupePreVinyanSources(
  mcpJsonServers: readonly LoadedMcpServer[],
  bundleServers: readonly BundleMcpEntry[],
): LoadedMcpServer[] {
  const merged = new Map<string, LoadedMcpServer>();
  for (const s of mcpJsonServers) merged.set(s.name, s);
  for (const s of bundleServers) {
    merged.set(s.name, {
      name: s.name,
      command: s.command,
      ...(s.args ? { args: s.args } : {}),
      defaultTrust: 'untrusted',
      source: s.source,
    });
  }
  return Array.from(merged.values());
}
