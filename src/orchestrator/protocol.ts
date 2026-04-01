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
});

const RuntimeInfoSchema = z.object({
  nodeVersion: z.string(),
  os: z.string(),
  availableTools: z.array(z.string()),
});

export const PerceptualHierarchySchema = z.object({
  taskTarget: TaskTargetSchema,
  dependencyCone: DependencyConeSchema,
  diagnostics: DiagnosticsSchema,
  verifiedFacts: z.array(VerifiedFactRefSchema),
  runtime: RuntimeInfoSchema,
  frameworkMarkers: z.array(z.string()).optional(),
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

// ── WorkerInput (stdin → worker) ─────────────────────────────────────

const WorkerBudgetSchema = z.object({
  maxTokens: z.number().positive(),
  timeoutMs: z.number().positive(),
});

export const WorkerInputSchema = z.object({
  taskId: z.string(),
  goal: z.string(),
  routingLevel: RoutingLevelSchema,
  perception: PerceptualHierarchySchema,
  workingMemory: WorkingMemoryStateSchema,
  plan: TaskDAGSchema.optional(),
  budget: WorkerBudgetSchema,
  allowedPaths: z.array(z.string()),
  isolationLevel: IsolationLevelSchema,
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
  targetFiles: z.array(z.string()).optional(),
  constraints: z.array(z.string()).optional(),
  acceptanceCriteria: z.array(z.string()).optional(),
  budget: TaskBudgetSchema,
});
