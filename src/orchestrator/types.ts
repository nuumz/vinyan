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
  epistemicDeescalated?: boolean; // true if risk level was de-escalated by SelfModel epistemic signal
  /** EO #6: Self-Model calibrated reasoning budget policy. */
  reasoningPolicy?: ReasoningPolicy;
  /** Thinking configuration for this routing level. */
  thinkingConfig?: ThinkingConfig;
  /** Extensible Thinking: compiled policy from 2D routing grid (risk × uncertainty). */
  thinkingPolicy?: import('./thinking/thinking-policy.ts').ThinkingPolicy;
}

/** Epistemic signal from SelfModel — historical oracle confidence for task type.
 *  Used by RiskRouter to enable de-escalation when evidence consistently supports lower routing. */
export interface EpistemicAdjustment {
  avgOracleConfidence: number; // [0,1] — EMA of oracle aggregate confidence for this task type
  observationCount: number; // how many times this task type has been verified
  basis: 'insufficient' | 'emerging' | 'calibrated'; // <10 = insufficient, 10-30 = emerging, >30 = calibrated
  /** G4: Average tier_reliability of World Graph facts for target files.
   *  Low reliability (<0.5) prevents de-escalation even when avgOracleConfidence is high. */
  avgTierReliability?: number;
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
  /** Average tier reliability of verified facts for target files (0-1). undefined = no facts. */
  avgTierReliability?: number;
}

// ---------------------------------------------------------------------------
// Task lifecycle (→ TDD §16)
// ---------------------------------------------------------------------------

/** Task type: code tasks mutate files, reasoning tasks produce answers */
export type TaskType = 'code' | 'reasoning';

/** Action category inferred from goal verb — drives perception depth and prompt shape. */
export type ActionCategory = 'mutation' | 'analysis' | 'investigation' | 'design' | 'qa';

/**
 * Task domain — determines capability scope and tool access.
 * Classified by rule-based heuristics at Layer 0 (A3-safe, deterministic).
 *
 * Vinyan is a general-purpose task orchestrator (concept §1). Code is capability #1
 * as the bootstrap domain, but ALL tasks proceed through the pipeline.
 *
 * - code-mutation: goal involves modifying code files → full tool access
 * - code-reasoning: goal involves analyzing code without mutation → read-only tools
 * - general-reasoning: non-code questions, explanations, or tasks → no tools (LLM knowledge)
 * - conversational: greetings, casual interaction → no tools, lightweight response
 */
export type TaskDomain = 'code-mutation' | 'code-reasoning' | 'general-reasoning' | 'conversational';

/**
 * Task intent — captures WHAT the user wants the orchestrator to do.
 * Orthogonal to TaskDomain (which determines tool access/capability scope).
 *
 * - execute:  User wants Vinyan to DO something ("ช่วย capture window screen", "send email")
 * - inquire:  User wants information/explanation ("อธิบาย X", "how does Y work")
 * - converse: Social interaction, greeting, meta-questions ("สวัสดี", "คุณคือใคร")
 *
 * Concept §1: Vinyan is a task orchestrator, not a Q&A chatbot.
 * When intent=execute, the response should frame as capability assessment, not tutorial.
 */
export type TaskIntent = 'execute' | 'inquire' | 'converse';

/**
 * Whether the task requires tool execution to fulfil the user's goal.
 * Used as a capability floor: tool-needed tasks get minimum L2 (agentic with tools).
 * Orthogonal to risk score — a zero-risk task can still need tools.
 */
export type ToolRequirement = 'none' | 'tool-needed';

// ---------------------------------------------------------------------------
// Intent Resolution (pre-pipeline LLM classification)
// ---------------------------------------------------------------------------

/**
 * Execution strategy — determined by LLM Intent Resolver before the pipeline.
 * Replaces regex-based classification with semantic understanding.
 */
export type ExecutionStrategy = 'full-pipeline' | 'direct-tool' | 'conversational' | 'agentic-workflow';

/** Result of LLM-powered intent resolution. */
export interface IntentResolution {
  strategy: ExecutionStrategy;
  /** LLM-rewritten goal for clarity and precision */
  refinedGoal: string;
  /** For direct-tool: the tool call the LLM identified */
  directToolCall?: { tool: string; parameters: Record<string, unknown> };
  /** For agentic-workflow: LLM-generated workflow prompt optimized for execution */
  workflowPrompt?: string;
  /** Confidence in strategy selection (0-1) */
  confidence: number;
  /** LLM reasoning trace for observability */
  reasoning: string;
}

/** Read-only tools available for non-mutating reasoning tasks. */
export const READONLY_TOOLS = new Set([
  'file_read',
  'search_grep',
  'directory_list',
  'git_status',
  'git_diff',
  'web_search',
]);

/**
 * TaskUnderstanding — unified intermediate representation of what a task means.
 *
 * Computed once at ingestion (rule-based, A3-safe), enriched by perception,
 * consumed by prompt assembly, prediction, cross-task learning, and trace recording.
 * Eliminates dual-fingerprint inconsistency and ensures constraints/criteria reach downstream.
 */
export interface TaskUnderstanding {
  [key: string]: unknown; // passthrough fields from STU Layer 1/2 survive IPC serialization
  rawGoal: string;
  actionVerb: string;
  actionCategory: ActionCategory;
  targetSymbol?: string;
  frameworkContext: string[];
  constraints: string[];
  acceptanceCriteria: string[];
  expectsMutation: boolean;
  fingerprint?: TaskFingerprint;
}

// ── STU Layer 1: Structural Resolution (Phase A) ─────────────────────────

/** NL reference resolved to code entity. Deterministic, evidence-derived. */
export interface ResolvedEntity {
  /** The reference as it appears in the goal (e.g., "auth service"). */
  reference: string;
  /** Resolved file paths in the codebase. */
  resolvedPaths: string[];
  /** Resolution strategy used. */
  resolution: 'exact' | 'fuzzy-path' | 'fuzzy-symbol' | 'dependency-inferred';
  /** Confidence in the resolution (0-1). */
  confidence: number;
  /** Always evidence-derived for Layer 1. */
  confidenceSource: 'evidence-derived';
}

/** Historical task profile from SelfModel traces. */
export interface HistoricalProfile {
  /** Task type signature (e.g., "fix::ts::small"). */
  signature: string;
  /** Number of prior observations for this signature. */
  observationCount: number;
  /** Historical failure rate (0-1). */
  failRate: number;
  /** Oracles that most commonly reject this task type (top 3). */
  commonFailureOracles: string[];
  /** Average duration per file (ms). */
  avgDurationPerFile: number;
  /** SelfModel basis quality. */
  basis: 'static-heuristic' | 'hybrid' | 'trace-calibrated';
  /** Is this a recurring issue (same file + verb seen ≥3 times)? */
  isRecurring: boolean;
  /** Number of prior attempts on similar tasks. */
  priorAttemptCount: number;
}

// ── STU Layer 2: Semantic Understanding (Phase B) ───────────────────────

/** Closed vocabulary for primaryAction — prevents signature fragmentation.
 *  LLM output is canonicalized to one of these values post-parse.
 *  New values require a code change — intentional friction to avoid unbounded growth. */
export const PRIMARY_ACTION_VOCAB = [
  'add-feature',
  'bug-fix',
  'security-fix',
  'performance-optimization',
  'refactor',
  'api-migration',
  'dependency-update',
  'test-improvement',
  'documentation',
  'configuration',
  'investigation',
  'flaky-test-diagnosis',
  'accessibility',
  'other',
] as const;
export type PrimaryAction = (typeof PRIMARY_ACTION_VOCAB)[number];

/** LLM-derived semantic understanding. Always `llm-self-report` / tier 0.4.
 *  Never enters governance (routing/gating). Enriches prompts only (P1/P3). */
export interface SemanticIntent {
  /** Fine-grained intent canonicalized to PRIMARY_ACTION_VOCAB. */
  primaryAction: PrimaryAction;
  /** Secondary actions implied by the goal. */
  secondaryActions: string[];
  /** Natural-language scope description. */
  scope: string;
  /** Implicit constraints not stated in the goal. Polarity distinguishes
   *  positive ("must do X") from negative ("must not do Y"). */
  implicitConstraints: Array<{ text: string; polarity: 'must' | 'must-not' }>;
  /** Ambiguities with possible interpretations. */
  ambiguities: Array<{
    aspect: string;
    interpretations: string[];
    selectedInterpretation?: string;
    confidence: number;
  }>;
  /** Concise 1-2 sentence restatement of the actual goal. */
  goalSummary?: string;
  /** Concrete action steps extracted from the task description. */
  steps?: string[];
  /** Observable criteria for verifying task completion. */
  successCriteria?: string[];
  /** Modules, files, or services likely affected by this task. */
  affectedComponents?: string[];
  /** Hypothesized root cause (primarily for bug-fix/investigation tasks). */
  rootCause?: string;
  /** Always probabilistic — hardcoded post-parse, not from LLM. A3-enforced. */
  confidenceSource: 'llm-self-report';
  /** Always below heuristic threshold. A5-enforced. */
  tierReliability: 0.4;
}

// ── STU Verified Claims (Phase C) ───────────────────────────────────────

/** Oracle-verified understanding claim — ECP-compatible structure (§4.5).
 *  Each claim carries its own confidence source and tier for governance eligibility.
 *  A1: generated by Layer 2, verified by separate verifier using different tools. */
export interface VerifiedClaim {
  /** The claim being made (e.g., "File src/auth/ exists"). */
  claim: string;
  /** Epistemic type — same 4-state taxonomy as OracleVerdict. */
  type: 'known' | 'unknown' | 'uncertain' | 'contradictory';
  /** Verification confidence (post-oracle). */
  confidence: number;
  /** Which oracle or tool verified (e.g., 'fs', 'world-graph', 'package.json'). */
  verifiedBy?: string;
  /** ECP confidence source — determines governance eligibility. */
  confidenceSource: 'evidence-derived' | 'llm-self-report';
  /** A5 tier reliability. */
  tierReliability: number;
  /** What would invalidate this claim. */
  falsifiableBy: string[];
  /** Evidence chain. */
  evidence: Array<{ file: string; line?: number; snippet?: string }>;
}

// ── STU Extended IR ─────────────────────────────────────────────────────

/** Extended understanding IR — Layer 0 + Layer 1 + optional Layer 2/3. */
export interface SemanticTaskUnderstanding extends TaskUnderstanding {
  // ── Layer 0: Domain Classification ─────────────────────
  /** Task domain — drives tool access scope and A2 capability boundary. */
  taskDomain: TaskDomain;
  /** Task intent — drives response framing (execute vs inquire vs converse). */
  taskIntent: TaskIntent;
  /** Whether this task requires tool execution (capability routing floor). */
  toolRequirement: ToolRequirement;

  // ── Layer 1: Structural ────────────────────────────────
  /** NL references resolved to code entities. */
  resolvedEntities: ResolvedEntity[];
  /** Historical profile from SelfModel traces. */
  historicalProfile?: HistoricalProfile;
  /** Understanding depth achieved (budget may limit). */
  understandingDepth: 0 | 1 | 2 | 3;

  // ── Layer 2: Semantic (optional, budget-gated) ─────────
  /** Fine-grained intent from LLM parsing. */
  semanticIntent?: SemanticIntent;

  // ── Verification results (Phase C) ────────────────────
  /** Oracle-verified understanding claims. */
  verifiedClaims: VerifiedClaim[];

  // ── Content-addressing (P8) ────────────────────────────
  /** SHA-256 fingerprint = hash(goal + sorted(resolvedPaths) + taskSignature). */
  understandingFingerprint: string;
}

/** Input to the Orchestrator core loop */
export interface TaskInput {
  id: string;
  source: 'cli' | 'api' | 'mcp' | 'a2a';
  goal: string; // Natural language task description
  taskType: TaskType; // Explicit classification — drives prompt, perception, and verification
  targetFiles?: string[]; // Optional explicit scope
  constraints?: string[]; // User-specified constraints
  acceptanceCriteria?: string[]; // Optional semantic acceptance criteria (WP-2: critic rubric)
  /** Conversation session ID — links this task to a multi-turn chat session. */
  sessionId?: string;
  budget: {
    maxTokens: number; // Total tokens for this task
    maxDurationMs: number; // Wall-clock timeout
    maxRetries: number; // Default: 3 per routing level
  };
}

// ---------------------------------------------------------------------------
// Conversation History (→ Conversation Agent Mode)
// ---------------------------------------------------------------------------

/** A single entry in the conversation history — user message or assistant response. */
export interface ConversationEntry {
  role: 'user' | 'assistant';
  content: string;
  taskId: string;
  timestamp: number;
  thinking?: string;
  toolsUsed?: string[];
  tokenEstimate: number;
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
  answer?: string; // Non-mutation tasks: reasoning/Q&A response from the agent
  thinking?: string; // LLM thinking process (when extended thinking is enabled)
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
    /** G1: Decayed confidence from World Graph queryFacts() — enables trust-weighted prompting. */
    confidence: number;
    /** G1: Which oracle verified this fact (e.g. 'ast', 'type', 'orchestrator'). */
    oracleName: string;
    /** G1: Tier reliability — deterministic (1.0) > heuristic (0.8) > probabilistic (0.5). */
    tierReliability?: number;
  }>;
  runtime: {
    nodeVersion: string;
    os: string;
    availableTools: string[];
  };
  frameworkMarkers?: string[]; // Phase 4: detected frameworks (e.g., 'react', 'express')
  causalEdges?: import('../orchestrator/forward-predictor-types.ts').CausalEdge[]; // ForwardPredictor: Tier 3 causal edges
  /** Gap 3C: Token-budgeted file content previews for L1+ single-shot workers. */
  fileContents?: Array<{
    file: string;
    content: string;
    truncated: boolean;
  }>;
}

/** Per-task working memory — tracks failed approaches and uncertainties */
export interface WorkingMemoryState {
  failedApproaches: Array<{
    approach: string;
    oracleVerdict: string; // which oracle rejected + evidence
    timestamp: number;
    /** EO #8: Oracle gate confidence when this approach was rejected (0.0-1.0). */
    verdictConfidence?: number;
    /** EO #8: Which oracle was the primary rejector (e.g. 'test', 'type', 'ast'). */
    failureOracle?: string;
    /** Source of this approach: 'task' (current), 'cross-task' (loaded from prior task), 'eviction' (re-loaded). */
    source?: string;
    /** Structured failure details parsed from oracle verdicts (A1 Understanding layer). */
    classifiedFailures?: Array<{
      category: string;
      file?: string;
      line?: number;
      message: string;
      severity: 'error' | 'warning';
      suggestedFix?: string;
    }>;
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
// EO Concepts — Epistemic Orchestration enhancements
// ---------------------------------------------------------------------------

/** EO #2: Role-based context pruning — A1 enforced information barriers */
export type PerceptionRole = 'generator' | 'critic' | 'testgen';

/** EO #3: Per-node verification contract — tells the gate which oracles matter */
export interface VerificationHint {
  /** Which oracles are relevant for this mutation type */
  oracles?: Array<'ast' | 'type' | 'dep' | 'lint' | 'test' | 'goal-alignment'>;
  /** Skip test oracle for trivial mutations */
  skipTestWhen?: 'import-only' | 'type-change-only' | 'config-change';
  /** A1 Understanding layer: task semantics for goal alignment verification */
  understanding?: TaskUnderstanding;
  /** Target files from TaskInput — used by goal alignment for file scope check */
  targetFiles?: string[];
}

// ---------------------------------------------------------------------------
// Thinking & Cache Configuration (→ Anthropic API integration)
// ---------------------------------------------------------------------------

/** Thinking configuration for Anthropic models.
 *  - adaptive: Opus 4.6/Sonnet 4.6 — auto-determines thinking depth via effort level
 *  - enabled: older models — explicit budget_tokens control
 *  - disabled: no thinking (L0/L1 fast path)
 */
export type ThinkingConfig =
  | { type: 'adaptive'; effort: 'low' | 'medium' | 'high' | 'max'; display?: 'omitted' | 'summarized' }
  | { type: 'enabled'; budgetTokens: number; display?: 'omitted' | 'summarized' }
  | { type: 'disabled' }
  // Phase 3+ thinking modes (type-only, provider support not yet implemented — see docs/design §4.1)
  | {
      type: 'multi-hypothesis';
      branches: 2 | 3 | 4;
      diversityConstraint: 'different-patterns' | 'different-resources';
      selectionRule: 'highest-oracle-confidence' | 'first-to-pass' | 'voting-consensus';
      allFailBehavior: 'escalate-level' | 'return-best-effort' | 'refuse';
      tieBreaker: 'first-branch' | 'lowest-token-cost' | 'random';
    }
  | { type: 'counterfactual'; trigger: 'verification_failure'; maxRetries: number; constraintSource: 'working-memory' }
  | { type: 'deliberative'; checkpoints: number; depthLimit: number }
  | {
      type: 'debate';
      participants: string[];
      debateTurns: number;
      arbitrationRule: 'oracle-score' | 'evidence-weight';
    };

/** Cache control marker for prompt caching — 3-tier strategy.
 *  - static: system prompt (role, oracle manifest, format) — stable across sessions (~1hr effective TTL)
 *  - session: project instructions (VINYAN.md) — stable within session (~5min effective TTL)
 *  - ephemeral: per-task content (goal, perception, memory) — Anthropic default ephemeral cache */
export interface CacheControl {
  type: 'ephemeral' | 'static' | 'session';
}

/** Provider-agnostic error: prompt payload exceeds API size limit (HTTP 413 or context_length_exceeded).
 *  Thrown by providers, caught by worker layer for compress-and-retry. */
export class PromptTooLargeError extends Error {
  override readonly name = 'PromptTooLargeError';
  constructor(
    public readonly estimatedTokens: number,
    public readonly provider: string,
    cause?: unknown,
  ) {
    super(`Prompt too large (~${estimatedTokens} tokens) for ${provider}`);
    if (cause) this.cause = cause;
  }
}

/** EO #6: Epistemic reasoning budget policy — Self-Model calibrated */
export interface ReasoningPolicy {
  /** Fraction of total budget allocated to generation (0.4-0.85) */
  generationBudget: number;
  /** Fraction allocated to verification (1.0 - generationBudget - contingencyReserve) */
  verificationBudget: number;
  /** Reserved for escalation retries (default: 0.15) */
  contingencyReserve: number;
  /** Which oracles to run first if verification budget is tight (A5: deterministic first) */
  oraclePriority: string[];
  /** Source: 'default' for <10 traces, 'calibrated' for ≥10 traces */
  basis: 'default' | 'calibrated';
}

/** EO #5: Transcript partition for dual-track compaction */
export interface TranscriptPartition {
  /** Recent turns (uncompressed, for LLM context window) */
  evidenceTurns: Array<{ turnId: string; type: string; isEvidence: boolean }>;
  /** Number of narrative turns that were compacted */
  compactedNarrativeTurns: number;
  /** Summary of compacted narrative (if compaction occurred) */
  compactedSummary?: string;
  /** Token savings from compaction */
  tokensSaved: number;
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
  /** Probability of passing — used by ForwardPredictor merge (C3). */
  pPass?: number;
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
  | 'worker_trace_diversity' // Phase 4: traces with >1 distinct model_used
  | 'thinking_trace_count' // Extensible Thinking: traces with thinking data
  | 'thinking_distinct_task_types'; // Extensible Thinking: task types with thinking data

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
  composedOf?: string[]; // PH5 D2: ordered list of sub-skill task signatures
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
  /** RE-agnostic engine identifier — replaces model-specific naming. Alias: modelUsed (backward compat). */
  engineId?: string;
  modelUsed: string; // kept for backward compat; new code should prefer engineId
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
  /** Prompt cache metrics for cost analysis. */
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  /** Forward Predictor prediction stored for calibration comparison (C3). */
  forwardPrediction?: import('../orchestrator/forward-predictor-types.ts').OutcomePrediction;
  /** Confidence-weighted merge of SelfModel + ForwardPredictor pPass (C3). */
  mergedPPass?: number;
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
  /** Extensible Thinking Phase 0: thinking mode used for this trace (e.g., 'adaptive:medium', 'disabled'). */
  thinkingMode?: string;
  /** Extensible Thinking Phase 0: thinking tokens consumed (proxy: thinking content char length). */
  thinkingTokensUsed?: number;
  /** Extensible Thinking Phase 1b: JSON metadata for thinking policy audit trail. */
  thinkingMeta?: Record<string, unknown>;
  /** Phase 6 §43: gzip-compressed transcript from agentic session (Bun.gzip). */
  transcriptGzip?: Uint8Array;
  /** Phase 6 §43: number of turns in the agentic transcript (for stats without decompressing). */
  transcriptTurns?: number;
  /** P1: Working memory failed approaches serialized at task end for cross-task learning. */
  failedApproaches?: Array<{
    approach: string;
    oracleVerdict: string;
    verdictConfidence?: number;
    failureOracle?: string;
  }>;
  /** P1: Transcript partition captured at task end — evidence vs narrative classification. */
  transcriptPartition?: TranscriptPartition;
  /** STU Phase D: Understanding depth at task start (0-3). */
  understandingDepth?: number;
  /** STU Phase D: Serialized SemanticIntent JSON (for calibration). */
  understandingIntent?: string;
  /** STU Phase D: Serialized ResolvedEntity[] JSON (for entity accuracy). */
  resolvedEntities?: string;
  /** STU Phase D: 1 if all verified claims are 'known', 0 otherwise. */
  understandingVerified?: number;
  /** STU Phase D: Denormalized primaryAction for indexed queries. */
  understandingPrimaryAction?: string;
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
    /** EO #3: Per-node verification hint — tells gate which oracles matter for this node */
    verificationHint?: VerificationHint;
    /** Prediction-based risk score for fail-fast ordering (C2). */
    riskScore?: number;
  }>;
  /** True when decomposition failed and a single-node fallback was used. */
  isFallback?: boolean;
  /** True when the DAG was produced by expanding a composed skill (PH5 D2). */
  isFromComposedSkill?: boolean;
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
  taskType: TaskType;
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
  /** Optional worker/engine ID for provider selection (warm pool mode). */
  workerId?: string;
  /** Gap 9A: Unified task understanding — carries constraints, criteria, action category to prompt assembly. */
  understanding?: TaskUnderstanding;
  /** Phase 7a: M1-M4 instruction hierarchy resolved in-process and shipped through IPC. */
  instructions?: import('./llm/instruction-hierarchy.ts').InstructionMemory;
  /** Phase 7a: OS/cwd/date/git snapshot gathered in-process and forwarded to the worker. */
  environment?: import('./llm/shared-prompt-sections.ts').EnvironmentInfo;
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
  /** Conversational answer for non-file tasks (e.g. "hi"). */
  proposedContent?: string;
  /** When set, indicates a permanent error that should not be retried or escalated. */
  nonRetryableError?: string;
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
  tier: 'fast' | 'balanced' | 'powerful' | 'tool-uses';
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
  /** Thinking configuration — controls extended thinking behavior per routing level. */
  thinking?: ThinkingConfig;
  /** Cache control — enables prompt caching on system/tool blocks. */
  cacheControl?: CacheControl;
  /** Cache control for instruction block (VINYAN.md) — session-stable content. */
  instructionCacheControl?: CacheControl;
}

/** Response from an LLM provider */
export interface LLMResponse {
  content: string;
  thinking?: string;
  toolCalls: ToolCall[];
  tokensUsed: {
    input: number;
    output: number;
    cacheRead?: number;
    cacheCreation?: number;
  };
  model: string;
  stopReason: 'end_turn' | 'tool_use' | 'max_tokens';
}

// ---------------------------------------------------------------------------
// Reasoning Engine — RE-agnostic abstraction over any generator (LLM, symbolic, AGI)
// ---------------------------------------------------------------------------
// Design intent: any future Reasoning Engine (current LLM, symbolic solver, AGI system)
// plugs into Vinyan by implementing this interface. LLMProvider becomes one concrete RE type.
// Axiom A3: Orchestrator routing remains deterministic regardless of which RE executes.

export type REEngineType = 'llm' | 'symbolic' | 'oracle' | 'hybrid' | 'external';

/** RE-agnostic request — LLM-specific params (thinking, cacheControl) go in providerOptions. */
export interface RERequest {
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
  /** Capability hints for engine selection (informational — selection done before execute()). */
  requiredCapabilities?: string[];
  /** RE-specific options (e.g. { thinking: ThinkingConfig, cacheControl: CacheControl } for LLMs). */
  providerOptions?: Record<string, unknown>;
}

/** RE-agnostic response — maps from provider-specific response at the adapter layer. */
export interface REResponse {
  content: string;
  toolCalls: ToolCall[];
  tokensUsed: {
    input: number;
    output: number;
    cacheRead?: number;
    cacheCreation?: number;
    /** Extensible Thinking: thinking tokens used (separate from output tokens when available). */
    thinkingTokens?: number;
  };
  engineId: string;
  /** Generic termination reason — more stable than provider-specific stop reasons. */
  terminationReason: 'completed' | 'tool_use' | 'limit_reached';
  /** Thinking trace — only populated by REs that support extended reasoning. */
  thinking?: string;
  /** RE-specific response metadata (e.g. { model: 'claude-opus-4-6' } for LLMs). */
  providerMeta?: Record<string, unknown>;
}

/** Primary interface for all Reasoning Engines — LLMs, symbolic solvers, future AGI. */
export interface ReasoningEngine {
  id: string;
  engineType: REEngineType;
  /** Formal capability declaration — PRIMARY selector for routing (replaces tier-only selection). */
  capabilities: string[];
  /** Advisory tier — backward compat with tier-based routing. Optional for non-LLM REs. */
  tier?: 'fast' | 'balanced' | 'powerful' | 'tool-uses';
  maxContextTokens?: number;
  execute(request: RERequest): Promise<REResponse>;
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
  /** RE-agnostic type — 'llm' for all LLM-backed workers, other values for future RE types. */
  engineType?: REEngineType;
  /** Capabilities this engine declares (for capability-first routing). */
  capabilitiesDeclared?: string[];
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
