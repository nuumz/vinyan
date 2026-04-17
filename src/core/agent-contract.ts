/**
 * Agent Contract — K1.2 kernel-issued, immutable capability envelope.
 *
 * Formalizes existing budget enforcement (AgentBudgetTracker) into a typed
 * contract with capability scope. Agents can only perform operations
 * explicitly granted by their contract.
 *
 * A3 compliance: contract generation is deterministic (routing level → capabilities).
 * A6 compliance: least privilege — L0 gets nothing, L3 gets everything.
 */
import { z } from 'zod/v4';
import type { RoutingDecision, TaskInput } from '../orchestrator/types.ts';

// ── Capability Schema ───────────────────────────────────────────────

/** Tool-level capability scope — what an agent is allowed to do. */
export const CapabilitySchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('file_read'), paths: z.array(z.string()) }),
  z.object({ type: z.literal('file_write'), paths: z.array(z.string()) }),
  z.object({ type: z.literal('shell_exec'), commands: z.array(z.string()) }),
  z.object({ type: z.literal('shell_read'), commands: z.array(z.string()) }),
  z.object({ type: z.literal('llm_call'), providers: z.array(z.string()) }),
  // Phase 7e: external MCP servers. Scope is the server name (the part
  // between the `mcp__` prefix and the second `__`). `['*']` grants
  // access to every connected MCP server.
  z.object({ type: z.literal('mcp_call'), servers: z.array(z.string()) }),
]);

export type Capability = z.infer<typeof CapabilitySchema>;

// ── Contract Schema ─────────────────────────────────────────────────

export const AgentContractSchema = z.object({
  // Identity
  taskId: z.string(),
  routingLevel: z.number().min(0).max(3),

  // Resource limits (mirrors AgentBudgetTracker)
  tokenBudget: z.number(),
  timeLimitMs: z.number(),
  maxToolCalls: z.number(),
  maxToolCallsPerTurn: z.number(),
  maxTurns: z.number(),
  maxEscalations: z.number().default(3),

  // Capability scope
  capabilities: z.array(CapabilitySchema),

  // Violation policy
  onViolation: z.enum(['kill', 'warn_then_kill', 'degrade']).default('kill'),
  violationTolerance: z.number().default(0),

  // Metadata
  issuedAt: z.number(),
  immutable: z.literal(true).default(true),

  // ACR (Agent Conversation Room) — optional metadata set by RoomDispatcher when
  // the contract is cloned for a room participant. Carries no budget or
  // authorization semantics (those live on `capabilities` / token fields);
  // this is purely for observability and future room-aware tool gating. A6
  // scope is still enforced externally by RoomBlackboard, not by this field.
  roomContext: z
    .object({
      roomId: z.string(),
      participantId: z.string(),
      roleName: z.string(),
      writableBlackboardKeys: z.array(z.string()),
    })
    .optional(),
});

export type AgentContract = z.infer<typeof AgentContractSchema>;

// ── Default Capabilities per Routing Level (A6: least privilege) ────

const MAX_TOOL_CALLS_BY_LEVEL: Record<number, number> = { 0: 0, 1: 5, 2: 20, 3: 50 };

const DEFAULT_CAPABILITIES: Record<number, Capability[]> = {
  0: [], // L0 reflex — no tool access
  1: [
    // L1 heuristic — read-only
    { type: 'file_read', paths: ['**'] },
    { type: 'shell_read', commands: ['cat', 'ls', 'find', 'grep'] },
  ],
  2: [
    // L2 analytical — read + write in workspace
    { type: 'file_read', paths: ['**'] },
    { type: 'file_write', paths: ['src/**', 'tests/**'] },
    { type: 'shell_exec', commands: ['bun', 'tsc', 'biome', 'eslint', 'prettier', 'git', 'open', 'xdg-open'] },
    { type: 'shell_read', commands: ['**'] },
    { type: 'llm_call', providers: ['*'] },
    // Phase 7e: MCP access at L2+. Servers are gated by name but
    // default to wildcard — the connection itself is the access check,
    // since connecting to an MCP server is an operator decision in
    // vinyan.json, not an agent decision.
    { type: 'mcp_call', servers: ['*'] },
  ],
  3: [
    // L3 deliberative — full access
    { type: 'file_read', paths: ['**'] },
    { type: 'file_write', paths: ['**'] },
    { type: 'shell_exec', commands: ['**'] },
    { type: 'shell_read', commands: ['**'] },
    { type: 'llm_call', providers: ['*'] },
    { type: 'mcp_call', servers: ['*'] },
  ],
};

// ── Contract Factory ────────────────────────────────────────────────

/**
 * Per-agent ACL overlay — intersected with routing-level defaults.
 * Intersection only narrows privilege; it never widens it (A6).
 */
export interface AgentAclOverlay {
  /** Whitelist of tool names. When set, ALL capabilities are filtered to only those referencing these tools. */
  allowedTools?: string[];
  /** Blanket disables that strip the matching capability type entirely. */
  capabilityOverrides?: {
    readAny?: boolean;
    writeAny?: boolean;
    network?: boolean;
    shell?: boolean;
  };
}

/**
 * Apply agent ACL to default capabilities — intersection only.
 *
 * Rules (privilege-preserving):
 *   - `allowedTools` → filter shell/mcp capabilities by command/server name
 *   - `capabilityOverrides.shell = false` → drop `shell_exec` + `shell_read`
 *   - `capabilityOverrides.writeAny = false` → drop `file_write`
 *   - `capabilityOverrides.readAny = false` → drop `file_read`
 *   - `capabilityOverrides.network = false` → drop `mcp_call` + `llm_call`
 */
function applyAgentAcl(
  capabilities: Capability[],
  acl?: AgentAclOverlay,
): Capability[] {
  if (!acl) return capabilities;
  const drop = new Set<Capability['type']>();
  const overrides = acl.capabilityOverrides;
  if (overrides?.shell === false) {
    drop.add('shell_exec');
    drop.add('shell_read');
  }
  if (overrides?.writeAny === false) drop.add('file_write');
  if (overrides?.readAny === false) drop.add('file_read');
  if (overrides?.network === false) {
    drop.add('mcp_call');
    drop.add('llm_call');
  }

  let filtered = capabilities.filter((c) => !drop.has(c.type));

  // Whitelist intersection: if allowedTools specified, narrow shell/mcp command lists
  if (acl.allowedTools && acl.allowedTools.length > 0) {
    const tools = new Set(acl.allowedTools);
    filtered = filtered
      .map((c) => {
        if (c.type === 'shell_exec' || c.type === 'shell_read') {
          const narrowed = c.commands.filter((cmd) => tools.has(cmd) || cmd === '**');
          return narrowed.length > 0 ? { ...c, commands: narrowed } : null;
        }
        if (c.type === 'mcp_call') {
          // mcp servers aren't individual tools — keep unless the user wants to narrow by server name explicitly
          return c;
        }
        return c;
      })
      .filter((c): c is Capability => c !== null);
  }

  return filtered;
}

/**
 * Create an immutable AgentContract from a routing decision.
 * Deterministic: same inputs → same contract (A3).
 *
 * Optional `agentAcl` narrows routing-level defaults via intersection —
 * never widens privilege (A6: least privilege preserved).
 */
export function createContract(
  task: TaskInput,
  routing: RoutingDecision,
  agentAcl?: AgentAclOverlay,
): AgentContract {
  const level = routing.level;
  const maxToolCalls = MAX_TOOL_CALLS_BY_LEVEL[level] ?? 50;
  const baseCapabilities = DEFAULT_CAPABILITIES[level] ?? [];
  const capabilities = applyAgentAcl(baseCapabilities, agentAcl);
  return {
    taskId: task.id,
    routingLevel: level,
    tokenBudget: routing.budgetTokens,
    timeLimitMs: routing.latencyBudgetMs,
    maxToolCalls,
    maxToolCallsPerTurn: Math.min(10, maxToolCalls),
    maxTurns: level === 1 ? 15 : level === 2 ? 30 : 50,
    maxEscalations: 3,
    capabilities,
    onViolation: level <= 1 ? 'kill' : 'warn_then_kill',
    violationTolerance: level <= 1 ? 0 : 2,
    issuedAt: Date.now(),
    immutable: true,
  };
}
