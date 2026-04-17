/**
 * Orchestrator IPC Protocol — Zod schemas for process boundary validation.
 *
 * WorkerInput (stdin → worker) and WorkerOutput (worker → stdout) are the
 * primary IPC types. All schemas mirror TypeScript interfaces in ./types.ts.
 *
 * Source of truth: spec/tdd.md §11 (Worker IPC), §16.3 (Worker lifecycle)
 */
import { z } from 'zod/v4';
import { EvidenceSchema } from '../oracle/protocol.ts';
import type { InstructionMemory } from './llm/instruction-hierarchy.ts';
import type { EnvironmentInfo } from './llm/shared-prompt-sections.ts';

// ── Routing enums ────────────────────────────────────────────────────

export const RoutingLevelSchema = z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]);

export const IsolationLevelSchema = z.union([z.literal(0), z.literal(1), z.literal(2)]);

// ── ToolCall / ToolResult ────────────────────────────────────────────

export const ToolCallSchema = z.object({
  id: z.string(),
  tool: z.string(),
  parameters: z.record(z.string(), z.unknown()),
});

export const ToolResultSchema = z.object({
  callId: z.string(),
  tool: z.string(),
  status: z.enum(['success', 'error', 'denied']),
  output: z.unknown().optional(),
  error: z.string().optional(),
  evidence: EvidenceSchema.optional(),
  durationMs: z.number(),
});

// ── PerceptualHierarchy ──────────────────────────────────────────────

const TaskTargetSchema = z.object({
  file: z.string(),
  symbol: z.string().optional(),
  description: z.string(),
});

const DependencyConeSchema = z.object({
  directImporters: z.array(z.string()),
  directImportees: z.array(z.string()),
  transitiveBlastRadius: z.number(),
  transitiveImporters: z.array(z.string()).optional(),
  affectedTestFiles: z.array(z.string()).optional(),
});

const DiagnosticItemSchema = z.object({
  file: z.string(),
  line: z.number(),
  message: z.string(),
});

const DiagnosticsSchema = z.object({
  lintWarnings: z.array(DiagnosticItemSchema),
  typeErrors: z.array(DiagnosticItemSchema),
  failingTests: z.array(z.string()),
});

const VerifiedFactRefSchema = z.object({
  target: z.string(),
  pattern: z.string(),
  verified_at: z.number(),
  hash: z.string(),
  confidence: z.number().default(1.0),
  oracleName: z.string().default('unknown'),
  tierReliability: z.number().optional(),
});

const RuntimeInfoSchema = z.object({
  nodeVersion: z.string(),
  os: z.string(),
  availableTools: z.array(z.string()),
});

const FileContentSchema = z.object({
  file: z.string(),
  content: z.string(),
  truncated: z.boolean(),
});

export const PerceptualHierarchySchema = z.object({
  taskTarget: TaskTargetSchema,
  dependencyCone: DependencyConeSchema,
  diagnostics: DiagnosticsSchema,
  verifiedFacts: z.array(VerifiedFactRefSchema),
  runtime: RuntimeInfoSchema,
  frameworkMarkers: z.array(z.string()).optional(),
  fileContents: z.array(FileContentSchema).optional(),
});

// ── WorkingMemoryState ───────────────────────────────────────────────

const FailedApproachSchema = z.object({
  approach: z.string(),
  oracleVerdict: z.string(),
  timestamp: z.number(),
});

const ActiveHypothesisSchema = z.object({
  hypothesis: z.string(),
  confidence: z.number(),
  source: z.string(),
});

const UnresolvedUncertaintySchema = z.object({
  area: z.string(),
  selfModelConfidence: z.number(),
  suggestedAction: z.string(),
});

const ScopedFactSchema = z.object({
  target: z.string(),
  pattern: z.string(),
  verified: z.boolean(),
  hash: z.string(),
});

export const WorkingMemoryStateSchema = z.object({
  failedApproaches: z.array(FailedApproachSchema),
  activeHypotheses: z.array(ActiveHypothesisSchema),
  unresolvedUncertainties: z.array(UnresolvedUncertaintySchema),
  scopedFacts: z.array(ScopedFactSchema),
  priorAttempts: z
    .array(
      z.object({
        sessionId: z.string(),
        attempt: z.number(),
        outcome: z.enum(['uncertain', 'max_tokens', 'timeout', 'oracle_failed']),
        filesRead: z.array(z.string()),
        filesWritten: z.array(z.string()),
        turnsCompleted: z.number(),
        tokensConsumed: z.number(),
        failurePoint: z.string(),
        lastIntent: z.string(),
        uncertainties: z.array(z.string()),
        suggestedNextStep: z.string().optional(),
      }),
    )
    .optional(),
});

// ── TaskDAG ──────────────────────────────────────────────────────────

const TaskDAGNodeSchema = z.object({
  id: z.string(),
  description: z.string(),
  targetFiles: z.array(z.string()),
  dependencies: z.array(z.string()),
  assignedOracles: z.array(z.string()),
});

export const TaskDAGSchema = z.object({
  nodes: z.array(TaskDAGNodeSchema),
  isFallback: z.boolean().optional(),
});

// ── TaskUnderstanding (Gap 9A: unified intermediate representation) ───

const TaskFingerprintSchema = z.object({
  actionVerb: z.string(),
  fileExtensions: z.array(z.string()),
  blastRadiusBucket: z.enum(['single', 'small', 'medium', 'large']),
  frameworkMarkers: z.array(z.string()).optional(),
  oracleFailurePattern: z.string().optional(),
});

const TaskUnderstandingSchema = z
  .object({
    rawGoal: z.string(),
    actionVerb: z.string(),
    actionCategory: z.enum(['mutation', 'analysis', 'investigation', 'design', 'qa']),
    targetSymbol: z.string().optional(),
    frameworkContext: z.array(z.string()),
    constraints: z.array(z.string()),
    acceptanceCriteria: z.array(z.string()),
    expectsMutation: z.boolean(),
    fingerprint: TaskFingerprintSchema.optional(),
  })
  .passthrough(); // Layer 1/2 fields (resolvedEntities, semanticIntent) survive IPC serialization

// ── InstructionMemory (M1-M4 hierarchy — Phase 7a) ───────────────────

/**
 * Merged instruction memory sent from orchestrator → worker subprocess.
 * Produced by `resolveInstructions` / `loadInstructionMemoryForTask` in-process
 * and serialized through the subprocess boundary so worker-side rendering can
 * produce the same tier-provenance headers as in-process assembly.
 *
 * Uses `z.custom<InstructionMemory>` rather than a structural schema so the
 * Zod-inferred type is exactly `InstructionMemory` — the structural variant
 * would collapse `RuleFrontmatter`'s typed optional fields into a generic
 * `Record<string, unknown>`, breaking type compatibility with call sites that
 * expect the full interface shape.
 */
export const InstructionMemorySchema = z.custom<InstructionMemory>(
  (value) => {
    if (value == null || typeof value !== 'object') return false;
    const v = value as Partial<InstructionMemory>;
    return (
      typeof v.content === 'string' &&
      typeof v.contentHash === 'string' &&
      typeof v.filePath === 'string' &&
      Array.isArray(v.sources)
    );
  },
  { message: 'Expected InstructionMemory object' },
);

// ── EnvironmentInfo (Phase 7a) ───────────────────────────────────────

/**
 * Runtime environment snapshot — cwd, platform, wall-clock, git branch/dirty.
 * Gathered by the orchestrator and shipped to the worker so the subprocess
 * can render its own [ENVIRONMENT] block without re-probing the filesystem.
 */
export const EnvironmentInfoSchema = z.custom<EnvironmentInfo>(
  (value) => {
    if (value == null || typeof value !== 'object') return false;
    const v = value as Partial<EnvironmentInfo>;
    return (
      typeof v.cwd === 'string' &&
      typeof v.platform === 'string' &&
      typeof v.arch === 'string' &&
      typeof v.dateIso === 'string'
    );
  },
  { message: 'Expected EnvironmentInfo object' },
);

// ── Multi-agent IPC payloads ────────────────────────────────────────
//
// Specialist identity crosses the subprocess boundary as JSON-serializable
// AgentSpec + AgentContext objects (the design in agent-context/types.ts
// guarantees serializability). Subprocess workers render them via the same
// prompt assembler used in-process, so a ts-coder task reads the same
// persona regardless of dispatch path.

const AgentRoutingHintsSchemaIPC = z.object({
  minLevel: z.number().optional(),
  preferDomains: z.array(z.string()).optional(),
  preferExtensions: z.array(z.string()).optional(),
  preferFrameworks: z.array(z.string()).optional(),
});

const AgentCapabilityOverridesSchemaIPC = z.object({
  readAny: z.boolean().optional(),
  writeAny: z.boolean().optional(),
  network: z.boolean().optional(),
  shell: z.boolean().optional(),
});

/** Full AgentSpec shape for IPC — mirrors orchestrator/types.ts AgentSpec. */
export const AgentSpecSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  soul: z.string().optional(),
  soulPath: z.string().optional(),
  allowedTools: z.array(z.string()).optional(),
  capabilityOverrides: AgentCapabilityOverridesSchemaIPC.optional(),
  routingHints: AgentRoutingHintsSchemaIPC.optional(),
  builtin: z.boolean().optional(),
});

export type AgentSpecIPC = z.infer<typeof AgentSpecSchema>;

const AgentIdentitySchemaIPC = z.object({
  agentId: z.string(),
  persona: z.string(),
  strengths: z.array(z.string()),
  weaknesses: z.array(z.string()),
  approachStyle: z.string(),
});

const AgentEpisodeSchemaIPC = z.object({
  taskId: z.string(),
  taskSignature: z.string(),
  outcome: z.enum(['success', 'partial', 'failed']),
  lesson: z.string(),
  filesInvolved: z.array(z.string()),
  approachUsed: z.string(),
  timestamp: z.number(),
});

const EpisodicMemorySchemaIPC = z.object({
  episodes: z.array(AgentEpisodeSchemaIPC),
  lessonsSummary: z.string(),
});

const SkillProficiencySchemaIPC = z.object({
  taskSignature: z.string(),
  level: z.enum(['novice', 'competent', 'expert']),
  successRate: z.number(),
  totalAttempts: z.number(),
  lastAttempt: z.number(),
});

const LearnedSkillsSchemaIPC = z.object({
  proficiencies: z.record(z.string(), SkillProficiencySchemaIPC),
  preferredApproaches: z.record(z.string(), z.string()),
  antiPatterns: z.array(z.string()),
});

/** Full AgentContext shape for IPC — mirrors agent-context/types.ts AgentContext. */
export const AgentContextSchema = z.object({
  identity: AgentIdentitySchemaIPC,
  memory: EpisodicMemorySchemaIPC,
  skills: LearnedSkillsSchemaIPC,
  lastUpdated: z.number(),
});

export type AgentContextIPC = z.infer<typeof AgentContextSchema>;

// ── WorkerInput (stdin → worker) ─────────────────────────────────────

const WorkerBudgetSchema = z.object({
  maxTokens: z.number().positive(),
  timeoutMs: z.number().positive(),
});

export const WorkerInputSchema = z.object({
  taskId: z.string(),
  goal: z.string(),
  taskType: z.enum(['code', 'reasoning']).default('code'),
  routingLevel: RoutingLevelSchema,
  perception: PerceptualHierarchySchema,
  workingMemory: WorkingMemoryStateSchema,
  plan: TaskDAGSchema.optional(),
  budget: WorkerBudgetSchema,
  allowedPaths: z.array(z.string()),
  isolationLevel: IsolationLevelSchema,
  workerId: z.string().optional(),
  understanding: TaskUnderstandingSchema.optional(),
  /** Phase 7a: M1-M4 instruction hierarchy resolved in-process, shipped through IPC. */
  instructions: InstructionMemorySchema.optional(),
  /** Phase 7a: OS/cwd/date/git snapshot gathered in-process and forwarded to the worker. */
  environment: EnvironmentInfoSchema.optional(),
  /**
   * Phase 2 streaming: when true, the worker MUST use provider.generateStream
   * (if available) and emit `{type:"delta", taskId, text}` JSON lines on
   * stdout BEFORE the final WorkerOutput line. Gated by config.streaming.
   */
  stream: z.boolean().optional(),
  /** Multi-agent: specialist id selected by AgentRouter for this task. */
  agentId: z.string().optional(),
  /** Multi-agent: specialist persona/ACL/hints (pre-resolved by orchestrator). */
  agentProfile: AgentSpecSchema.optional(),
  /** Multi-agent: pre-resolved SOUL.md content (deep behavioral guidance). */
  soulContent: z.string().optional(),
  /** Multi-agent: pre-resolved episodic context (identity + episodes + skills). */
  agentContext: AgentContextSchema.optional(),
});

// ── WorkerOutput (worker → stdout) ───────────────────────────────────

const ProposedMutationSchema = z.object({
  file: z.string(),
  content: z.string(),
  explanation: z.string(),
});

export const WorkerOutputSchema = z.object({
  taskId: z.string(),
  proposedMutations: z.array(ProposedMutationSchema),
  proposedToolCalls: z.array(ToolCallSchema),
  uncertainties: z.array(z.string()),
  tokensConsumed: z.number(),
  durationMs: z.number(),
  proposedContent: z.string().optional(),
});

/**
 * Streaming delta line emitted on worker stdout BEFORE the final WorkerOutput.
 * Worker-pool consumers MUST distinguish delta lines (`type:"delta"`) from
 * the final output (no `type` field — shaped per WorkerOutputSchema).
 */
export const WorkerDeltaLineSchema = z.object({
  type: z.literal('delta'),
  taskId: z.string(),
  text: z.string(),
});

// ── TaskInput (CLI/API entry point) ──────────────────────────────────

const TaskBudgetSchema = z.object({
  maxTokens: z.number().positive(),
  maxDurationMs: z.number().positive(),
  maxRetries: z.number().nonnegative(),
});

export const TaskInputSchema = z.object({
  id: z.string(),
  source: z.enum(['cli', 'api', 'mcp', 'a2a']),
  goal: z.string(),
  taskType: z.enum(['code', 'reasoning']).default('code'),
  targetFiles: z.array(z.string()).optional(),
  constraints: z.array(z.string()).optional(),
  acceptanceCriteria: z.array(z.string()).optional(),
  /** Specialist agent ID — CLI override or pre-set by caller. */
  agentId: z.string().optional(),
  budget: TaskBudgetSchema,
});

// ── Phase 6: Agentic Worker Protocol schemas ─────────────────────────

/** Agent budget — 3-pool model (base + negotiable + delegation) */
export const AgentBudgetSchema = z.object({
  maxTokens: z.number().positive(),
  maxTurns: z.number().positive(),
  maxDurationMs: z.number().positive(),
  contextWindow: z.number().positive(),
  base: z.number().nonnegative(),
  negotiable: z.number().nonnegative(),
  delegation: z.number().nonnegative(),
  maxExtensionRequests: z.number().nonnegative().default(3),
  maxToolCallsPerTurn: z.number().positive().default(10),
  /** Session-level tool call limit per routing level (§5: 0/0/20/50 for L0-L3). */
  maxToolCalls: z.number().nonnegative().default(50),
  delegationDepth: z.number().nonnegative().default(0),
  maxDelegationDepth: z.number().nonnegative().default(3),
});

export type AgentBudget = z.infer<typeof AgentBudgetSchema>;

/** Terminate reasons for session close */
export const TerminateReasonSchema = z.enum([
  'budget_exceeded',
  'turns_exceeded',
  'timeout',
  'guardrail_violation',
  'orchestrator_abort',
]);
export type TerminateReason = z.infer<typeof TerminateReasonSchema>;

/** Agent session summary — retry context (inline schema to avoid circular imports) */
const AgentSessionSummarySchema = z.object({
  sessionId: z.string(),
  attempt: z.number(),
  outcome: z.enum(['uncertain', 'max_tokens', 'timeout', 'oracle_failed']),
  filesRead: z.array(z.string()),
  filesWritten: z.array(z.string()),
  turnsCompleted: z.number(),
  tokensConsumed: z.number(),
  failurePoint: z.string(),
  lastIntent: z.string(),
  uncertainties: z.array(z.string()),
  suggestedNextStep: z.string().optional(),
});

/**
 * Subagent type taxonomy (Phase 7c-1). Mirrors Claude Code's Agent tool
 * subagent_type parameter. Unknown values MUST degrade to 'general-purpose'
 * downstream — see `normalizeSubagentType` in shared-prompt-sections.ts.
 *
 * Declared ahead of OrchestratorTurnSchema because the `init` variant references
 * it — z.discriminatedUnion evaluates its argument eagerly, so any forward
 * reference becomes a runtime "cannot access before initialization" error.
 */
export const SubagentTypeSchema = z.enum(['explore', 'plan', 'general-purpose']);
export type SubagentTypeProto = z.infer<typeof SubagentTypeSchema>;

/** Orchestrator → Worker turns (ndjson) */
export const OrchestratorTurnSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('init'),
    taskId: z.string(),
    goal: z.string(),
    taskType: z.enum(['code', 'reasoning']).default('code'),
    routingLevel: RoutingLevelSchema,
    perception: PerceptualHierarchySchema,
    workingMemory: WorkingMemoryStateSchema,
    plan: TaskDAGSchema.optional(),
    budget: AgentBudgetSchema,
    allowedPaths: z.array(z.string()),
    toolManifest: z.array(
      z.object({
        name: z.string(),
        description: z.string(),
        inputSchema: z.record(z.string(), z.unknown()),
        toolKind: z.enum(['executable', 'control']).optional(),
      }),
    ),
    priorAttempts: z.array(AgentSessionSummarySchema).optional(),
    understanding: TaskUnderstandingSchema.optional(),
    /** Phase 7a: M1-M4 instruction hierarchy resolved in-process, shipped to agent worker. */
    instructions: InstructionMemorySchema.optional(),
    /** Phase 7a: OS/cwd/date/git snapshot gathered in-process and forwarded to the agent worker. */
    environment: EnvironmentInfoSchema.optional(),
    /** Phase 7c-1: typed subagent role when this worker was spawned via delegate_task. */
    subagentType: SubagentTypeSchema.optional(),
    conversationHistory: z
      .array(
        z.object({
          role: z.enum(['user', 'assistant']),
          content: z.string(),
          taskId: z.string(),
          timestamp: z.number(),
          thinking: z.string().optional(),
          toolsUsed: z.array(z.string()).optional(),
          tokenEstimate: z.number(),
        }),
      )
      .optional(),
    /**
     * Phase 2 realtime streaming. When true, the worker should use
     * `provider.generateStream` on each LLM call and emit
     * `{ type: 'text_delta', ... }` frames to stdout between WorkerTurns.
     * Safe no-op when false or when the provider lacks streaming support.
     */
    stream: z.boolean().optional(),
    /** Multi-agent: specialist id selected for this task (ts-coder, writer, ...). */
    agentId: z.string().optional(),
    /** Multi-agent: specialist persona/ACL/hints shipped across the subprocess boundary. */
    agentProfile: AgentSpecSchema.optional(),
    /** Multi-agent: pre-resolved SOUL.md content — deep behavioral guidance for the specialist. */
    soulContent: z.string().optional(),
    /** Multi-agent: pre-resolved episodic context (identity + episodes + skills). */
    agentContext: AgentContextSchema.optional(),
  }),
  z.object({
    type: z.literal('tool_results'),
    turnId: z.string(),
    results: z.array(ToolResultSchema),
  }),
  z.object({
    type: z.literal('terminate'),
    reason: TerminateReasonSchema,
    message: z.string().optional(),
  }),
]);
export type OrchestratorTurn = z.infer<typeof OrchestratorTurnSchema>;

/** Worker → Orchestrator turns (ndjson) */
export const WorkerTurnSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('tool_calls'),
    turnId: z.string(),
    calls: z.array(ToolCallSchema),
    rationale: z.string(),
    tokensConsumed: z.number().optional(),
  }),
  z.object({
    type: z.literal('done'),
    turnId: z.string(),
    proposedContent: z.string().optional(),
    tokensConsumed: z.number().optional(),
    cacheReadTokens: z.number().optional(),
    cacheCreationTokens: z.number().optional(),
  }),
  z.object({
    type: z.literal('uncertain'),
    turnId: z.string(),
    reason: z.string(),
    uncertainties: z.array(z.string()),
    suggestedNextStep: z.string().optional(),
    tokensConsumed: z.number().optional(),
    cacheReadTokens: z.number().optional(),
    cacheCreationTokens: z.number().optional(),
    /**
     * Agent Conversation: when true, the `uncertainties` are questions to the
     * user (not code-fact uncertainties). Orchestrator surfaces them as a
     * clarification request instead of retrying/escalating. Default false.
     */
    needsUserInput: z.boolean().optional(),
  }),
]);
export type WorkerTurn = z.infer<typeof WorkerTurnSchema>;

/** Delegation request from worker */
export const DelegationRequestSchema = z.object({
  goal: z.string(),
  targetFiles: z.array(z.string()),
  requiredTools: z.array(z.string()).optional(),
  context: z.string().optional(),
  requestedTokens: z.number().optional(),
  /**
   * Phase 7c-1: typed subagents. Lets the parent narrow the child's tool
   * manifest and role framing. Optional for backwards compatibility —
   * omitted → treated as 'general-purpose'.
   */
  subagentType: SubagentTypeSchema.optional(),
  /**
   * Multi-agent: route the delegated subtask to a specific peer agent
   * (e.g., 'system-designer', 'writer'). The child inherits that peer's
   * persona, ACL, and skills. Governance rules (depth, budget, scope) are
   * unchanged — this only selects which specialist does the work.
   */
  targetAgentId: z.string().optional(),
});
export type DelegationRequest = z.infer<typeof DelegationRequestSchema>;

/**
 * Peer consultation request from worker.
 *
 * Agent Conversation — consult_peer tool (PR #7): a lightweight
 * synchronous request to a DIFFERENT reasoning engine than the one
 * currently executing the worker. Distinct from `delegate_task`
 * because it does NOT spawn a full child pipeline — just a single
 * LLM call to the peer, returning a structured `PeerOpinion` with
 * A5 heuristic-tier capped confidence.
 *
 * A1 (Epistemic Separation): the peer engine MUST have a different
 * `id` from the worker's current engine; `handleConsultPeer` in
 * agent-loop.ts enforces this.
 */
export const PeerConsultRequestSchema = z.object({
  /** The question the worker wants a second opinion on. Be specific. */
  question: z.string().min(1),
  /**
   * Optional minimal context the peer needs to answer. The peer does
   * NOT have access to the worker's full conversation history, tools,
   * or perception — the worker must include any relevant snippets.
   */
  context: z.string().optional(),
  /**
   * Hint for how many tokens the peer's response can use. Capped by
   * the server at ~2000 regardless of the requested value.
   */
  requestedTokens: z.number().optional(),
});
export type PeerConsultRequest = z.infer<typeof PeerConsultRequestSchema>;

/**
 * A structured second opinion returned by `consult_peer`. The worker
 * receives this as JSON inside a `ToolResult.output` string and can
 * decide whether to act on it — the opinion is ADVISORY, not binding.
 *
 * A5: confidence is hardcoded to the heuristic tier cap (0.7) by
 * `handleConsultPeer` regardless of what the peer LLM self-reports,
 * because peer output is inherently `llm-self-report` tier.
 */
export interface PeerOpinion {
  /** The peer's advisory answer. */
  opinion: string;
  /** Capped at 0.7 (A5 heuristic tier) by handleConsultPeer. */
  confidence: number;
  /** Always 'llm-self-report' — peer confidence is self-reported. */
  confidenceSource: 'llm-self-report';
  /** Identifies the peer engine that produced the opinion (for audit). */
  peerEngineId: string;
  /** Tokens consumed by the peer call (informational). */
  tokensUsed: { input: number; output: number };
  /** Wall-clock duration of the peer call in milliseconds. */
  durationMs: number;
}
