/**
 * AgentBudgetTracker — Manages token budget allocation across 3 pools:
 * base (primary work), negotiable (extensions), delegation (child agents).
 *
 * Tracks consumption, enforces limits, and derives child budgets for delegation.
 * Uses performance.now() for precise duration tracking.
 */
import type { AgentBudget } from '../protocol.ts';
import type { RoutingDecision } from '../types.ts';
import type { AgentContract } from '../../core/agent-contract.ts';

/** Configurable budget allocation ratios and turn limits. */
export interface AgentBudgetConfig {
  /** Fraction of total budget for primary work. Default: 0.6 */
  baseRatio: number;
  /** Fraction for negotiable extensions. Default: 0.25 */
  negotiableRatio: number;
  /** Fraction reserved for delegation to child agents. Default: 0.15 */
  delegationRatio: number;
  /** Max turns by routing level. Default: { 1: 15, 2: 30, 3: 50 } */
  maxTurnsByLevel: Record<number, number>;
}

export const AGENT_BUDGET_DEFAULTS: AgentBudgetConfig = {
  baseRatio: 0.6,
  negotiableRatio: 0.25,
  delegationRatio: 0.15,
  maxTurnsByLevel: { 1: 15, 2: 30, 3: 50 },
};

/** Session-level tool call limits per routing level (§5: 0/0/20/50). */
const MAX_TOOL_CALLS_BY_LEVEL: Record<number, number> = { 0: 0, 1: 0, 2: 20, 3: 50 };

/**
 * Maximum peer consultations allowed per session. Hardcoded (not part
 * of the IPC-serialized AgentBudget) because consultations are a
 * fixed-cost flat primitive — no graduated pool, no budget negotiation.
 * Set conservatively because each consult is a full LLM call.
 */
const MAX_CONSULTATIONS_PER_SESSION = 3;

export class AgentBudgetTracker {
  private readonly budget: AgentBudget;
  private extensionRequestCount = 0;
  private baseConsumed = 0;
  private negotiableGranted = 0;
  private delegationConsumed = 0;
  private turnsUsed = 0;
  private toolCallsUsed = 0;
  /**
   * Agent Conversation — consult_peer session counter. Unlike delegation,
   * consultations have NO token pool of their own (each consult's output
   * is charged against the base pool via recordConsultation). We just
   * count calls to enforce MAX_CONSULTATIONS_PER_SESSION.
   */
  private consultationCount = 0;
  private readonly startTime: number;

  constructor(budget: AgentBudget) {
    this.budget = budget;
    this.startTime = performance.now();
  }

  /** Factory: create from routing decision with sensible defaults */
  static fromRouting(routing: RoutingDecision, contextWindow: number): AgentBudgetTracker {
    const maxToolCalls = MAX_TOOL_CALLS_BY_LEVEL[routing.level] ?? 50;
    const budget: AgentBudget = {
      maxTokens: routing.budgetTokens,
      maxTurns: routing.level === 1 ? 15 : routing.level === 2 ? 30 : 50,
      maxDurationMs: routing.latencyBudgetMs,
      contextWindow,
      base: Math.floor(routing.budgetTokens * 0.6),
      negotiable: Math.floor(routing.budgetTokens * 0.25),
      delegation: Math.floor(routing.budgetTokens * 0.15),
      maxExtensionRequests: 3,
      maxToolCallsPerTurn: Math.min(10, maxToolCalls),
      maxToolCalls,
      delegationDepth: 0,
      maxDelegationDepth: routing.level >= 3 ? 2 : 1,
    };
    return new AgentBudgetTracker(budget);
  }

  /** Factory: create from an AgentContract (K1.2) — mirrors fromRouting but sourced from immutable contract. */
  static fromContract(contract: AgentContract, contextWindow = 128_000): AgentBudgetTracker {
    const budget: AgentBudget = {
      maxTokens: contract.tokenBudget,
      maxTurns: contract.maxTurns,
      maxDurationMs: contract.timeLimitMs,
      contextWindow,
      base: Math.floor(contract.tokenBudget * 0.6),
      negotiable: Math.floor(contract.tokenBudget * 0.25),
      delegation: Math.floor(contract.tokenBudget * 0.15),
      maxExtensionRequests: 3,
      maxToolCallsPerTurn: contract.maxToolCallsPerTurn,
      maxToolCalls: contract.maxToolCalls,
      delegationDepth: 0,
      maxDelegationDepth: contract.routingLevel >= 3 ? 2 : 1,
    };
    return new AgentBudgetTracker(budget);
  }

  /** Can the session continue? Checks turns, tokens, and duration. */
  canContinue(): boolean {
    return (
      this.turnsUsed < this.budget.maxTurns &&
      this.baseConsumed < this.budget.base + this.negotiableGranted &&
      performance.now() - this.startTime < this.budget.maxDurationMs
    );
  }

  /** Can delegation be attempted? */
  canDelegate(): boolean {
    return this.budget.delegationDepth < this.budget.maxDelegationDepth && this.delegationRemaining > 0;
  }

  /**
   * Can a peer consultation be attempted?
   *
   * Checks the per-session cap (MAX_CONSULTATIONS_PER_SESSION) AND
   * that the base pool has enough headroom to charge the consultation
   * tokens. Consultations share the base pool rather than having
   * their own to keep budget plumbing simple — they are expected to
   * be rare (at most 3 per session).
   */
  canConsult(): boolean {
    if (this.consultationCount >= MAX_CONSULTATIONS_PER_SESSION) return false;
    // Require at least 500 tokens of base-pool headroom so a consult
    // can't starve the primary work that follows.
    return this.budget.base + this.negotiableGranted - this.baseConsumed >= 500;
  }

  /** Record tokens consumed in a turn */
  recordTurn(tokensConsumed: number): void {
    this.turnsUsed++;
    this.baseConsumed += tokensConsumed;
  }

  /**
   * Record a completed peer consultation. Charges the consumed tokens
   * against the base pool and increments the per-session counter.
   */
  recordConsultation(tokensConsumed: number): void {
    this.consultationCount++;
    this.baseConsumed += tokensConsumed;
  }

  /** Current number of peer consultations used in this session. */
  get consultationsUsed(): number {
    return this.consultationCount;
  }

  /** Remaining peer consultations allowed in this session. */
  get remainingConsultations(): number {
    return Math.max(0, MAX_CONSULTATIONS_PER_SESSION - this.consultationCount);
  }

  /** Record tool calls consumed in a turn (§5 session-level enforcement). */
  recordToolCalls(count: number): void {
    this.toolCallsUsed += count;
  }

  /** Remaining tool calls allowed in this session. */
  get remainingToolCalls(): number {
    return Math.max(0, this.budget.maxToolCalls - this.toolCallsUsed);
  }

  /** Request more tokens from negotiable pool */
  requestExtension(tokens: number): { granted: number; remaining: number } {
    if (this.extensionRequestCount >= this.budget.maxExtensionRequests) {
      return { granted: 0, remaining: 0 };
    }

    const negotiableRemaining = this.budget.negotiable - this.negotiableGranted;
    const granted = Math.min(tokens, negotiableRemaining * 0.5);
    this.negotiableGranted += granted;
    this.extensionRequestCount++;

    return { granted, remaining: this.budget.negotiable - this.negotiableGranted };
  }

  /** Derive a child budget for delegation */
  deriveChildBudget(requestedTokens?: number): AgentBudget {
    const delegationRemaining = this.budget.delegation - this.delegationConsumed;
    const cap = Math.floor(delegationRemaining * 0.5);
    const allocated = Math.min(requestedTokens ?? Math.floor(delegationRemaining * 0.3), cap);

    this.delegationConsumed += allocated;

    return {
      maxTokens: allocated,
      maxTurns: Math.floor(this.budget.maxTurns * 0.5),
      maxDurationMs: Math.floor(this.budget.maxDurationMs * 0.5),
      contextWindow: this.budget.contextWindow,
      base: Math.floor(allocated * 0.6),
      negotiable: Math.floor(allocated * 0.3),
      delegation: Math.floor(allocated * 0.1),
      maxExtensionRequests: 1,
      maxToolCallsPerTurn: this.budget.maxToolCallsPerTurn,
      maxToolCalls: this.budget.maxToolCalls,
      delegationDepth: this.budget.delegationDepth + 1,
      maxDelegationDepth: this.budget.maxDelegationDepth,
    };
  }

  /** Return unused delegation tokens after child completes */
  returnUnusedDelegation(reserved: number, actual: number): void {
    const refund = Math.max(0, reserved - actual);
    this.delegationConsumed = Math.max(0, this.delegationConsumed - refund);
  }

  /** Remaining time in ms */
  remainingMs(): number {
    return Math.max(0, this.budget.maxDurationMs - (performance.now() - this.startTime));
  }

  /** Serializable snapshot for IPC */
  toSnapshot(): AgentBudget {
    return {
      maxTokens: this.budget.maxTokens,
      maxTurns: this.budget.maxTurns,
      maxDurationMs: this.budget.maxDurationMs,
      contextWindow: this.budget.contextWindow,
      base: this.budget.base - this.baseConsumed,
      negotiable: this.budget.negotiable - this.negotiableGranted,
      delegation: this.budget.delegation - this.delegationConsumed,
      maxExtensionRequests: this.budget.maxExtensionRequests - this.extensionRequestCount,
      maxToolCallsPerTurn: this.budget.maxToolCallsPerTurn,
      maxToolCalls: this.budget.maxToolCalls - this.toolCallsUsed,
      delegationDepth: this.budget.delegationDepth,
      maxDelegationDepth: this.budget.maxDelegationDepth,
    };
  }

  /** Get delegation-remaining tokens */
  get delegationRemaining(): number {
    return this.budget.delegation - this.delegationConsumed;
  }
}
