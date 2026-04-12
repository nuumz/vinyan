/**
 * Phase 7e: MCP → Vinyan tool adapter.
 *
 * Bridges tools discovered via `MCPClientPool` into the Vinyan `Tool`
 * interface so they can be surfaced in the agent loop's tool manifest
 * and executed through the normal per-call pipeline (contract auth →
 * permission DSL → hooks → executor → guardrails → post-hooks).
 *
 * Namespacing: every MCP tool is exposed as `mcp__{server}__{tool}` —
 * identical to Claude Code's convention. This keeps MCP tools in their
 * own namespace and lets agent contracts grant them with a single
 * `mcp_call` capability rather than enumerating every possible tool.
 *
 * Execution routes through `MCPClientPool.callToolVerified` so the
 * result is passed through the Oracle Gate (A5 tiered trust), then
 * unwrapped into a Vinyan `ToolResult` for the agent loop.
 *
 * Unlike shell/file tools, MCP tools never touch the workspace
 * directly, so `category: 'delegation'` + `sideEffect: true`
 * (conservatively — the remote side may or may not mutate state and
 * the adapter can't tell). `minIsolationLevel: 2` matches the default
 * contract level at which `mcp_call` is granted.
 */

import type { OracleVerdict } from '../../core/types.ts';
import type { MCPClientPool, MCPGate, VerifiedToolResult } from '../../mcp/client.ts';
import type { MCPTool } from '../../mcp/types.ts';
import type { Tool, ToolDescriptor } from '../tools/tool-interface.ts';
import type { ToolResult } from '../types.ts';

/** Separator chosen to mirror Claude Code and avoid collision with built-in names. */
export const MCP_TOOL_NAME_SEPARATOR = '__';
export const MCP_TOOL_NAME_PREFIX = 'mcp';

/**
 * Compose the public name for an MCP tool. The namespace prefix makes it
 * trivial to classify MCP calls in `authorizeToolCall` and in permission
 * DSL rules without guessing at server-provided names.
 */
export function mcpToolName(serverName: string, toolName: string): string {
  return `${MCP_TOOL_NAME_PREFIX}${MCP_TOOL_NAME_SEPARATOR}${serverName}${MCP_TOOL_NAME_SEPARATOR}${toolName}`;
}

/**
 * Parse an `mcp__{server}__{tool}` name back into its parts. Returns
 * `null` for any name that isn't namespaced this way so callers can
 * cheaply test `parseMcpToolName(x) !== null` to ask "is this MCP?".
 */
export function parseMcpToolName(name: string): { serverName: string; toolName: string } | null {
  if (!name.startsWith(`${MCP_TOOL_NAME_PREFIX}${MCP_TOOL_NAME_SEPARATOR}`)) return null;
  const rest = name.slice(MCP_TOOL_NAME_PREFIX.length + MCP_TOOL_NAME_SEPARATOR.length);
  // Server names cannot contain the separator, but tool names might — we
  // only split on the *first* occurrence so `mcp__fs__foo__bar` yields
  // server="fs", tool="foo__bar" which is what the server advertised.
  const sepIdx = rest.indexOf(MCP_TOOL_NAME_SEPARATOR);
  if (sepIdx <= 0) return null;
  return {
    serverName: rest.slice(0, sepIdx),
    toolName: rest.slice(sepIdx + MCP_TOOL_NAME_SEPARATOR.length),
  };
}

/** Minimal shape we need from `MCPClientPool` so tests can mock it. */
export interface McpPool {
  listAllTools(): Promise<Array<{ serverName: string; tool: MCPTool }>>;
  callToolVerified(
    serverName: string,
    toolName: string,
    args: Record<string, unknown>,
    gate: MCPGate,
    workspace: string,
  ): Promise<VerifiedToolResult>;
}

/**
 * Convert an MCP tool's `inputSchema` (arbitrary JSON-Schema) into the
 * structured `{type:'object', properties, required}` shape Vinyan's
 * `ToolDescriptor` expects. MCP servers *usually* advertise object
 * schemas but the MCP spec only requires a record — so we defensively
 * handle non-object cases by wrapping them as a single `input` param
 * the agent can set to anything. The alternative — throwing — would
 * poison the whole pool if one server advertised an unusual schema.
 */
function mcpSchemaToDescriptorSchema(inputSchema: Record<string, unknown>): ToolDescriptor['inputSchema'] {
  const type = typeof inputSchema.type === 'string' ? inputSchema.type : undefined;
  const rawProps = inputSchema.properties;
  const rawRequired = inputSchema.required;

  if (type === 'object' && rawProps && typeof rawProps === 'object') {
    const properties: ToolDescriptor['inputSchema']['properties'] = {};
    for (const [key, propUnknown] of Object.entries(rawProps as Record<string, unknown>)) {
      const prop = (propUnknown ?? {}) as Record<string, unknown>;
      const propType = typeof prop.type === 'string' ? prop.type : 'string';
      const description = typeof prop.description === 'string' ? prop.description : '';
      const entry: ToolDescriptor['inputSchema']['properties'][string] = {
        type: propType,
        description,
      };
      if (Array.isArray(prop.enum)) {
        entry.enum = prop.enum.filter((v): v is string => typeof v === 'string');
      }
      if (prop.items && typeof prop.items === 'object') {
        const itemType =
          typeof (prop.items as Record<string, unknown>).type === 'string'
            ? ((prop.items as Record<string, unknown>).type as string)
            : 'string';
        entry.items = { type: itemType };
      }
      properties[key] = entry;
    }
    const required = Array.isArray(rawRequired) ? rawRequired.filter((r): r is string => typeof r === 'string') : [];
    return { type: 'object', properties, required };
  }

  // Non-object schema (rare) — expose a single `input` field typed
  // broadly so the agent can still forward whatever the server wants.
  return {
    type: 'object',
    properties: {
      input: {
        type: 'string',
        description: 'Raw MCP tool input (server did not advertise an object schema)',
      },
    },
    required: [],
  };
}

/**
 * Translate a `VerifiedToolResult` into a Vinyan `ToolResult`. The
 * OracleVerdict's `verified` flag decides success/error; evidence
 * snippets are concatenated as the visible output so the agent sees
 * whatever the MCP server returned. We avoid surfacing Oracle Gate
 * metadata (confidence, caveats) here — the loop already emits
 * `agent:tool_executed` for observability and stuffing more into
 * `output` just inflates the agent's prompt.
 */
export function verifiedResultToToolResult(callId: string, toolName: string, verified: VerifiedToolResult): ToolResult {
  const verdict: OracleVerdict = verified.verdict;
  const output = verdict.evidence
    .map((e) => e.snippet)
    .filter((s) => s.length > 0)
    .join('\n');
  const status: ToolResult['status'] = verdict.verified ? 'success' : 'error';
  const result: ToolResult = {
    callId,
    tool: toolName,
    status,
    output: output || '(empty MCP response)',
    durationMs: verdict.durationMs,
  };
  if (!verdict.verified && verdict.reason) {
    result.error = verdict.reason;
  }
  return result;
}

/**
 * Build a single Vinyan `Tool` wrapping one MCP tool. The returned
 * tool's `execute` captures the pool / gate / workspace so the agent
 * loop can call it uniformly alongside built-ins.
 */
export function createMcpTool(
  pool: McpPool,
  serverName: string,
  mcpTool: MCPTool,
  gate: MCPGate,
  workspace: string,
): Tool {
  const publicName = mcpToolName(serverName, mcpTool.name);
  const descriptorSchema = mcpSchemaToDescriptorSchema(mcpTool.inputSchema);
  const description = mcpTool.description || `MCP tool from '${serverName}'`;

  return {
    name: publicName,
    description,
    // L2 and up may invoke MCP tools. L0/L1 are read-only reflex/heuristic
    // tiers and never have the `mcp_call` capability.
    minIsolationLevel: 2,
    category: 'delegation',
    // Conservative: assume MCP servers may mutate external state. The
    // agent loop treats side-effecting tools as mutating which routes
    // them through the serialized execution path.
    sideEffect: true,
    descriptor(): ToolDescriptor {
      return {
        name: publicName,
        description,
        inputSchema: descriptorSchema,
        category: 'delegation',
        sideEffect: true,
        minRoutingLevel: 2,
        toolKind: 'executable',
      };
    },
    async execute(params, _context) {
      const callId = (params.callId as string) ?? '';
      // Strip internal bookkeeping before forwarding to the MCP server.
      const forwarded: Record<string, unknown> = { ...params };
      delete forwarded.callId;
      try {
        const verified = await pool.callToolVerified(serverName, mcpTool.name, forwarded, gate, workspace);
        return verifiedResultToToolResult(callId, publicName, verified);
      } catch (err) {
        return {
          callId,
          tool: publicName,
          status: 'error',
          error: err instanceof Error ? err.message : String(err),
          durationMs: 0,
        };
      }
    },
  };
}

/**
 * Enumerate every tool on every connected MCP server and wrap each as
 * a Vinyan `Tool`. The resulting map is suitable for passing to
 * `ToolExecutor`'s `additionalTools` constructor parameter and to
 * `manifestFor(routing, extraTools)`.
 *
 * Discovery failures (one server down, one malformed schema) are
 * swallowed and logged — the whole point of the pool is that one bad
 * server shouldn't take down the rest of the agent's tool surface.
 */
export async function buildMcpToolMap(pool: McpPool, gate: MCPGate, workspace: string): Promise<Map<string, Tool>> {
  const tools = new Map<string, Tool>();
  let entries: Array<{ serverName: string; tool: MCPTool }>;
  try {
    entries = await pool.listAllTools();
  } catch {
    return tools;
  }
  for (const { serverName, tool: mcpTool } of entries) {
    try {
      const adapted = createMcpTool(pool, serverName, mcpTool, gate, workspace);
      if (tools.has(adapted.name)) {
        // Name collision across servers — first one wins. This is
        // pathological (two servers with the same {name,tool}) but we
        // don't want to crash the whole pool over it.
        continue;
      }
      tools.set(adapted.name, adapted);
    } catch {
      // Skip malformed tools rather than failing the whole build.
    }
  }
  return tools;
}

/**
 * Re-export the structural pool shape for consumers that want to
 * satisfy the adapter interface without depending directly on
 * `MCPClientPool`. The concrete class already matches this shape.
 */
export type { MCPClientPool };
