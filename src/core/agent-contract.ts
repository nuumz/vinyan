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
import type { RoutingDecision } from '../orchestrator/types.ts';
import type { TaskInput } from '../orchestrator/types.ts';

// ── Capability Schema ───────────────────────────────────────────────

/** Tool-level capability scope — what an agent is allowed to do. */
export const CapabilitySchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('file_read'), paths: z.array(z.string()) }),
  z.object({ type: z.literal('file_write'), paths: z.array(z.string()) }),
  z.object({ type: z.literal('shell_exec'), commands: z.array(z.string()) }),
  z.object({ type: z.literal('shell_read'), commands: z.array(z.string()) }),
  z.object({ type: z.literal('llm_call'), providers: z.array(z.string()) }),
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
});

export type AgentContract = z.infer<typeof AgentContractSchema>;

// ── Default Capabilities per Routing Level (A6: least privilege) ────

const MAX_TOOL_CALLS_BY_LEVEL: Record<number, number> = { 0: 0, 1: 0, 2: 20, 3: 50 };

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
    { type: 'shell_exec', commands: ['bun', 'tsc', 'biome'] },
    { type: 'shell_read', commands: ['**'] },
    { type: 'llm_call', providers: ['*'] },
  ],
  3: [
    // L3 deliberative — full access
    { type: 'file_read', paths: ['**'] },
    { type: 'file_write', paths: ['**'] },
    { type: 'shell_exec', commands: ['**'] },
    { type: 'shell_read', commands: ['**'] },
    { type: 'llm_call', providers: ['*'] },
  ],
};

// ── Contract Factory ────────────────────────────────────────────────

/**
 * Create an immutable AgentContract from a routing decision.
 * Deterministic: same inputs → same contract (A3).
 */
export function createContract(task: TaskInput, routing: RoutingDecision): AgentContract {
  const level = routing.level;
  const maxToolCalls = MAX_TOOL_CALLS_BY_LEVEL[level] ?? 50;
  return {
    taskId: task.id,
    routingLevel: level,
    tokenBudget: routing.budgetTokens,
    timeLimitMs: routing.latencyBudgetMs,
    maxToolCalls,
    maxToolCallsPerTurn: Math.min(10, maxToolCalls),
    maxTurns: level === 1 ? 15 : level === 2 ? 30 : 50,
    maxEscalations: 3,
    capabilities: DEFAULT_CAPABILITIES[level] ?? [],
    onViolation: level <= 1 ? 'kill' : 'warn_then_kill',
    violationTolerance: level <= 1 ? 0 : 2,
    issuedAt: Date.now(),
    immutable: true,
  };
}
