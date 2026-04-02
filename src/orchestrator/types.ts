/**
 * Orchestrator types — Phase 1 foundation.
 * Source of truth: spec/tdd.md §2 (L3 interfaces), §16 (Core Loop), §17 (Generator), §18 (Tools)
 *
 * These types define the Orchestrator's type system. Phase 0 code does not import these;
 * they exist to enable Phase 1 development without modifying Phase 0 interfaces.
 */
import type { Evidence, OracleVerdict, QualityScore } from '../core/types.ts';

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
  latencyBudgetMs: number;
  mandatoryOracles?: string[]; // Phase 2.6: require-oracle rules add entries here
  riskThresholdOverride?: number; // Phase 2.6: adjust-threshold rules set this
  workerId?: string; // Phase 4.4: selected worker profile ID
  riskScore?: number; // WP-4: computed risk score (0.0-1.0)
}

/** Input factors for risk scoring (→ TDD §6) */
export interface RiskFactors {
  blastRadius: number; // files affected (from dep-oracle)
  dependencyDepth: number; // max depth in import chain
  testCoverage: number; // 0.0–1.0
  fileVolatility: number; // git commits in last 30 days
  irreversibility: number; // 0.0–1.0 (see §6 Irreversibility Scoring)
  hasSecurityImplication: boolean;
  environmentType: 'development' | 'staging' | 'production';
}

// ---------------------------------------------------------------------------
// Task lifecycle (→ TDD §16)
// ---------------------------------------------------------------------------

/** Input to the Orchestrator core loop */
export interface TaskInput {
  id: string;
  source: 'cli' | 'api' | 'mcp' | 'a2a';
  goal: string; // Natural language task description
  targetFiles?: string[]; // Optional explicit scope
  constraints?: string[]; // User-specified constraints
  acceptanceCriteria?: string[]; // Optional semantic acceptance criteria (WP-2: critic rubric)
  budget: {
    maxTokens: number; // Total tokens for this task
    maxDurationMs: number; // Wall-clock timeout
    maxRetries: number; // Default: 3 per routing level
  };
}

/** Output of the Orchestrator core loop */
export interface TaskResult {
  id: string;
  status: 'completed' | 'failed' | 'escalated' | 'uncertain';
  mutations: Array<{
    file: string;
    diff: string; // Unified diff
    oracleVerdicts: Record<string, OracleVerdict>;
  }>;
  trace: ExecutionTrace;
  qualityScore?: QualityScore;
  escalationReason?: string; // If status === 'escalated'
  notes?: string[]; // Phase 4: audit notes (e.g., probation-shadow-only, uncertain)
  contradictions?: string[]; // Populated when conflict resolver detects contradictory verdicts
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
  frameworkMarkers?: string[]; // Phase 4: detected frameworks (e.g., 'react', 'express')
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
  priorAttempts?: AgentSessionSummary[];
}

// ---------------------------------------------------------------------------
// Self-Model (→ TDD §12, arch D11)
// ---------------------------------------------------------------------------

/** Self-Model prediction before task execution */
export interface SelfModelPrediction {
  taskId: string;
  timestamp: number;
  expectedTestResults: 'pass' | 'fail' | 'partial';
  expectedBlastRadius: number;
  expectedDuration: number;
  expectedQualityScore: number;
  uncertainAreas: string[];
  confidence: number; // 0.0–1.0
  metaConfidence: number; // forced < 0.3 when < 10 observations
  basis: 'static-heuristic' | 'trace-calibrated' | 'hybrid';
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
    testResults: 'pass' | 'fail' | 'partial';
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
  workspaceMount: string; // host path, mounted :ro
  overlayDir: string; // ephemeral writable layer (host tmpdir)
  ipcDir: string; // IPC channel dir (host tmpdir)
  containerId?: string; // docker container ID for kill
}

// ---------------------------------------------------------------------------
// Shadow validation (→ Phase 2.2)
// ---------------------------------------------------------------------------

/** Durable shadow job — persisted to SQLite before online response returns (A6 crash-safety) */
export interface ShadowJob {
  id: string;
  taskId: string;
  status: 'pending' | 'running' | 'done' | 'failed';
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
  durationMs: number;
  timestamp: number;
  alternativeWorkerId?: string; // PH4.2: probation worker that produced this shadow result
}

// ---------------------------------------------------------------------------
// Data sufficiency gates (→ Phase 2 progressive activation)
// ---------------------------------------------------------------------------

/** Data gate metric types for progressive feature activation */
export type DataGateMetric =
  | 'trace_count'
  | 'distinct_task_types'
  | 'patterns_extracted'
  | 'active_skills'
  | 'sleep_cycles_run'
  | 'active_workers' // Phase 4: registered active worker profiles
  | 'worker_trace_diversity'; // Phase 4: traces with >1 distinct model_used

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
  type: 'anti-pattern' | 'success-pattern' | 'worker-performance';
  description: string;
  frequency: number; // occurrence count in traces
  confidence: number; // Wilson score lower bound
  taskTypeSignature: string; // task pattern for matching
  approach?: string; // for success patterns: the winning approach
  comparedApproach?: string; // for success patterns: the losing approach
  qualityDelta?: number; // composite improvement
  sourceTraceIds: string[]; // provenance
  createdAt: number;
  expiresAt?: number; // decay TTL
  decayWeight: number; // current weight after exponential decay
  routingLevel?: number; // PH3.3: level at which failure occurred (for proportional escalation)
  oracleName?: string; // PH3.3: oracle that flagged the issue (multi-condition rules)
  riskAbove?: number; // PH3.3: risk threshold context
  modelPattern?: string; // PH3.3: model that exhibited the pattern
  derivedFrom?: string; // PH3.5: parent pattern ID (lineage tracking)
  workerId?: string; // PH4: worker that exhibited the pattern
  comparedWorkerId?: string; // PH4: worker compared against (for worker-performance)
}

/** Sleep Cycle configuration */
export interface SleepCycleConfig {
  intervalSessions: number; // default: 20
  minTracesForAnalysis: number; // minimum traces before analysis runs
  patternMinFrequency: number; // minimum occurrences to extract pattern
  patternMinConfidence: number; // statistical threshold (Wilson LB)
  decayHalfLifeSessions: number; // pattern relevance decay
}

// ---------------------------------------------------------------------------
// Skill Formation — cached approaches (→ TDD §12B, Phase 2.5)
// ---------------------------------------------------------------------------

/** Cached solution pattern — L0 Reflex shortcut */
export interface CachedSkill {
  taskSignature: string; // pattern hash for matching
  approach: string; // proven strategy
  successRate: number; // must be >= min_effectiveness (default: 0.7)
  status: 'probation' | 'active' | 'demoted';
  probationRemaining: number; // sessions until promotion (default: 10)
  usageCount: number;
  riskAtCreation: number;
  depConeHashes: Record<string, string>; // file → hash at skill creation time
  lastVerifiedAt: number; // timestamp of last full re-verification
  verificationProfile: 'hash-only' | 'structural' | 'full';
  confidence?: number; // PH3.4: fuzzy match confidence (omitted = exact match)
  origin?: 'local' | 'a2a' | 'mcp'; // PH5: instance provenance
}

// ---------------------------------------------------------------------------
// Evolution Engine — rule-based self-modification (→ TDD §2, Phase 2.6)
// ---------------------------------------------------------------------------

/** Evolution Engine output — pattern-mined rules */
export interface EvolutionaryRule {
  id: string;
  source: 'sleep-cycle' | 'manual';
  condition: {
    filePattern?: string;
    oracleName?: string;
    riskAbove?: number;
    modelPattern?: string;
  };
  action: 'escalate' | 'require-oracle' | 'prefer-model' | 'adjust-threshold' | 'assign-worker';
  parameters: Record<string, unknown>;
  status: 'probation' | 'active' | 'retired';
  createdAt: number;
  effectiveness: number;
  specificity: number; // count of non-null condition fields
  supersededBy?: string; // rule ID that replaced this via conflict resolution
  origin?: 'local' | 'a2a' | 'mcp'; // PH5: instance provenance
}

// ---------------------------------------------------------------------------
// Execution traces (→ TDD §12B)
// ---------------------------------------------------------------------------

/** Recorded after each task for Self-Model calibration and Evolution Engine */
export interface ExecutionTrace {
  id: string;
  taskId: string;
  sessionId?: string; // Session grouping for multi-step tasks
  workerId?: string; // Which worker executed this step
  timestamp: number;
  routingLevel: RoutingLevel;
  action?: string; // Specific action taken (e.g., 'file_write', 'refactor')
  approach: string; // Brief description of the approach
  approachDescription?: string; // Detailed explanation for Evolution Engine
  riskScore?: number; // Risk score at time of execution
  taskTypeSignature?: string; // Sleep Cycle grouping key (goal pattern + file pattern)
  oracleVerdicts: Record<string, boolean>; // oracle_name → pass/fail
  qualityScore?: QualityScore;
  prediction?: SelfModelPrediction;
  predictionError?: PredictionError; // Full prediction error, not just a number
  successPatternTag?: string; // Tag for Evolution Engine pattern extraction
  modelUsed: string;
  tokensConsumed: number;
  durationMs: number;
  outcome: 'success' | 'failure' | 'timeout' | 'escalated';
  failureReason?: string;
  affectedFiles: string[];
  // Phase 2.2 — shadow validation (async, post-commit)
  shadowValidation?: ShadowValidationResult;
  validationDepth?: 'structural' | 'structural_and_tests' | 'full_shadow';
  exploration?: boolean; // PH3.6: true if epsilon-greedy exploration was used
  oracleFailurePattern?: string; // WP-5: sorted failed oracle names joined by "+" (e.g., "lint+type")
  frameworkMarkers?: string[]; // PH4: detected framework markers (e.g., 'react', 'express')
  workerSelectionAudit?: WorkerSelectionResult; // PH4: worker selection audit trail
  correlationId?: string; // WP-5: cross-instance request tracing
  sourceInstanceId?: string; // WP-5: originating instance ID
  /** EHD Phase 3: Aggregate verification confidence from the gate verdict. */
  verificationConfidence?: number;
  /** EHD Phase 3: 4-state epistemic decision from the gate. */
  epistemicDecision?: 'allow' | 'allow-with-caveats' | 'uncertain' | 'block';
  /** EHD Phase 3: Confidence-based action taken for this task. */
  confidenceDecision?: {
    action: 'allow' | 're-verify' | 'retry' | 'escalate' | 'refuse';
    confidence: number;
    reason?: string;
  };
  /** EHD Phase 3: Why the task was escalated (confidence vs. failure). */
  escalationReason?: 'uncertain-verification' | 'low-pipeline-confidence';
  /** EHD Phase 3B: Pipeline-level composite confidence (geometric mean across 6 steps). */
  pipelineConfidence?: { composite: number; formula: string };
  /** Phase 6 §43: gzip-compressed transcript from agentic session (Bun.gzip). */
  transcriptGzip?: Uint8Array;
  /** Phase 6 §43: number of turns in the agentic transcript (for stats without decompressing). */
  transcriptTurns?: number;
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
  /** True when decomposition failed and a single-node fallback was used. */
  isFallback?: boolean;
}

/** 5 machine-checkable criteria for DAG validation */
export interface DagValidationCriteria {
  noOrphans: boolean;
  noScopeOverlap: boolean;
  coverage: boolean;
  validDependencyOrder: boolean;
  verificationSpecified: boolean;
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
  durationMs: number;
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
  status: 'success' | 'error' | 'denied';
  output?: unknown;
  error?: string;
  evidence?: Evidence; // For A4 compliance — file tools produce content hashes
  durationMs: number;
}

// ---------------------------------------------------------------------------
// LLM Generator Engine (→ TDD §17)
// ---------------------------------------------------------------------------

/** LLM provider abstraction */
export interface LLMProvider {
  id: string;
  tier: 'fast' | 'balanced' | 'powerful';
  capabilities?: string[]; // e.g., ['tool_use', 'vision', 'long_context']
  maxContextTokens?: number; // Provider's context window size
  supportsToolUse?: boolean; // Whether provider supports tool_use stop reason
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
  messages?: HistoryMessage[];
}

/** Response from an LLM provider */
export interface LLMResponse {
  content: string;
  thinking?: string;
  toolCalls: ToolCall[];
  tokensUsed: { input: number; output: number };
  model: string;
  stopReason: 'end_turn' | 'tool_use' | 'max_tokens';
}

// ---------------------------------------------------------------------------
// Multi-turn message history (→ Phase 6: Agentic Worker Protocol)
// ---------------------------------------------------------------------------

/** A single message in the conversation history */
export interface Message {
  role: 'system' | 'user' | 'assistant';
  content: string;
  thinking?: string;
  toolCalls?: ToolCall[];
}

/** Tool result — normalized to canonical form, provider-format.ts maps at call time */
export interface ToolResultMessage {
  role: 'tool_result';
  toolCallId: string;
  content: string;
  isError?: boolean;
}

/** Union of all message types in conversation history */
export type HistoryMessage = Message | ToolResultMessage;

/** Retry context — built by agent-loop on uncertain/failure for next attempt */
export interface AgentSessionSummary {
  sessionId: string;
  attempt: number;
  outcome: 'uncertain' | 'max_tokens' | 'timeout' | 'oracle_failed';
  filesRead: string[];
  filesWritten: string[];
  turnsCompleted: number;
  tokensConsumed: number;
  failurePoint: string;
  lastIntent: string;
  uncertainties: string[];
  suggestedNextStep?: string;
}

// ---------------------------------------------------------------------------
// Worker Profiles — Fleet Governance (→ Phase 4)
// ---------------------------------------------------------------------------

/** Worker profile status lifecycle: probation → active → demoted → retired */
export type WorkerProfileStatus = 'probation' | 'active' | 'demoted' | 'retired';

/** First-class worker identity — pairs config with empirical performance data */
export interface WorkerProfile {
  id: string; // "worker-{modelBase}-{tempBucket}-{hash(config)}"
  config: WorkerConfig;
  status: WorkerProfileStatus;
  createdAt: number;
  promotedAt?: number;
  demotedAt?: number;
  demotionReason?: string;
  demotionCount: number; // 3 demotions = permanent retirement
}

/** Worker configuration — identity dimensions */
export interface WorkerConfig {
  modelId: string; // base model name, e.g., "claude-sonnet"
  modelVersion?: string; // specific version for audit trail
  temperature: number; // quantized to 0.1 increments
  toolAllowlist?: string[]; // if empty/undefined, all tools allowed
  systemPromptTemplate?: string; // template ID or "default"
  maxContextTokens?: number;
}

/** Worker stats — computed on-demand from traces via SQL aggregates, 60s TTL cache */
export interface WorkerStats {
  totalTasks: number;
  successRate: number;
  avgQualityScore: number;
  avgDurationMs: number;
  avgTokenCost: number;
  taskTypeBreakdown: Record<
    string,
    {
      count: number;
      successRate: number;
      avgQuality: number;
      avgTokens: number;
    }
  >;
  lastActiveAt: number;
}

// ---------------------------------------------------------------------------
// Task Fingerprinting (→ Phase 4.3)
// ---------------------------------------------------------------------------

/** 5-dimension task fingerprint for capability matching */
export interface TaskFingerprint {
  actionVerb: string; // e.g., "refactor", "fix", "add", "test"
  fileExtensions: string[]; // e.g., [".ts", ".tsx"]
  blastRadiusBucket: 'single' | 'small' | 'medium' | 'large'; // 1, 2-5, 6-20, 21+
  frameworkMarkers?: string[]; // e.g., ["react", "express", "zod"]
  oracleFailurePattern?: string; // e.g., "type-fails", "test-fails"
}

// ---------------------------------------------------------------------------
// Worker Selection (→ Phase 4.4)
// ---------------------------------------------------------------------------

/** Result of capability-based worker selection — audit trail */
export interface WorkerSelectionResult {
  selectedWorkerId: string;
  reason: 'capability-score' | 'exploration' | 'tier-fallback' | 'assign-worker-rule' | 'uncertain';
  score: number;
  alternatives: Array<{
    workerId: string;
    score: number;
  }>;
  explorationTriggered: boolean;
  dataGateMet: boolean;
  maxCapability?: number; // Phase 4: fleet max capability for this fingerprint
  isUncertain?: boolean; // Phase 4: true if all workers below capability threshold (A2)
}
