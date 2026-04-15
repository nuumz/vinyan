/**
 * Agent Loop — stateless async function that manages a multi-turn agentic session.
 *
 * Spawns an agent-worker-entry subprocess, manages budget/overlay/tools,
 * and returns a WorkerLoopResult compatible with core-loop.ts verification.
 *
 * Source of truth: implementation-plan §6.3, protocol.ts (IPC schemas)
 * Axioms: A3 (deterministic governance), A6 (zero-trust execution)
 */

import type { AgentContract } from '../../core/agent-contract.ts';
import type { VinyanBus } from '../../core/bus.ts';
import { type SilentAgentConfig, SilentAgentDetector } from '../../guardrails/silent-agent.ts';
import { authorizeToolCall } from '../../security/tool-authorization.ts';
import { buildSubTaskInput, type DelegationDecision, type DelegationRouter } from '../delegation-router.ts';
import { dispatchPostToolUse, dispatchPreToolUse } from '../hooks/hook-dispatcher.ts';
import type { HookConfig } from '../hooks/hook-schema.ts';
import { loadInstructionMemoryForTask } from '../llm/instruction-loader.ts';
import { computeTaskSignature } from '../prediction/self-model.ts';
import type { CachedSkill } from '../types.ts';
import { computeEnvironmentInfo } from '../llm/shared-prompt-sections.ts';
import { wrapReminder } from '../llm/vinyan-reminder.ts';
import { countPendingProposals } from '../memory/memory-proposals.ts';
import { evaluatePermission } from '../permissions/permission-checker.ts';
import type { PermissionConfig } from '../permissions/permission-schema.ts';
import type { DelegationRequest, OrchestratorTurn, WorkerTurn } from '../protocol.ts';
import { scanToolResult } from '../tools/built-in-tools.ts';
import type { Tool, ToolContext } from '../tools/tool-interface.ts';
import { manifestFor } from '../tools/tool-manifest.ts';
import type {
  AgentSessionSummary,
  PerceptualHierarchy,
  PlanTodo,
  PlanTodoInput,
  RoutingDecision,
  TaskDAG,
  TaskInput,
  TaskResult,
  ToolCall,
  ToolResult,
  WorkingMemoryState,
} from '../types.ts';
import { AgentBudgetTracker } from './agent-budget.ts';
import type { IAgentSession } from './agent-session.ts';
import { AgentSession, type SubprocessHandle } from './agent-session.ts';
import { type ProposedMutation, SessionOverlay } from './session-overlay.ts';
import { buildCompactedTranscript, partitionTranscript } from './transcript-compactor.ts';

// ── Exported interfaces ──────────────────────────────────────────────

export interface WorkerLoopResult {
  mutations: ProposedMutation[];
  proposedContent?: string;
  uncertainties: string[];
  tokensConsumed: number;
  /** Prompt caching: total cache-read tokens across all turns in this session. */
  cacheReadTokens?: number;
  /** Prompt caching: total cache-creation tokens across all turns in this session. */
  cacheCreationTokens?: number;
  durationMs: number;
  transcript: WorkerTurn[];
  sessionSummary?: AgentSessionSummary;
  isUncertain: boolean;
  /** Backward compat: core-loop.ts treats WorkerLoopResult like WorkerResult */
  proposedToolCalls: ToolCall[];
  /** When set, indicates a permanent error that should not be retried or escalated. */
  nonRetryableError?: string;
  /**
   * Agent Conversation: true when the agent called attempt_completion with
   * needsUserInput=true, i.e., the `uncertainties` are user-facing questions.
   * The core loop short-circuits this into a TaskResult with
   * status='input-required' (no retry, no escalation).
   */
  needsUserInput?: boolean;
}

export interface AgentLoopDeps {
  workspace: string;
  contextWindow: number;
  agentWorkerEntryPath: string;
  proxySocketPath?: string;
  /** Tool executor for running tools on behalf of the worker */
  toolExecutor: {
    execute(call: ToolCall, context: ToolContext): Promise<ToolResult>;
  };
  /** Guardrails engine for scanning tool results (A6) */
  guardrailsScan?: (input: string) => { blocked: boolean; reason?: string };
  /** Perception compressor */
  compressPerception: (perception: PerceptualHierarchy, contextWindow: number) => PerceptualHierarchy;
  /** EventBus for observability */
  bus?: VinyanBus;
  /** Late-bound task executor for delegation (Phase 6.4) */
  executeTask?: (subInput: TaskInput) => Promise<TaskResult>;
  /** Delegation router for Phase 6.4 */
  delegationRouter?: DelegationRouter;
  /**
   * Agent Conversation §5.6: optional inter-instance coordinator. When
   * provided AND it has live peers, `handleDelegation` will attempt to
   * dispatch the child task to a remote Vinyan instance BEFORE spawning
   * a local subprocess. Any remote failure (no peer, transport error,
   * unparseable response) silently falls through to local execution so
   * remote unavailability never blocks a parent that has a perfectly
   * good local fallback. Absent coordinator → local-only behaviour,
   * identical to pre-§5.6.
   */
  instanceCoordinator?: import('../instance-coordinator.ts').InstanceCoordinator;
  /**
   * Agent Conversation — consult_peer (PR #7): dispatches a single-shot
   * query to a DIFFERENT reasoning engine than the worker's current
   * model (A1 epistemic separation) and returns a structured opinion.
   * Returns `null` when no distinct peer is available (e.g., only one
   * provider is registered). Factory wires this using
   * LLMProviderRegistry.selectByTier in provider-order preference.
   */
  peerConsultant?: (
    request: import('../protocol.ts').PeerConsultRequest,
    workerModelId?: string,
  ) => Promise<import('../protocol.ts').PeerOpinion | null>;
  /** Injectable session factory for testing */
  createSession?: (proc: SubprocessHandle) => IAgentSession;
  /** @deprecated P1-6: Replaced by deterministic structure-preserve compaction. Kept for backwards compat. */
  compactionLlm?: {
    generate(request: {
      messages: Array<{ role: string; content: string }>;
      maxTokens?: number;
    }): Promise<{ content: string; tokensConsumed: number }>;
  };
  /**
   * Phase 7d-1: optional hook config. When set, the agent loop fires
   * PreToolUse hooks before each tool execution and PostToolUse hooks
   * after. Absent / empty config means hooks are inert — the loop behaves
   * exactly as it did in Phase 7c-2.
   */
  hookConfig?: HookConfig;
  /**
   * Phase 7d-2: optional permission DSL config. When set, each tool call
   * is checked against the DSL's deny/allow rules BEFORE Pre-tool hooks
   * run. A `deny` short-circuits the call as a denied result; an `allow`
   * lets it proceed as normal; a `pass` (no matching rule) defers to
   * later layers. Absent config is inert.
   */
  permissionConfig?: PermissionConfig;
  /**
   * Phase 7e: extra tools (e.g. MCP adapters) to surface in the tool
   * manifest. These are merged on top of the built-in tools by
   * `manifestFor`. The same map is assumed to already be registered
   * with the concrete `toolExecutor` so the worker can invoke them;
   * the agent loop only uses it for descriptor discovery.
   */
  extraTools?: ReadonlyMap<string, Tool>;
  /**
   * Book-integration Wave 1.1: worker-level silence watchdog. When set,
   * runAgentLoop instantiates a `SilentAgentDetector` per session and
   * emits `guardrail:silent_agent` events on state transitions (silent
   * after `warnAfterMs`, stalled after `stallAfterMs`). Leave undefined
   * to disable — the loop then behaves exactly as it did before.
   *
   * Axiom-safe: the detector is a rule-based timer (A3), observes the
   * subprocess without relaxing zero-trust (A6), and never inspects
   * reasoning (A1).
   */
  silentAgentConfig?: SilentAgentConfig;
  /**
   * Wave 5b: optional read-only memory API. When present alongside
   * `skillHintsConfig.enabled`, runAgentLoop queries `queryRelatedSkills`
   * for the task signature and injects the top-k successful approaches
   * into the init turn's constraints block so the worker's prompt
   * assembler surfaces them as "Known successful approaches" hints.
   *
   * A1: read-only — the loop never writes back to memory.
   * A3: the hint is informational; the worker's LLM is free to ignore it.
   */
  agentMemory?: import('../agent-memory/agent-memory-api.ts').AgentMemoryAPI;
  /** Wave 5b: skill-hint config. Default off when undefined. */
  skillHintsConfig?: { enabled: boolean; topK: number };
  /**
   * Wave 4: goal-driven agent-loop termination. When enabled, the agent
   * loop runs a deterministic goal-check after the subprocess reports
   * `done` and (if the score falls below threshold) flips the result's
   * `isUncertain` flag so Wave 1's outer goal-loop can pick it up for
   * replanning via Wave 2. This is an observability-forward integration:
   * when disabled (default), no goal check runs and behavior is unchanged.
   *
   * A1: evaluator is a separate component from the agent generator.
   * A3: the decision to flip uncertain is rule-based via completion-gate.
   * A7: no continuation IPC yet — the loop cannot force another subprocess
   *     turn at MVP, so 'continue' collapses to 'reject' (flip to uncertain).
   */
  goalEvaluator?: import('../goal-satisfaction/goal-evaluator.ts').GoalEvaluator;
  goalTerminationConfig?: {
    enabled: boolean;
    maxContinuations: number;
    continuationBudgetFraction: number;
    goalSatisfactionThreshold: number;
  };
}

// ── Session Progress Tracker ────────────────────────────────────────

/**
 * Stable JSON stringifier for duplicate-detection keys.
 * Recursively sorts object keys so `{a:1,b:2}` and `{b:2,a:1}` produce identical strings.
 * This is critical because tool calls reconstructed from JSON may have non-deterministic
 * key order (e.g., when merged from multiple sources), and duplicate detection must match
 * semantically identical calls regardless of key ordering.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  const keys = Object.keys(value as Record<string, unknown>).sort();
  const entries = keys.map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`);
  return `{${entries.join(',')}}`;
}

export class SessionProgress {
  filesRead = new Set<string>();
  filesWritten = new Set<string>();
  toolSuccessCount = 0;
  toolFailureCount = 0;
  consecutiveFailures = 0;
  turnsWithoutProgress = 0;
  private lastProgressTurn = 0;

  /** Track recent tool calls for deduplication detection */
  private recentToolCalls: Array<{ tool: string; paramsKey: string; turn: number }> = [];
  private currentTurn = 0;

  /** Track failed approaches with reasons for re-injection after compression */
  failedToolCalls: Array<{ tool: string; params: string; error: string; turn: number }> = [];

  /** Track key findings from tool results for session state */
  keyFindings: string[] = [];

  /**
   * Phase 3d: Count of pending `memory_propose` proposals awaiting human
   * review at session start. Surfaced via `buildSessionSnapshot` as a
   * `[MEMORY QUEUE]` line so L2+ workers know the backlog before calling
   * `memory_propose` themselves. Set once by the orchestrator in
   * `runAgentLoop`; 0 means "no backlog" and suppresses the hint entirely.
   */
  pendingMemoryProposals = 0;

  /**
   * Phase 7c-2: the current session todo plan installed by `plan_update`.
   * Ordered, monotonic-id'd. Rendered into the `[PLAN]` block of
   * `buildSessionSnapshot()` so the LLM sees its own plan echoed back on
   * every tool-result turn. Empty array → plan block is suppressed.
   */
  plan: PlanTodo[] = [];
  /** Next id to hand out to a newly-inserted plan item. */
  private nextPlanId = 1;
  /** Hard cap to stop runaway plans from inflating the reminder block. */
  static readonly MAX_PLAN_ITEMS = 50;

  /**
   * Install (replace) the session plan from a `plan_update` tool call. The
   * orchestrator enforces the TodoWrite-style single-in-progress invariant
   * and non-empty string fields here so the LLM can't wedge the renderer by
   * sending malformed payloads. Returns a result discriminator that the
   * `plan_update` tool propagates to the worker as a tool-result status.
   */
  recordPlanUpdate(todos: PlanTodoInput[]): { ok: true; count: number } | { ok: false; error: string } {
    if (todos.length > SessionProgress.MAX_PLAN_ITEMS) {
      return {
        ok: false,
        error: `plan has ${todos.length} items; max ${SessionProgress.MAX_PLAN_ITEMS}. Consolidate coarser steps.`,
      };
    }
    let inProgressCount = 0;
    const validated: Array<Omit<PlanTodo, 'id'>> = [];
    for (let i = 0; i < todos.length; i++) {
      const t = todos[i];
      if (t == null || typeof t !== 'object') {
        return { ok: false, error: `item ${i}: must be an object` };
      }
      const content = typeof t.content === 'string' ? t.content.trim() : '';
      const activeForm = typeof t.activeForm === 'string' ? t.activeForm.trim() : '';
      const status = t.status;
      if (!content) return { ok: false, error: `item ${i}: content is required and must be non-empty` };
      if (!activeForm) return { ok: false, error: `item ${i}: activeForm is required and must be non-empty` };
      if (status !== 'pending' && status !== 'in_progress' && status !== 'completed') {
        return {
          ok: false,
          error: `item ${i}: status must be 'pending' | 'in_progress' | 'completed', got ${JSON.stringify(status)}`,
        };
      }
      if (status === 'in_progress') inProgressCount++;
      validated.push({ content, activeForm, status });
    }
    if (inProgressCount > 1) {
      return {
        ok: false,
        error: `exactly one item may be 'in_progress'; got ${inProgressCount}. Mark the others 'pending'.`,
      };
    }
    // Replace the plan. Each call gets fresh ids — stable-id tracking across
    // updates adds complexity without observable value (the plan is rendered
    // as markdown, not addressed by id).
    this.plan = validated.map((t) => ({ id: this.nextPlanId++, ...t }));
    return { ok: true, count: this.plan.length };
  }

  /** Render the current plan as a markdown checklist for reminder injection. */
  renderPlanBlock(): string | null {
    if (this.plan.length === 0) return null;
    const lines = ['[PLAN]'];
    for (const item of this.plan) {
      const marker = item.status === 'completed' ? '[x]' : item.status === 'in_progress' ? '[-]' : '[ ]';
      const label = item.status === 'in_progress' ? item.activeForm : item.content;
      lines.push(`  ${marker} ${label}`);
    }
    return lines.join('\n');
  }

  recordToolResult(toolName: string, isError: boolean, output?: string, callParams?: Record<string, unknown>): void {
    if (isError) {
      this.toolFailureCount++;
      this.consecutiveFailures++;
      // Record failed tool call for context preservation
      if (output) {
        const paramsStr = callParams ? JSON.stringify(callParams).slice(0, 200) : '';
        this.failedToolCalls.push({
          tool: toolName,
          params: paramsStr,
          error: (output ?? '').slice(0, 300),
          turn: this.currentTurn,
        });
        // Keep only last 5 failures to bound memory
        if (this.failedToolCalls.length > 5) this.failedToolCalls.shift();
      }
    } else {
      this.toolSuccessCount++;
      this.consecutiveFailures = 0;
    }

    // Track file operations
    if (!isError && output) {
      if (toolName === 'file_read' || toolName === 'search_files' || toolName === 'list_directory') {
        const pathMatch = output.match(/^(?:Reading|Searching|Listing)\s+(.+)/);
        if (pathMatch) this.filesRead.add(pathMatch[1]!);
      } else if (toolName === 'file_write' || toolName === 'file_patch') {
        const pathMatch = output.match(/^(?:Wrote|Patched)\s+(.+)/);
        if (pathMatch) this.filesWritten.add(pathMatch[1]!);
      }
    }
  }

  /**
   * Check if a tool call is a duplicate of a recent one.
   * Returns the warning already wrapped in a `<vinyan-reminder>` block so the
   * caller can append it directly to a tool result's output without having to
   * remember the tagging convention. Returns null on a first-time call.
   */
  checkDuplicate(toolName: string, params: Record<string, unknown>): string | null {
    const paramsKey = stableStringify(params);
    const match = this.recentToolCalls.find((c) => c.tool === toolName && c.paramsKey === paramsKey);
    if (match) {
      return wrapReminder(
        `[DUPLICATE WARNING] You called ${toolName} with the same parameters in turn ${match.turn}. This is the same call — you will get the same result. Try a different approach.`,
      );
    }
    this.recentToolCalls.push({ tool: toolName, paramsKey, turn: this.currentTurn });
    // Keep last 8 tool calls
    if (this.recentToolCalls.length > 8) this.recentToolCalls.shift();
    return null;
  }

  recordTurn(hadToolCalls: boolean): void {
    this.currentTurn++;
    if (hadToolCalls && this.consecutiveFailures === 0) {
      this.turnsWithoutProgress = 0;
      this.lastProgressTurn = Date.now();
    } else {
      this.turnsWithoutProgress++;
    }
  }

  /** Build a session state snapshot that can be injected into tool results.
   *  This gives the agent persistent awareness of what it has done so far. */
  buildSessionSnapshot(): string | null {
    const lines: string[] = [];

    // Phase 7c-2: plan block goes first so it's prominent. The agent reads
    // top-down and checking the plan against the state below keeps it honest.
    const planBlock = this.renderPlanBlock();
    if (planBlock) {
      lines.push(planBlock);
    }

    if (this.filesRead.size > 0 || this.filesWritten.size > 0) {
      lines.push('[SESSION STATE]');
      if (this.filesRead.size > 0) {
        lines.push(`Files read: ${[...this.filesRead].slice(-10).join(', ')}`);
      }
      if (this.filesWritten.size > 0) {
        lines.push(`Files modified: ${[...this.filesWritten].slice(-10).join(', ')}`);
      }
    }

    if (this.failedToolCalls.length > 0) {
      lines.push('Recent failures:');
      for (const f of this.failedToolCalls.slice(-3)) {
        lines.push(`  - ${f.tool}${f.params ? `(${f.params.slice(0, 80)})` : ''}: ${f.error.slice(0, 150)}`);
      }
    }

    if (this.keyFindings.length > 0) {
      lines.push('Key findings:');
      for (const finding of this.keyFindings.slice(-5)) {
        lines.push(`  - ${finding}`);
      }
    }

    // Phase 3d: surface the memory_propose review backlog so L2+ workers can
    // choose whether to add to it or defer. Three escalation bands keep the
    // signal proportional to the pressure:
    //   1   – 3:  soft awareness notice
    //   4   – 9:  nudge to check existing pending before proposing more
    //   10+    :  strong backpressure — queue is already overloaded
    if (this.pendingMemoryProposals > 0) {
      const n = this.pendingMemoryProposals;
      const plural = n === 1 ? 'proposal' : 'proposals';
      let guidance: string;
      if (n >= 10) {
        guidance =
          ' — queue is overloaded; do NOT call memory_propose this session unless your finding is exceptional and non-duplicative.';
      } else if (n >= 4) {
        guidance = ' — review the existing backlog before proposing more to avoid duplicates.';
      } else {
        guidance = '';
      }
      lines.push(`[MEMORY QUEUE] ${n} memory ${plural} awaiting human review${guidance}`);
    }

    return lines.length > 0 ? lines.join('\n') : null;
  }

  /**
   * Generate a system hint based on current progress state.
   * Returns the hint already wrapped in a `<vinyan-reminder>` block so callers
   * can append it directly to tool-result output. Returns null when there is
   * nothing to say (so callers can skip injection entirely).
   */
  getSystemHint(budgetRatio: number, turnsRemaining: number): string | null {
    const hints: string[] = [];

    // Budget pressure
    if (budgetRatio >= 0.85) {
      hints.push(
        '[BUDGET WARNING] You have used 85%+ of your budget. Wrap up NOW — summarize your progress and call attempt_completion.',
      );
    } else if (budgetRatio >= 0.7) {
      hints.push(
        '[BUDGET NOTICE] You have used 70%+ of your budget. Start wrapping up — focus only on essential remaining work.',
      );
    }

    // Turn limit pressure
    if (turnsRemaining <= 2) {
      hints.push(
        `[TURNS WARNING] Only ${turnsRemaining} turn(s) remaining. Finalize your work and call attempt_completion.`,
      );
    }

    // Consecutive failures — enriched with what failed
    if (this.consecutiveFailures >= 2) {
      const recentFails = this.failedToolCalls.slice(-this.consecutiveFailures);
      const failSummary = recentFails.map((f) => `${f.tool}: ${f.error.slice(0, 80)}`).join('; ');
      hints.push(
        `[GUIDANCE] ${this.consecutiveFailures} consecutive tool failures (${failSummary}). Step back and try a fundamentally different approach. Before editing a file, ALWAYS read it first to understand its current content.`,
      );
    }

    // Stall detection — stronger, with forced pivot at 3+ turns
    if (this.turnsWithoutProgress >= 3) {
      hints.push(
        `[FORCED PIVOT] No progress for ${this.turnsWithoutProgress} turns. You MUST try a fundamentally different approach or call attempt_completion with status 'uncertain'. Do NOT repeat any approach you have already tried.`,
      );
    } else if (this.turnsWithoutProgress >= 2) {
      hints.push(
        `[STALL WARNING] No progress detected for ${this.turnsWithoutProgress} turns. Either make progress or call attempt_completion with status 'uncertain'.`,
      );
    }

    // Session state snapshot — always inject when there's notable context
    const snapshot = this.buildSessionSnapshot();
    if (snapshot) {
      hints.push(snapshot);
    }

    return wrapReminder(hints.length > 0 ? hints.join('\n') : null);
  }
}

// ── Helpers ──────────────────────────────────────────────────────────

/** Extract provider tier from workerId pattern like "worker-openrouter/tool-uses/..." */
function extractTierFromWorkerId(workerId?: string): string | undefined {
  if (!workerId) return undefined;
  // Pattern: worker-<registry>/<tier>/... or worker-<registry>/<provider>
  const parts = workerId.replace(/^worker-[^/]+\//, '').split('/');
  const knownTiers = ['fast', 'balanced', 'powerful', 'tool-uses'];
  if (parts[0] && knownTiers.includes(parts[0])) return parts[0];
  return undefined;
}

/** Fallback token estimation when worker doesn't report tokensConsumed */
function estimateTokens(turn: WorkerTurn): number {
  return Math.ceil(JSON.stringify(turn).length / 3.5);
}

function buildUncertainResult(
  mutations: ProposedMutation[],
  uncertainties: string[],
  tokensConsumed: number,
  durationMs: number,
  transcript: WorkerTurn[],
  proposedContent?: string,
  nonRetryableError?: string,
  needsUserInput?: boolean,
  cacheReadTokens?: number,
  cacheCreationTokens?: number,
): WorkerLoopResult {
  return {
    mutations,
    proposedContent,
    uncertainties,
    tokensConsumed,
    ...(cacheReadTokens ? { cacheReadTokens } : {}),
    ...(cacheCreationTokens ? { cacheCreationTokens } : {}),
    durationMs: Math.round(durationMs),
    transcript,
    isUncertain: true,
    proposedToolCalls: [],
    nonRetryableError,
    ...(needsUserInput ? { needsUserInput: true } : {}),
  };
}

/** Detect permanent errors (auth, config) from uncertainty messages. */
const NON_RETRYABLE_PATTERNS = [
  /\b40[13]\b/, // 401 Unauthorized, 403 Forbidden
  /invalid.api.key/i,
  /user not found/i,
  /authentication/i,
  /permission denied/i,
];

function detectNonRetryableError(uncertainties: string[]): string | undefined {
  const joined = uncertainties.join(' ');
  return NON_RETRYABLE_PATTERNS.some((p) => p.test(joined)) ? joined : undefined;
}

// ── Delegation handler (Phase 6.4) ───────────────────────────────────

/**
 * @internal Exported for unit tests. Tests need to verify the §5.6 remote-
 * first-then-local seam without spinning up a full agent worker subprocess.
 * Production callers should use `runAgentLoop` which calls this internally.
 */
/**
 * Wave 4: run the deterministic goal check hook after the subprocess reports
 * `done`. Returns whether the result should flip to `isUncertain` and the
 * blocker messages to include in `uncertainties`.
 *
 * Pure helper — all inputs are passed explicitly. A3/A7 compliant: the
 * decision flows through rule-based completion-gate, not through the LLM.
 */
export async function runWave4GoalCheck(
  input: TaskInput,
  mutations: ReadonlyArray<{ file: string; diff: string }>,
  proposedContent: string | undefined,
  understanding: import('../types.ts').TaskUnderstanding | undefined,
  deps: AgentLoopDeps,
): Promise<{ flipToUncertain: boolean; uncertainties: string[]; score?: number; decision?: string }> {
  const cfg = deps.goalTerminationConfig;
  if (!cfg?.enabled || !deps.goalEvaluator) {
    return { flipToUncertain: false, uncertainties: [] };
  }

  try {
    // Build a synthetic TaskResult the Wave 1 evaluator can consume.
    // oracleVerdicts[] is intentionally empty at this stage — oracle gate
    // runs in phase-verify after the agent-loop returns. The evaluator's
    // C1-C4 alignment checks work on mutations + understanding, which we
    // have; contradiction detection passes (no verdicts, no contradiction);
    // C5 acceptance-criteria coverage works on mutations + proposedContent.
    const { WorkingMemory } = await import('../working-memory.ts');
    const workingMemory = new WorkingMemory({ taskId: input.id });
    const syntheticResult: TaskResult = {
      id: input.id,
      status: 'completed',
      mutations: mutations.map((m) => ({
        file: m.file,
        diff: m.diff,
        oracleVerdicts: {},
      })),
      trace: {
        id: `trace-${input.id}-agent-loop-goal-check`,
        taskId: input.id,
        timestamp: Date.now(),
        routingLevel: 2,
        approach: 'agent-loop-goal-check',
        oracleVerdicts: {},
        modelUsed: 'n/a',
        tokensConsumed: 0,
        durationMs: 0,
        outcome: 'success',
        affectedFiles: mutations.map((m) => m.file),
      },
      ...(proposedContent !== undefined ? { answer: proposedContent } : {}),
    };

    const satisfaction = await deps.goalEvaluator.evaluate({
      input,
      result: syntheticResult,
      oracleVerdicts: [],
      workingMemory,
      understanding,
    });

    const { decideCompletion } = await import('./completion-gate.ts');
    const gate = decideCompletion({
      goalScore: satisfaction.score,
      threshold: cfg.goalSatisfactionThreshold,
      continuationsUsed: cfg.maxContinuations, // MVP: no live continuation → exhausted
      maxContinuations: cfg.maxContinuations,
      budgetRemaining: 0,
      continuationCost: 1,
      blockers: satisfaction.blockers,
    });

    deps.bus?.emit('agent-loop:goal-check', {
      taskId: input.id,
      score: satisfaction.score,
      decision: gate.decision,
      reason: gate.reason,
    });

    if (gate.decision === 'accept') {
      return { flipToUncertain: false, uncertainties: [], score: satisfaction.score, decision: gate.decision };
    }

    // 'continue' or 'reject' → flip to uncertain so Wave 1 outer loop can replan.
    const uncertainties = [
      `Wave 4 goal-check: ${gate.decision} (score ${satisfaction.score.toFixed(2)} < ${cfg.goalSatisfactionThreshold})`,
      ...satisfaction.blockers.map((b) => `[${b.category}] ${b.detail}`),
    ];
    return { flipToUncertain: true, uncertainties, score: satisfaction.score, decision: gate.decision };
  } catch {
    // Any evaluation error → fail-open (don't flip) so a buggy evaluator
    // never blocks a completed task.
    return { flipToUncertain: false, uncertainties: [] };
  }
}

/**
 * Wave 5b: format top-k CachedSkills as a constraint block the worker
 * prompt assembler will render under "Constraints". Each entry shows the
 * proven approach + success rate. Bounded to avoid token bloat.
 */
export function formatSkillHintConstraints(skills: CachedSkill[]): string[] {
  if (skills.length === 0) return [];
  const out: string[] = [
    `[SKILL HINTS] ${skills.length} proven approach(es) for similar prior tasks (reference only, not mandates):`,
  ];
  for (let i = 0; i < skills.length; i++) {
    const s = skills[i]!;
    const pct = Math.round((s.successRate ?? 0) * 100);
    // Bound per-hint length so a single verbose approach can't dominate the block.
    const approach = s.approach.length > 200 ? `${s.approach.slice(0, 200)}…` : s.approach;
    out.push(`  ${i + 1}. ${approach} (success: ${pct}%, uses: ${s.usageCount ?? 0})`);
  }
  return out;
}

export async function handleDelegation(
  request: DelegationRequest,
  parent: TaskInput,
  budget: AgentBudgetTracker,
  routing: RoutingDecision,
  deps: AgentLoopDeps,
): Promise<ToolResult> {
  const decision = deps.delegationRouter!.canDelegate(request, budget, parent);
  if (!decision.allowed) {
    return {
      callId: '',
      tool: 'delegate_task',
      status: 'denied',
      output: `Delegation denied: ${decision.reason}`,
      durationMs: 0,
    };
  }

  const reserved = decision.allocatedTokens;
  const childBudget = budget.deriveChildBudget(reserved);
  const subInput = buildSubTaskInput(request, parent, routing, childBudget);

  const startTime = performance.now();
  try {
    // Agent Conversation §5.6: try inter-instance delegation FIRST when
    // an InstanceCoordinator is wired and reports at least one live
    // peer. The local executeTask path is the fallback so remote
    // unavailability is invisible to the parent — exactly the same
    // semantics as pre-§5.6 when no coordinator is configured. We
    // deliberately don't propagate remote-specific errors: a remote
    // failure with a good local fallback should not surface as an
    // error to the parent LLM (it would look like a delegation we
    // shouldn't have attempted).
    let childResult: TaskResult;
    let executedRemotely = false;
    if (deps.instanceCoordinator?.canDelegate(subInput)) {
      const remote = await deps.instanceCoordinator.delegate(subInput);
      if (remote.delegated && remote.result) {
        childResult = remote.result;
        executedRemotely = true;
        deps.bus?.emit('delegation:remote', {
          parentTaskId: parent.id,
          childTaskId: subInput.id,
          peerId: remote.peerId ?? 'unknown',
          status: childResult.status,
        });
      } else {
        childResult = await deps.executeTask!(subInput);
      }
    } else {
      childResult = await deps.executeTask!(subInput);
    }

    // Refund unused delegation tokens (fix #7)
    const actualConsumed = (childResult as any).tokensUsed
      ? (childResult as any).tokensUsed.input + (childResult as any).tokensUsed.output
      : 0;
    budget.returnUnusedDelegation(reserved, actualConsumed);

    // Agent Conversation: a child that returns `input-required` is NOT a
    // failure — it's a collaborative pause. Treat it like 'completed' for
    // ToolResult.status so the parent's error-handling doesn't fire, and
    // surface the child's questions in the structured output so the parent
    // LLM can decide to answer-and-re-delegate OR bubble up via
    // attempt_completion(needsUserInput=true).
    const pausedForUserInput = childResult.status === 'input-required';
    const isSuccessLike = childResult.status === 'completed' || pausedForUserInput;

    deps.bus?.emit('delegation:done', {
      parentTaskId: parent.id,
      childTaskId: subInput.id,
      status: childResult.status,
      tokensUsed: actualConsumed,
    });

    return {
      callId: '',
      tool: 'delegate_task',
      status: isSuccessLike ? 'success' : 'error',
      output: JSON.stringify({
        childTaskId: subInput.id,
        status: childResult.status,
        mutations: childResult.mutations?.length ?? 0,
        // Agent Conversation §5.6: tell the parent LLM whether the work
        // ran on a peer Vinyan instance or locally. The parent doesn't
        // need to do anything different — semantics are identical — but
        // surfacing it lets the model audit its own delegation choices.
        ...(executedRemotely ? { executedRemotely: true } : {}),
        // Agent Conversation: only set on input-required so the parent LLM
        // has a single, stable signal to watch for.
        ...(pausedForUserInput
          ? {
              pausedForUserInput: true,
              clarificationNeeded: childResult.clarificationNeeded ?? [],
            }
          : {}),
      }),
      durationMs: Math.round(performance.now() - startTime),
    };
  } catch (err) {
    budget.returnUnusedDelegation(reserved, 0);
    return {
      callId: '',
      tool: 'delegate_task',
      status: 'error',
      error: `Delegation failed: ${err instanceof Error ? err.message : String(err)}`,
      durationMs: Math.round(performance.now() - startTime),
    };
  }
}

// ── Consult-peer handler (Agent Conversation PR #7) ─────────────────

/**
 * Dispatch a lightweight second-opinion request to a different
 * reasoning engine than the worker's current model. Distinct from
 * delegation:
 *   - Single LLM call, no child pipeline, no tools, no mutations.
 *   - Fixed-count budget (3 per session) rather than a token pool.
 *   - Advisory confidence capped at 0.7 (A5 heuristic tier) by the
 *     factory's peerConsultant wrapper, regardless of what the peer
 *     self-reports.
 *
 * Axiom safety:
 *   - A1 Epistemic Separation: the peerConsultant picks a provider
 *     whose `id` differs from the worker's `routing.model`. If only
 *     one provider is available, returns null and this handler
 *     denies the consultation (rather than consulting the same
 *     model and silently violating A1).
 *   - A3: peer selection logic is deterministic (tier priority →
 *     first distinct id). No LLM in the selection path.
 *   - A6: the handler never calls the tool executor or touches the
 *     overlay. The peer's response is a bare string wrapped in a
 *     structured PeerOpinion, which is treated as advisory by the
 *     worker's LLM.
 */
async function handleConsultPeer(
  request: import('../protocol.ts').PeerConsultRequest,
  budget: AgentBudgetTracker,
  routing: RoutingDecision,
  deps: AgentLoopDeps,
): Promise<ToolResult> {
  if (!deps.peerConsultant) {
    return {
      callId: '',
      tool: 'consult_peer',
      status: 'denied',
      output: 'Peer consultation not configured for this orchestrator',
      durationMs: 0,
    };
  }
  if (!budget.canConsult()) {
    return {
      callId: '',
      tool: 'consult_peer',
      status: 'denied',
      output: `Consultation budget exhausted (used ${budget.consultationsUsed}, remaining ${budget.remainingConsultations}, base headroom may also be insufficient)`,
      durationMs: 0,
    };
  }

  const startTime = performance.now();
  try {
    const workerModelId = routing.model ?? undefined;
    const opinion = await deps.peerConsultant(request, workerModelId);
    if (!opinion) {
      return {
        callId: '',
        tool: 'consult_peer',
        status: 'denied',
        output:
          'No distinct peer reasoning engine is available (would consult the same model — blocked to honor A1 epistemic separation)',
        durationMs: Math.round(performance.now() - startTime),
      };
    }

    // Charge the consumed tokens against the base pool and increment
    // the per-session counter. Uses input+output since both are real
    // orchestrator cost.
    const tokens = (opinion.tokensUsed.input ?? 0) + (opinion.tokensUsed.output ?? 0);
    budget.recordConsultation(tokens);

    return {
      callId: '',
      tool: 'consult_peer',
      status: 'success',
      output: JSON.stringify(opinion),
      durationMs: opinion.durationMs,
    };
  } catch (err) {
    return {
      callId: '',
      tool: 'consult_peer',
      status: 'error',
      error: `Peer consultation failed: ${err instanceof Error ? err.message : String(err)}`,
      durationMs: Math.round(performance.now() - startTime),
    };
  }
}

// ── Main loop ────────────────────────────────────────────────────────

export async function runAgentLoop(
  input: TaskInput,
  perception: PerceptualHierarchy,
  memory: WorkingMemoryState,
  plan: TaskDAG | undefined,
  routing: RoutingDecision,
  deps: AgentLoopDeps,
  understanding?: import('../types.ts').TaskUnderstanding,
  contract?: AgentContract,
  conversationHistory?: import('../types.ts').ConversationEntry[],
): Promise<WorkerLoopResult> {
  const startTime = performance.now();
  // K1.2: Use contract-based budget when available (A3: immutable contract governs execution)
  const budget = contract
    ? AgentBudgetTracker.fromContract(contract, deps.contextWindow)
    : AgentBudgetTracker.fromRouting(routing, deps.contextWindow);
  const overlay = SessionOverlay.create(deps.workspace, input.id);
  let transcript: WorkerTurn[] = [];
  let tokensConsumed = 0;
  let cacheReadTokens = 0;
  let cacheCreationTokens = 0;
  let contractViolations = 0;
  let session: IAgentSession | null = null;
  const progress = new SessionProgress();

  // Book-integration Wave 1.1: worker-level silence watchdog. Instantiate
  // per-session so state is naturally bounded by the agent loop's lifetime.
  // The detector is inert when `silentAgentConfig` is absent — the
  // interval is never armed and no events fire.
  const silentAgent = deps.silentAgentConfig ? new SilentAgentDetector(deps.silentAgentConfig) : null;
  let silentAgentTimer: ReturnType<typeof setInterval> | null = null;
  const silentAgentTickIntervalMs = Math.max(1_000, Math.floor((deps.silentAgentConfig?.warnAfterMs ?? 15_000) / 3));
  const emitSilentTransitions = () => {
    if (!silentAgent || !deps.bus) return;
    const transitions = silentAgent.tick();
    for (const t of transitions) {
      // Only escalate visibility — 'healthy' transitions are noise.
      if (t.to === 'silent' || t.to === 'stalled') {
        deps.bus.emit('guardrail:silent_agent', {
          taskId: t.taskId,
          ...(t.workerId !== undefined ? { workerId: t.workerId } : {}),
          state: t.to,
          silentForMs: t.silentForMs,
          lastEvent: t.lastEventLabel,
        });
      }
    }
  };

  // Phase 3d: Prime the session with the memory_propose review backlog so
  // L2+ workers see it in every turn's `<vinyan-reminder>` snapshot. The
  // helper is best-effort — a missing or unreadable pending directory is a
  // fresh workspace (count = 0), not an error we should fail the session on.
  if (routing.level >= 2) {
    try {
      progress.pendingMemoryProposals = countPendingProposals(deps.workspace);
    } catch {
      // Non-fatal: absent / unreadable directory → no memory queue hint.
    }
  }

  const toolContext: ToolContext = {
    routingLevel: routing.level,
    allowedPaths: input.targetFiles ?? [],
    workspace: deps.workspace,
    overlayDir: overlay.dir,
    onDelegate:
      routing.level >= 2 && deps.delegationRouter && deps.executeTask
        ? (params: any) => handleDelegation(params as DelegationRequest, input, budget, routing, deps)
        : undefined,
    // Agent Conversation — consult_peer (PR #7): available at L1+ when a
    // peer consultant is configured (factory wires one from the LLM
    // provider registry by default). A1 enforcement and budget limits
    // are checked inside handleConsultPeer, so we don't gate them here.
    onConsult:
      routing.level >= 1 && deps.peerConsultant
        ? (params) => handleConsultPeer(params as import('../protocol.ts').PeerConsultRequest, budget, routing, deps)
        : undefined,
    // Phase 7c-2: bind plan_update to SessionProgress so the control tool can
    // install new plan snapshots. The callback runs synchronously and returns
    // a validation result the tool propagates back as a tool-result status.
    onPlanUpdate: (todos) => progress.recordPlanUpdate(todos),
  };

  try {
    // Compress perception before sending (fix #5)
    const compressedPerception = deps.compressPerception(perception, budget.toSnapshot().contextWindow);

    // Spawn subprocess
    const proc = Bun.spawn(['bun', 'run', deps.agentWorkerEntryPath], {
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        ...process.env,
        VINYAN_ROUTING_LEVEL: String(routing.level),
        VINYAN_MODEL: routing.model ?? '',
        VINYAN_ORCHESTRATOR_PID: String(process.pid),
        // Forward the selected worker's tier so subprocess uses the correct provider
        VINYAN_WORKER_TIER: extractTierFromWorkerId(routing.workerId) ?? '',
        ...(deps.proxySocketPath ? { VINYAN_PROXY_SOCKET: deps.proxySocketPath } : {}),
      },
    }) as unknown as SubprocessHandle;

    // Drain stderr in background for diagnostics — surface worker errors to orchestrator
    const stderrChunks: string[] = [];
    const stderrDecoder = new TextDecoder();
    const stderrReader = (proc as any).stderr?.getReader?.();
    if (stderrReader) {
      (async () => {
        try {
          while (true) {
            const { done, value } = await stderrReader.read();
            if (done) break;
            const text = stderrDecoder.decode(value, { stream: true });
            stderrChunks.push(text);
            // Forward worker stderr to orchestrator stderr for visibility
            process.stderr.write(`[worker:${input.id}] ${text}`);
          }
        } catch {
          /* reader closed */
        }
      })();
    }

    session = deps.createSession?.(proc) ?? new AgentSession(proc);

    // Phase 7a: resolve M1-M4 instruction hierarchy in-process (we have workspace
    // access here; the subprocess worker does not). This closes the gap where
    // L2+ agent mode workers never saw VINYAN.md / .vinyan/rules/ / learned.md.
    // Best-effort — a broken instruction tier must never block the session.
    let instructions: ReturnType<typeof loadInstructionMemoryForTask> = null;
    try {
      instructions = loadInstructionMemoryForTask({
        workspace: deps.workspace,
        targetFiles: input.targetFiles,
        taskType: input.taskType ?? 'code',
        ...(understanding?.actionVerb ? { actionVerb: understanding.actionVerb } : {}),
      });
    } catch {
      // Instruction loader errors are non-fatal — proceed without project rules.
    }

    // Phase 7a: snapshot OS / cwd / date / git state so the worker can render
    // its own [ENVIRONMENT] block without re-probing the filesystem.
    const environment = computeEnvironmentInfo(deps.workspace);

    // Wave 5b: query related skills and format as constraint hints.
    // Best-effort — a failing query must not break the session. Empty
    // array when disabled, no memory API, or query errors.
    let skillHintConstraints: string[] = [];
    if (deps.skillHintsConfig?.enabled && deps.agentMemory) {
      try {
        const sig = computeTaskSignature(input);
        const skills = await deps.agentMemory.queryRelatedSkills(sig, { k: deps.skillHintsConfig.topK });
        skillHintConstraints = formatSkillHintConstraints(skills);
      } catch {
        // Read-only memory failure → no hints, session proceeds normally.
      }
    }

    // Book-integration Wave 5.2 + Wave 5b: merge plan.preamble AND skill
    // hints into the understanding.constraints sent to the worker. The
    // worker entry's prompt assembler reads `understanding.constraints`
    // to render the Constraints block of the system prompt, so this is
    // where the research-swarm REPORT_CONTRACT and skill hints actually
    // reach the LLM. The merge is local to the init turn — it doesn't
    // mutate the caller's `understanding` object or leak back to the
    // orchestrator.
    const extraConstraints = [...(plan?.preamble ?? []), ...skillHintConstraints];
    const initUnderstanding =
      understanding && extraConstraints.length > 0
        ? {
            ...understanding,
            constraints: [...(understanding.constraints ?? []), ...extraConstraints],
          }
        : understanding;

    // Build and send init turn
    const initTurn: OrchestratorTurn = {
      type: 'init',
      taskId: input.id,
      goal: input.goal,
      taskType: input.taskType ?? 'code',
      routingLevel: routing.level as Exclude<typeof routing.level, 0>,
      perception: compressedPerception,
      workingMemory: memory,
      ...(plan ? { plan } : {}),
      budget: budget.toSnapshot(),
      allowedPaths: input.targetFiles ?? [],
      toolManifest: manifestFor(routing, deps.extraTools),
      ...(memory.priorAttempts?.length ? { priorAttempts: memory.priorAttempts } : {}),
      ...(memory.failedApproaches?.length ? { failedApproaches: memory.failedApproaches } : {}),
      ...(input.acceptanceCriteria?.length ? { acceptanceCriteria: input.acceptanceCriteria } : {}),
      ...(initUnderstanding ? { understanding: initUnderstanding } : {}),
      ...(conversationHistory?.length ? { conversationHistory } : {}),
      ...(instructions ? { instructions } : {}),
      environment,
      // Phase 7c-1: forward typed subagent role so the child worker can
      // render its role preamble. Omitted for root tasks (undefined).
      ...(input.subagentType ? { subagentType: input.subagentType } : {}),
    };
    await session.send(initTurn);

    deps.bus?.emit('worker:dispatch', { taskId: input.id, routing });
    deps.bus?.emit('agent:session_start', {
      taskId: input.id,
      routingLevel: routing.level,
      budget: budget.toSnapshot(),
    });

    // Wave 1.1: arm the silence watchdog. Priming it with `session_start`
    // means an unresponsive init is detected even before the first turn.
    if (silentAgent) {
      silentAgent.register(input.id);
      silentAgentTimer = setInterval(emitSilentTransitions, silentAgentTickIntervalMs);
      // Bun's setInterval supports unref() on the returned object; unref so
      // an idle watchdog never keeps the orchestrator alive on its own.
      (silentAgentTimer as unknown as { unref?: () => void }).unref?.();
    }

    // Agent loop: process worker turns until done, uncertain, or budget exhausted
    const maxToolCallsPerTurn = budget.toSnapshot().maxToolCallsPerTurn;

    while (budget.canContinue()) {
      const turn = await session.receive(budget.remainingMs());

      // Subprocess crash or timeout — treat as uncertain
      if (turn === null) {
        const mutations = overlay.computeDiff();
        const stderrOutput = stderrChunks.join('').trim();
        const reason = stderrOutput
          ? `Subprocess error — ${stderrOutput.slice(0, 500)}`
          : 'Subprocess timeout or crash — no response received';
        return buildUncertainResult(
          mutations,
          [reason],
          tokensConsumed,
          performance.now() - startTime,
          transcript,
          undefined,
          detectNonRetryableError([reason]),
        );
      }

      transcript.push(turn);

      // Wave 1.1: reset the silence timer on every worker turn. The label
      // is stored for operator diagnostics ("last heard from you during a
      // tool_calls turn 32s ago") — pure visibility, no governance effect.
      silentAgent?.heartbeat(input.id, turn.type);

      if (turn.type === 'tool_calls') {
        // Surface agent thinking/rationale for CLI observability
        if (turn.rationale && turn.rationale !== 'Tool execution') {
          deps.bus?.emit('agent:thinking', {
            taskId: input.id,
            turnId: turn.turnId,
            rationale: turn.rationale,
          });
        }

        const turnTokens = turn.tokensConsumed ?? estimateTokens(turn);
        budget.recordTurn(turnTokens);
        tokensConsumed += turnTokens;

        // EO #5: Check if transcript compaction is warranted (lowered from 0.7 — preserves context earlier)
        const snap = budget.toSnapshot();
        const pressureRatio = tokensConsumed / snap.maxTokens;
        if (pressureRatio > 0.5 && transcript.length > 5) {
          const partition = partitionTranscript(transcript);
          deps.bus?.emit('agent:transcript_compaction', {
            taskId: input.id,
            evidenceTurns: partition.evidenceTurns.filter((t) => t.isEvidence).length,
            narrativeTurns: partition.compactedNarrativeTurns,
            tokensSaved: partition.tokensSaved,
          });

          // Structure-preserve compaction: keep evidence, replace narrative with metadata
          if (partition.compactedNarrativeTurns > 2) {
            const summary = `[Compacted: ${partition.compactedNarrativeTurns} narrative turns removed, ~${partition.tokensSaved} tokens saved. Evidence turns preserved.]`;
            transcript = buildCompactedTranscript(transcript, summary) as typeof transcript;
          }
        }

        // Cap tool calls: per-turn limit AND session-level limit (§5: 0/0/20/50)
        const sessionRemaining = budget.remainingToolCalls;
        const effectiveLimit = Math.min(maxToolCallsPerTurn, sessionRemaining);
        const calls = turn.calls.slice(0, effectiveLimit);
        const results: ToolResult[] = [];

        // Synthetic errors for dropped calls (per-turn or session limit)
        for (let i = effectiveLimit; i < turn.calls.length; i++) {
          const dropped = turn.calls[i]!;
          const reason =
            i >= maxToolCallsPerTurn
              ? `Dropped: exceeded maxToolCallsPerTurn (${maxToolCallsPerTurn})`
              : `Dropped: session tool call limit reached (${budget.remainingToolCalls} remaining)`;
          results.push({
            callId: dropped.id,
            tool: dropped.tool,
            status: 'denied',
            error: reason,
            durationMs: 0,
          });
        }

        // Track session-level usage
        budget.recordToolCalls(calls.length);

        // Execute allowed calls
        for (const call of calls) {
          // K1.3: Capability-scoped tool authorization (A6 zero-trust)
          if (contract) {
            const auth = authorizeToolCall(contract, call.tool, call.parameters ?? {});
            if (!auth.authorized) {
              contractViolations++;
              results.push({
                callId: call.id,
                tool: call.tool,
                status: 'error',
                error: auth.violation ?? `Capability denied for ${call.tool}`,
                durationMs: 0,
              });
              deps.bus?.emit('agent:tool_denied', {
                taskId: input.id,
                toolName: call.tool,
                violation: auth.violation,
              });
              // Violation policy: kill immediately or after exceeding tolerance
              if (contract.onViolation === 'kill' || contractViolations > contract.violationTolerance) {
                deps.bus?.emit('agent:contract_violation', {
                  taskId: input.id,
                  violations: contractViolations,
                  policy: contract.onViolation,
                });
                break;
              }
              continue;
            }
          }
          // Phase 7d-2: Permission DSL gate. Runs after contract auth but
          // before hooks so an operator-declared deny rule short-circuits
          // without paying the cost of spawning a shell hook. Deny wins;
          // allow is explicit; no match falls through to hooks/executor.
          if (deps.permissionConfig) {
            const perm = evaluatePermission(deps.permissionConfig, call.tool, call.parameters ?? {});
            if (perm.decision === 'deny') {
              results.push({
                callId: call.id,
                tool: call.tool,
                status: 'denied',
                error: `Permission denied: ${perm.reason ?? 'policy violation'}`,
                durationMs: 0,
              });
              deps.bus?.emit('agent:tool_denied', {
                taskId: input.id,
                toolName: call.tool,
                violation: `Permission DSL: ${perm.reason ?? 'denied'}`,
              });
              continue;
            }
          }

          // Phase 7d-1: PreToolUse hooks. Any hook that exits non-zero
          // (or returns `{decision: "block"}`) converts the call into a
          // denied result without invoking the tool executor. Hooks run
          // only when deps.hookConfig is wired — absent config is inert.
          if (deps.hookConfig) {
            const pre = await dispatchPreToolUse(
              deps.hookConfig,
              {
                event: 'PreToolUse',
                tool_name: call.tool,
                tool_input: (call.parameters ?? {}) as Record<string, unknown>,
              },
              { cwd: deps.workspace },
            );
            if (pre.blocked) {
              results.push({
                callId: call.id,
                tool: call.tool,
                status: 'denied',
                error: `Hook blocked PreToolUse: ${pre.reason ?? 'hook returned non-zero exit'}`,
                durationMs: 0,
              });
              deps.bus?.emit('agent:tool_denied', {
                taskId: input.id,
                toolName: call.tool,
                violation: `PreToolUse hook: ${pre.reason ?? 'blocked'}`,
              });
              continue;
            }
          }

          const toolStart = performance.now();
          let result = await deps.toolExecutor.execute(call, toolContext);
          // Guardrails scan on every tool result (A6)
          result = scanToolResult(result, deps.guardrailsScan);

          // Phase 7d-1: PostToolUse hooks. These observe the already-
          // committed result and cannot unwind it. Non-zero exits become
          // `[POST-HOOK WARNING]` annotations tacked onto the tool output
          // so the LLM can see what the hook complained about.
          if (deps.hookConfig) {
            const toolOutputText =
              typeof result.output === 'string' ? result.output : JSON.stringify(result.output ?? '');
            const post = await dispatchPostToolUse(
              deps.hookConfig,
              {
                event: 'PostToolUse',
                tool_name: call.tool,
                tool_input: (call.parameters ?? {}) as Record<string, unknown>,
                tool_output: toolOutputText,
                tool_status: result.status,
              },
              { cwd: deps.workspace },
            );
            if (post.warnings.length > 0) {
              const warningText = post.warnings.map((w) => `[POST-HOOK WARNING] ${w}`).join('\n');
              result = {
                ...result,
                output: `${toolOutputText}\n\n${warningText}`,
              };
            }
          }

          results.push(result);
          deps.bus?.emit('agent:tool_executed', {
            taskId: input.id,
            turnId: turn.turnId,
            toolName: call.tool,
            durationMs: Math.round(performance.now() - toolStart),
            isError: result.status !== 'success',
          });
        }

        // K1.3: Kill session if contract violation policy triggered
        if (contract && contractViolations > 0) {
          const shouldKill = contract.onViolation === 'kill' || contractViolations > contract.violationTolerance;
          if (shouldKill) {
            return buildUncertainResult(
              overlay.computeDiff(),
              [`Contract violation: ${contractViolations} unauthorized tool call(s)`],
              tokensConsumed,
              Math.round(performance.now() - startTime),
              transcript,
              undefined,
              `Contract violation: session killed (policy=${contract.onViolation}, violations=${contractViolations}/${contract.violationTolerance})`,
            );
          }
        }

        // Track progress from tool results (with params for dedup and failure tracking)
        for (let i = 0; i < results.length; i++) {
          const r = results[i]!;
          const originalCall = turn.calls[i];
          progress.recordToolResult(
            r.tool,
            r.status !== 'success',
            typeof r.output === 'string' ? r.output : undefined,
            originalCall?.parameters as Record<string, unknown> | undefined,
          );
        }
        progress.recordTurn(results.length > 0);

        // Check for duplicate tool calls and inject warnings
        for (let i = 0; i < turn.calls.length && i < results.length; i++) {
          const call = turn.calls[i]!;
          const dupWarning = progress.checkDuplicate(call.tool, (call.parameters ?? {}) as Record<string, unknown>);
          if (dupWarning && results[i]) {
            const r = results[i]!;
            const existingOutput = typeof r.output === 'string' ? r.output : JSON.stringify(r.output ?? '');
            results[i] = { ...r, output: `${existingOutput}\n\n${dupWarning}` };
          }
        }

        // Emit stall event when detected
        if (progress.turnsWithoutProgress > 3) {
          deps.bus?.emit('agent:turn_complete', {
            taskId: input.id,
            turnId: turn.turnId,
            tokensConsumed,
            turnsRemaining: budget.toSnapshot().maxTurns - transcript.length,
          });
        }

        // Inject system hints into the last tool result (budget pressure, stalls, guidance)
        const budgetSnap = budget.toSnapshot();
        const budgetRatio = tokensConsumed / budgetSnap.maxTokens;
        const turnsRemaining = budgetSnap.maxTurns - transcript.length;
        const hint = progress.getSystemHint(budgetRatio, turnsRemaining);

        const finalResults = [...results];
        if (hint && finalResults.length > 0) {
          const lastResult = finalResults[finalResults.length - 1]!;
          const existingOutput =
            typeof lastResult.output === 'string' ? lastResult.output : JSON.stringify(lastResult.output ?? '');
          finalResults[finalResults.length - 1] = {
            ...lastResult,
            output: `${existingOutput}\n\n${hint}`,
          };
        }

        // Send results back to worker
        await session.send({
          type: 'tool_results',
          turnId: turn.turnId,
          results: finalResults,
        });
        deps.bus?.emit('agent:turn_complete', {
          taskId: input.id,
          turnId: turn.turnId,
          tokensConsumed,
          turnsRemaining,
        });
      } else if (turn.type === 'done') {
        const turnTokens = turn.tokensConsumed ?? estimateTokens(turn);
        budget.recordTurn(turnTokens);
        tokensConsumed += turnTokens;
        cacheReadTokens += turn.cacheReadTokens ?? 0;
        cacheCreationTokens += turn.cacheCreationTokens ?? 0;

        const mutations = overlay.computeDiff();
        await session.drainAndClose(); // fix #1: drainAndClose, not close('completed')

        const durationMs = Math.round(performance.now() - startTime);
        deps.bus?.emit('agent:session_end', {
          taskId: input.id,
          outcome: 'completed',
          tokensConsumed,
          turnsUsed: transcript.length,
          durationMs,
        });

        // Wave 4: optional deterministic goal check before accepting `done`.
        // Gated OFF by default; when enabled, a shortfall flips `isUncertain`
        // so Wave 1's outer goal-loop sees the signal via transcript metadata
        // and can decide whether to replan (Wave 2). No control flow change
        // when disabled — the loop falls through to the existing return.
        const goalCheck = await runWave4GoalCheck(
          input,
          mutations,
          turn.proposedContent,
          understanding,
          deps,
        );
        if (goalCheck.flipToUncertain) {
          return {
            mutations,
            proposedContent: turn.proposedContent,
            uncertainties: goalCheck.uncertainties,
            tokensConsumed,
            ...(cacheReadTokens > 0 ? { cacheReadTokens } : {}),
            ...(cacheCreationTokens > 0 ? { cacheCreationTokens } : {}),
            durationMs,
            transcript,
            isUncertain: true,
            proposedToolCalls: [],
          };
        }

        return {
          mutations,
          proposedContent: turn.proposedContent,
          uncertainties: [],
          tokensConsumed,
          ...(cacheReadTokens > 0 ? { cacheReadTokens } : {}),
          ...(cacheCreationTokens > 0 ? { cacheCreationTokens } : {}),
          durationMs,
          transcript,
          isUncertain: false,
          proposedToolCalls: [],
        };
      } else if (turn.type === 'uncertain') {
        const turnTokens = turn.tokensConsumed ?? estimateTokens(turn);
        budget.recordTurn(turnTokens);
        tokensConsumed += turnTokens;
        cacheReadTokens += turn.cacheReadTokens ?? 0;
        cacheCreationTokens += turn.cacheCreationTokens ?? 0;

        const mutations = overlay.computeDiff();
        await session.drainAndClose(); // fix #1: drainAndClose for uncertain too

        // Agent Conversation: input-required is a distinct outcome from plain uncertain
        const needsUserInput = turn.needsUserInput === true;
        deps.bus?.emit('agent:session_end', {
          taskId: input.id,
          outcome: needsUserInput ? 'input_required' : 'uncertain',
          tokensConsumed,
          turnsUsed: transcript.length,
          durationMs: Math.round(performance.now() - startTime),
        });

        return buildUncertainResult(
          mutations,
          turn.uncertainties,
          tokensConsumed,
          performance.now() - startTime,
          transcript,
          undefined,
          // When the agent explicitly requests user input, do NOT classify this
          // as a non-retryable error — it's a collaborative pause, not a hard failure.
          needsUserInput ? undefined : detectNonRetryableError(turn.uncertainties),
          needsUserInput,
          cacheReadTokens > 0 ? cacheReadTokens : undefined,
          cacheCreationTokens > 0 ? cacheCreationTokens : undefined,
        );
      }
    }

    // Budget exhausted — terminate session
    await session.close('budget_exceeded');

    deps.bus?.emit('agent:session_end', {
      taskId: input.id,
      outcome: 'budget_exceeded',
      tokensConsumed,
      turnsUsed: transcript.length,
      durationMs: Math.round(performance.now() - startTime),
    });

    const mutations = overlay.computeDiff();
    return buildUncertainResult(
      mutations,
      ['Agent budget exhausted'],
      tokensConsumed,
      performance.now() - startTime,
      transcript,
    );
  } finally {
    // fix #4: always cleanup overlay
    overlay.cleanup();
    // Wave 1.1: tear down the silence watchdog. Detector is per-session
    // so unregistering is mostly defensive — the GC will collect it
    // along with the runAgentLoop frame — but clearing the interval is
    // mandatory or a late tick would fire after the session is gone.
    if (silentAgentTimer) clearInterval(silentAgentTimer);
    silentAgent?.unregister(input.id);
  }
}
