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
  priorAttempts: z.array(z.object({
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
  })).optional(),
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

const TaskUnderstandingSchema = z.object({
  rawGoal: z.string(),
  actionVerb: z.string(),
  actionCategory: z.enum(['mutation', 'analysis', 'investigation', 'design', 'qa']),
  targetSymbol: z.string().optional(),
  frameworkContext: z.array(z.string()),
  constraints: z.array(z.string()),
  acceptanceCriteria: z.array(z.string()),
  expectsMutation: z.boolean(),
  fingerprint: TaskFingerprintSchema.optional(),
}).passthrough(); // Layer 1/2 fields (resolvedEntities, semanticIntent) survive IPC serialization

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
    toolManifest: z.array(z.object({
      name: z.string(),
      description: z.string(),
      inputSchema: z.record(z.string(), z.unknown()),
      toolKind: z.enum(['executable', 'control']).optional(),
    })),
    priorAttempts: z.array(AgentSessionSummarySchema).optional(),
    understanding: TaskUnderstandingSchema.optional(),
    conversationHistory: z.array(z.object({
      role: z.enum(['user', 'assistant']),
      content: z.string(),
      taskId: z.string(),
      timestamp: z.number(),
      thinking: z.string().optional(),
      toolsUsed: z.array(z.string()).optional(),
      tokenEstimate: z.number(),
    })).optional(),
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
  }),
  z.object({
    type: z.literal('uncertain'),
    turnId: z.string(),
    reason: z.string(),
    uncertainties: z.array(z.string()),
    suggestedNextStep: z.string().optional(),
    tokensConsumed: z.number().optional(),
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
});
export type DelegationRequest = z.infer<typeof DelegationRequestSchema>;
