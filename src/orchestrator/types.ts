/**
 * Orchestrator types — Phase 1 foundation.
 * Source of truth: vinyan-tdd.md §2 (L3 interfaces), §16 (Core Loop), §17 (Generator), §18 (Tools)
 *
 * These types define the Orchestrator's type system. Phase 0 code does not import these;
 * they exist to enable Phase 1 development without modifying Phase 0 interfaces.
 */
import type { OracleVerdict, QualityScore, Evidence } from "../core/types.ts";

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

/** 4-level routing continuum (→ concept §8, arch D4) */
export type RoutingLevel = 0 | 1 | 2 | 3;

/** Worker isolation level — maps to routing level but can be overridden */
export type IsolationLevel = 0 | 1 | 2;
// 0 = in-process (L0 tasks)
// 1 = child_process.fork (L1-L2 tasks)
// 2 = Docker container (L2-L3 tasks, Phase 2)

/** Protocol version for IPC serialization — bump when WorkerInput/WorkerOutput shape changes. */
export const ECP_PROTOCOL_VERSION = 1 as const;
export type ECPProtocolVersion = typeof ECP_PROTOCOL_VERSION;

/** Output of risk assessment → drives routing */
export interface RoutingDecision {
  level: RoutingLevel;
  model: string | null; // null for L0 (cached/skip)
  budgetTokens: number;
  latencyBudget_ms: number;
  mandatoryOracles?: string[];       // Phase 2.6: require-oracle rules add entries here
  riskThresholdOverride?: number;    // Phase 2.6: adjust-threshold rules set this
}

/** Input factors for risk scoring (→ TDD §6) */
export interface RiskFactors {
  blastRadius: number; // files affected (from dep-oracle)
  dependencyDepth: number; // max depth in import chain
  testCoverage: number; // 0.0–1.0
  fileVolatility: number; // git commits in last 30 days
  irreversibility: number; // 0.0–1.0 (see §6 Irreversibility Scoring)
  hasSecurityImplication: boolean;
  environmentType: "development" | "staging" | "production";
}

// ---------------------------------------------------------------------------
// Task lifecycle (→ TDD §16)
// ---------------------------------------------------------------------------

/** Input to the Orchestrator core loop */
export interface TaskInput {
  id: string;
  source: "cli" | "api" | "mcp";
  goal: string; // Natural language task description
  targetFiles?: string[]; // Optional explicit scope
  constraints?: string[]; // User-specified constraints
  budget: {
    maxTokens: number; // Total tokens for this task
    maxDurationMs: number; // Wall-clock timeout
    maxRetries: number; // Default: 3 per routing level
  };
}

/** Output of the Orchestrator core loop */
export interface TaskResult {
  id: string;
  status: "completed" | "failed" | "escalated";
  mutations: Array<{
    file: string;
    diff: string; // Unified diff
    oracleVerdicts: Record<string, OracleVerdict>;
  }>;
  trace: ExecutionTrace;
  qualityScore?: QualityScore;
  escalationReason?: string; // If status === 'escalated'
}

// ---------------------------------------------------------------------------
// Perception & Memory (→ TDD §2 L3, arch D8)
// ---------------------------------------------------------------------------

/** Structured perception assembled per routing level */
export interface PerceptualHierarchy {
  taskTarget: {
    file: string;
    symbol?: string;
    description: string;
  };
  dependencyCone: {
    directImporters: string[];
    directImportees: string[];
    transitiveBlastRadius: number;
    transitiveImporters?: string[]; // L2-L3 only
    affectedTestFiles?: string[]; // L2-L3 only
  };
  diagnostics: {
    lintWarnings: Array<{ file: string; line: number; message: string }>;
    typeErrors: Array<{ file: string; line: number; message: string }>;
    failingTests: string[];
  };
  verifiedFacts: Array<{
    target: string;
    pattern: string;
    verified_at: number;
    hash: string;
  }>;
  runtime: {
    nodeVersion: string;
    os: string;
    availableTools: string[];
  };
}

/** Per-task working memory — tracks failed approaches and uncertainties */
export interface WorkingMemoryState {
  failedApproaches: Array<{
    approach: string;
    oracleVerdict: string; // which oracle rejected + evidence
    timestamp: number;
  }>;
  activeHypotheses: Array<{
    hypothesis: string;
    confidence: number;
    source: string;
  }>;
  unresolvedUncertainties: Array<{
    area: string;
    selfModelConfidence: number;
    suggestedAction: string;
  }>;
  scopedFacts: Array<{
    target: string;
    pattern: string;
    verified: boolean;
    hash: string;
  }>;
}

// ---------------------------------------------------------------------------
// Self-Model (→ TDD §12, arch D11)
// ---------------------------------------------------------------------------

/** Self-Model prediction before task execution */
export interface SelfModelPrediction {
  taskId: string;
  timestamp: number;
  expectedTestResults: "pass" | "fail" | "partial";
  expectedBlastRadius: number;
  expectedDuration: number;
  expectedQualityScore: number;
  uncertainAreas: string[];
  confidence: number; // 0.0–1.0
  metaConfidence: number; // forced < 0.3 when < 10 observations
  basis: "static-heuristic" | "trace-calibrated" | "hybrid";
  calibrationDataPoints: number;
  /** S1: Cold-start safeguard — force minimum routing level for first N tasks */
  forceMinLevel?: number;
  /** S3: Audit sampling flag — 10% probability for first 100 tasks */
  auditSample?: boolean;
}

/** A7: Primary learning signal — delta(predicted, actual) */
export interface PredictionError {
  taskId: string;
  predicted: SelfModelPrediction;
  actual: {
    testResults: "pass" | "fail" | "partial";
    blastRadius: number;
    duration: number;
    qualityScore: number;
  };
  error: {
    testResultMatch: boolean;
    blastRadiusDelta: number;
    durationDelta: number;
    qualityScoreDelta: number;
    composite: number;
  };
}

// ---------------------------------------------------------------------------
// L2 Container workspace (→ Phase 2.1)
// ---------------------------------------------------------------------------

/** L2 container workspace configuration — two-layer mount strategy */
export interface ContainerWorkspace {
  workspaceMount: string;      // host path, mounted :ro
  overlayDir: string;          // ephemeral writable layer (host tmpdir)
  ipcDir: string;              // IPC channel dir (host tmpdir)
  containerId?: string;        // docker container ID for kill
}

// ---------------------------------------------------------------------------
// Shadow validation (→ Phase 2.2)
// ---------------------------------------------------------------------------

/** Durable shadow job — persisted to SQLite before online response returns (A6 crash-safety) */
export interface ShadowJob {
  id: string;
  taskId: string;
  status: "pending" | "running" | "done" | "failed";
  enqueuedAt: number;
  startedAt?: number;
  completedAt?: number;
  result?: ShadowValidationResult;
  retryCount: number;
  maxRetries: number; // default: 1
}

/** Shadow validation result — async, post-commit */
export interface ShadowValidationResult {
  taskId: string;
  testsPassed: boolean;
  testResults?: {
    total: number;
    passed: number;
    failed: number;
    skipped: number;
  };
  pheAlternatives?: Array<{
    workerId: string;
    qualityScore: QualityScore;
    betterThanOnline: boolean;
  }>;
  duration_ms: number;
  timestamp: number;
}

// ---------------------------------------------------------------------------
// Data sufficiency gates (→ Phase 2 progressive activation)
// ---------------------------------------------------------------------------

/** Data gate metric types for progressive feature activation */
export type DataGateMetric =
  | "trace_count"
  | "distinct_task_types"
  | "patterns_extracted"
  | "active_skills"
  | "sleep_cycles_run";

/** Data sufficiency gate — checked before Phase 2 sub-feature activation */
export interface DataGate {
  feature: string;
  conditions: Array<{
    metric: DataGateMetric;
    threshold: number;
    current: number;
  }>;
  satisfied: boolean;
}

// ---------------------------------------------------------------------------
// Sleep Cycle — pattern detection (→ TDD §12B, Phase 2.4)
// ---------------------------------------------------------------------------

/** Pattern extracted by Sleep Cycle analysis */
export interface ExtractedPattern {
  id: string;
  type: "anti-pattern" | "success-pattern";
  description: string;
  frequency: number;                     // occurrence count in traces
  confidence: number;                    // Wilson score lower bound
  taskTypeSignature: string;             // task pattern for matching
  approach?: string;                     // for success patterns: the winning approach
  comparedApproach?: string;             // for success patterns: the losing approach
  qualityDelta?: number;                 // composite improvement
  sourceTraceIds: string[];              // provenance
  createdAt: number;
  expiresAt?: number;                    // decay TTL
  decayWeight: number;                   // current weight after exponential decay
}

/** Sleep Cycle configuration */
export interface SleepCycleConfig {
  interval_sessions: number;             // default: 20
  min_traces_for_analysis: number;       // minimum traces before analysis runs
  pattern_min_frequency: number;         // minimum occurrences to extract pattern
  pattern_min_confidence: number;        // statistical threshold (Wilson LB)
  decay_half_life_sessions: number;      // pattern relevance decay
}

// ---------------------------------------------------------------------------
// Skill Formation — cached approaches (→ TDD §12B, Phase 2.5)
// ---------------------------------------------------------------------------

/** Cached solution pattern — L0 Reflex shortcut */
export interface CachedSkill {
  taskSignature: string;                 // pattern hash for matching
  approach: string;                      // proven strategy
  successRate: number;                   // must be >= min_effectiveness (default: 0.7)
  status: "probation" | "active" | "demoted";
  probationRemaining: number;            // sessions until promotion (default: 10)
  usageCount: number;
  riskAtCreation: number;
  depConeHashes: Record<string, string>; // file → hash at skill creation time
  lastVerifiedAt: number;                // timestamp of last full re-verification
  verificationProfile: "hash-only" | "structural" | "full";
}

// ---------------------------------------------------------------------------
// Evolution Engine — rule-based self-modification (→ TDD §2, Phase 2.6)
// ---------------------------------------------------------------------------

/** Evolution Engine output — pattern-mined rules */
export interface EvolutionaryRule {
  id: string;
  source: "sleep-cycle" | "manual";
  condition: {
    file_pattern?: string;
    oracle_name?: string;
    risk_above?: number;
    model_pattern?: string;
  };
  action: "escalate" | "require-oracle" | "prefer-model" | "adjust-threshold";
  parameters: Record<string, unknown>;
  status: "probation" | "active" | "retired";
  created_at: number;
  effectiveness: number;
  specificity: number;                   // count of non-null condition fields
  superseded_by?: string;                // rule ID that replaced this via conflict resolution
}

// ---------------------------------------------------------------------------
// Execution traces (→ TDD §12B)
// ---------------------------------------------------------------------------

/** Recorded after each task for Self-Model calibration and Evolution Engine */
export interface ExecutionTrace {
  id: string;
  taskId: string;
  session_id?: string;                     // Session grouping for multi-step tasks
  worker_id?: string;                      // Which worker executed this step
  timestamp: number;
  routingLevel: RoutingLevel;
  action?: string;                         // Specific action taken (e.g., 'file_write', 'refactor')
  approach: string;                        // Brief description of the approach
  approach_description?: string;           // Detailed explanation for Evolution Engine
  risk_score?: number;                     // Risk score at time of execution
  task_type_signature?: string;            // Sleep Cycle grouping key (goal pattern + file pattern)
  oracleVerdicts: Record<string, boolean>; // oracle_name → pass/fail
  qualityScore?: QualityScore;
  prediction?: SelfModelPrediction;
  predictionError?: PredictionError;       // Full prediction error, not just a number
  success_pattern_tag?: string;            // Tag for Evolution Engine pattern extraction
  model_used: string;
  tokens_consumed: number;
  duration_ms: number;
  outcome: "success" | "failure" | "timeout" | "escalated";
  failure_reason?: string;
  affected_files: string[];
  // Phase 2.2 — shadow validation (async, post-commit)
  shadow_validation?: ShadowValidationResult;
  validation_depth?: "structural" | "structural_and_tests" | "full_shadow";
}

// ---------------------------------------------------------------------------
// Task decomposition (→ TDD §10, arch D7)
// ---------------------------------------------------------------------------

/** DAG of subtasks produced by LLM-assisted decomposition */
export interface TaskDAG {
  nodes: Array<{
    id: string;
    description: string;
    targetFiles: string[];
    dependencies: string[]; // IDs of nodes this depends on
    assignedOracles: string[];
  }>;
}

/** 5 machine-checkable criteria for DAG validation */
export interface DagValidationCriteria {
  no_orphans: boolean;
  no_scope_overlap: boolean;
  coverage: boolean;
  valid_dependency_order: boolean;
  verification_specified: boolean;
}

// ---------------------------------------------------------------------------
// Worker (→ TDD §11, §16.3)
// ---------------------------------------------------------------------------

/** Input sent to a worker process (crosses process boundary → needs Zod validation) */
export interface WorkerInput {
  taskId: string;
  goal: string;
  routingLevel: RoutingLevel;
  perception: PerceptualHierarchy;
  workingMemory: WorkingMemoryState;
  plan?: TaskDAG;
  budget: {
    maxTokens: number;
    timeoutMs: number;
  };
  allowedPaths: string[];
  isolationLevel: IsolationLevel;
}

/** Output from a worker process */
export interface WorkerOutput {
  taskId: string;
  proposedMutations: Array<{
    file: string;
    content: string;
    explanation: string;
  }>;
  proposedToolCalls: ToolCall[];
  uncertainties: string[];
  tokensConsumed: number;
  duration_ms: number;
}

// ---------------------------------------------------------------------------
// Tools (→ TDD §18)
// ---------------------------------------------------------------------------

/** A tool call proposed by a worker */
export interface ToolCall {
  id: string;
  tool: string;
  parameters: Record<string, unknown>;
}

/** Result of executing a tool call */
export interface ToolResult {
  callId: string;
  tool: string;
  status: "success" | "error" | "denied";
  output?: unknown;
  error?: string;
  evidence?: Evidence; // For A4 compliance — file tools produce content hashes
  duration_ms: number;
}

// ---------------------------------------------------------------------------
// LLM Generator Engine (→ TDD §17)
// ---------------------------------------------------------------------------

/** LLM provider abstraction */
export interface LLMProvider {
  id: string;
  tier: "fast" | "balanced" | "powerful";
  capabilities?: string[];                 // e.g., ['tool_use', 'vision', 'long_context']
  maxContextTokens?: number;               // Provider's context window size
  supportsToolUse?: boolean;               // Whether provider supports tool_use stop reason
  generate(request: LLMRequest): Promise<LLMResponse>;
}

/** Request to an LLM provider */
export interface LLMRequest {
  systemPrompt: string;
  userPrompt: string;
  maxTokens: number;
  temperature?: number;
  tools?: Array<{
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  }>;
}

/** Response from an LLM provider */
export interface LLMResponse {
  content: string;
  toolCalls: ToolCall[];
  tokensUsed: { input: number; output: number };
  model: string;
  stopReason: "end_turn" | "tool_use" | "max_tokens";
}
