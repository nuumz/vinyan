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
  /** True when task was escalated from a lower routing level (suppresses exploration). */
  isEscalated?: boolean;
  /**
   * G3 per-phase sampling config — partial override map from phase name to
   * per-phase LLM params. Resolved by `resolvePhaseConfig(phase, routing)`.
   * Phases that don't appear in the map fall back to hardcoded defaults so
   * existing call sites stay bit-exact when no config is supplied.
   */
  phaseConfigs?: Partial<Record<PhaseName, PhaseLLMConfig>>;
  /** A8 RFC: provenance for the governance decision that produced this route. */
  governanceProvenance?: GovernanceProvenance;
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
export type TaskIntent = 'execute' | 'inquire' | 'converse' | 'ideate';

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

/** Origin of the resolved intent — enables calibration to separate LLM vs deterministic paths. */
export type IntentReasoningSource =
  | 'llm'
  | 'fallback'
  | 'cache'
  | 'deterministic'
  | 'merged'
  // Deterministic short-affirmative pre-classifier reconstructed intent from prior turns
  | 'short-affirmative-continuation'
  // Deterministic short-retry pre-classifier replayed prior request after a failed turn
  | 'short-retry-continuation'
  // Persona escape sentinel re-routed conversational shortcircuit to agentic-workflow
  | 'persona-escape';

/**
 * Epistemic state of an intent resolution — mirrors VerifiedClaim taxonomy.
 *
 * - `known`: deterministic + LLM agree (or one side is high-confidence alone).
 * - `uncertain`: LLM was low confidence or ambiguity signals triggered — user clarification needed.
 * - `contradictory`: deterministic and LLM disagreed. A5 tier order decides the surviving
 *    strategy; the other is recorded for observability and a clarification is surfaced.
 */
export type IntentResolutionType = 'known' | 'uncertain' | 'contradictory';

/** Candidate produced by the deterministic (rule-based, tier 0.8) classifier before the LLM runs. */
export interface IntentDeterministicCandidate {
  strategy: ExecutionStrategy;
  confidence: number;
  /** Which rule produced the candidate (observability). */
  source:
    | 'classifyDirectTool'
    | 'mapUnderstandingToStrategy'
    | 'composed'
    | 'creative-deliverable-pattern'
    | 'multi-agent-delegation-pattern';
  /** Whether the rule flagged the input as ambiguous (blocks LLM skip). */
  ambiguous: boolean;
}

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
  /** Which classifier produced the decision (llm | heuristic pre-filter | regex fallback). */
  reasoningSource?: IntentReasoningSource;
  /**
   * Multi-agent: selected specialist agent id (e.g., 'developer', 'author').
   * Present when the registry has ≥1 agent. Resolver picks based on goal + task type.
   * Overridden by `input.agentId` (CLI --agent flag).
   */
  agentId?: string;
  /** Resolver's reasoning for agent selection (observability). */
  agentSelectionReason?: string;
  /**
   * Structured capability requirements the LLM extracted from the goal.
   * Forwarded to AgentRouter.route() with source `'llm-extract'`. Allows
   * routing of creative/research/design intents without regex on goal text.
   */
  capabilityRequirements?: CapabilityRequirement[];
  /**
   * Epistemic state — `known` when deterministic+LLM agree (or one is confident alone),
   * `uncertain` for low-confidence / ambiguous inputs, `contradictory` when rule and LLM
   * disagree. The core-loop dispatches `uncertain`/`contradictory` to the clarification
   * path instead of executing the strategy.
   */
  type?: IntentResolutionType;
  /** User-facing clarification message when `type` is `uncertain` or `contradictory`. */
  clarificationRequest?: string;
  /** Optional structured choices paired with `clarificationRequest`. */
  clarificationOptions?: string[];
  /**
   * Original goal preserved when the core-loop rewrites `input.goal` to `workflowPrompt`
   * (agentic-workflow). Enables tracing and post-mortem comparison against the rewrite.
   */
  originalGoal?: string;
  /** Rule-based candidate produced before the LLM ran, for observability. */
  deterministicCandidate?: IntentDeterministicCandidate;
  /**
   * Capability-First (Phase D): when post-LLM re-routing performed gap
   * analysis, the result is stashed here so downstream phases (trace
   * recording, evolution promotion) can read it without re-running.
   */
  capabilityAnalysis?: CapabilityGapAnalysis;
  /** Synthesized agent id when the synthesize branch fired, for trace + cleanup. */
  syntheticAgentId?: string;
  /** Local-first knowledge contexts when the research branch surfaced evidence. */
  knowledgeUsed?: KnowledgeContext[];
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

  // ── Agentic SDLC enrichments (optional, populated by phase-spec / phase-brainstorm) ──
  /** Frozen, human-approved specification produced by phase-spec. When present,
   *  GoalEvaluator anchors C5 coverage to this artifact rather than the raw goal. */
  spec?: import('./spec/spec-artifact.ts').SpecArtifact;
  /** Brainstorm output — N ranked candidate approaches. Populated by phase-brainstorm
   *  when the ideation classifier matches the goal. The chosen candidate's approach
   *  is also surfaced via TaskInput.constraints for prompt assembly. */
  ideation?: import('./intent/ideation-types.ts').IdeationResult;
}

/**
 * Task source — the transport / entry point that produced this task.
 *
 * The `gateway-*` variants, `acp`, and `internal` are reserved for future
 * surfaces (messaging gateway, ACP adapter, internal delegations) that enter
 * `executeTask` from outside the current CLI/API/MCP/A2A set. See
 * `docs/spec/w1-contracts.md` §4.
 */
export type TaskSource =
  | 'cli'
  | 'api'
  | 'mcp'
  | 'a2a'
  | 'gateway-telegram'
  | 'gateway-slack'
  | 'gateway-discord'
  | 'gateway-whatsapp'
  | 'gateway-signal'
  | 'gateway-email'
  | 'gateway-cron'
  | 'acp'
  | 'internal';

/**
 * Regex for a valid profile name (kebab-case, leading lowercase letter).
 * Mirrors the pattern in `src/config/profile-resolver.ts`. The literal
 * name `'default'` is additionally accepted.
 */
export const PROFILE_REGEX = /^[a-z][a-z0-9-]*$/;

/**
 * Type-guard: does `s` look like a valid profile namespace?
 * Accepts `'default'` or any non-empty kebab-case identifier.
 */
export function isValidProfileName(s: unknown): s is string {
  return typeof s === 'string' && (s === 'default' || PROFILE_REGEX.test(s));
}

/**
 * Normalize an optional profile string into a concrete namespace.
 *
 * - `undefined` → `'default'` (W1 intermediate state — see w1-contracts §4 / §9.A1).
 * - Invalid names throw synchronously so the caller sees the offender verbatim
 *   instead of silently falling back.
 */
export function coerceProfile(p: string | undefined): string {
  if (p === undefined) return 'default';
  if (!isValidProfileName(p)) {
    throw new Error(`invalid profile name: ${p}`);
  }
  return p;
}

/** Input to the Orchestrator core loop */
export interface TaskInput {
  id: string;
  source: TaskSource;
  goal: string; // Natural language task description
  taskType: TaskType; // Explicit classification — drives prompt, perception, and verification
  targetFiles?: string[]; // Optional explicit scope
  constraints?: string[]; // User-specified constraints
  acceptanceCriteria?: string[]; // Optional semantic acceptance criteria (WP-2: critic rubric)
  /** Conversation session ID — links this task to a multi-turn chat session. */
  sessionId?: string;
  /**
   * Profile namespace this task belongs to. Defaults to `'default'` when
   * absent. See `docs/spec/w1-contracts.md` §4 — the long-term intent is
   * to make this required, but W1 ships it optional so existing callers
   * continue to compile. Validated against {@link PROFILE_REGEX} or the
   * literal `'default'`.
   */
  profile?: string;
  /**
   * Parent task id for interrupt-and-redirect / delegation chains.
   * Preserved end-to-end so observability can reconstruct the causal tree.
   */
  parentTaskId?: string;
  /**
   * Scheduling priority hint. Consumed by downstream queue / budget
   * allocators when present. Defaults to `'normal'` when omitted.
   */
  priority?: 'normal' | 'high' | 'background';
  /**
   * Transport-preserved envelope for reply routing by the gateway that
   * produced this task (e.g. Gateway message metadata, ACP message id).
   * Opaque to the core loop — stored and echoed back on completion.
   */
  originEnvelope?: unknown;
  /**
   * Phase 7c-1: typed subagent role. Populated when this task was spawned
   * by a parent via `delegate_task` with an explicit `subagentType`. The
   * child worker uses it to (a) render a role preamble in its system prompt
   * and (b) enforce role-specific tool gating in the delegation router.
   * Absent / root tasks run with the full agent manifest.
   */
  subagentType?: 'explore' | 'plan' | 'general-purpose';
  /**
   * Specialist agent ID (e.g., 'developer', 'author'). Set by:
   *   1. CLI `--agent=<id>` (user override, skips auto-classification)
   *   2. Intent resolver auto-classification (when not pre-set)
   *   3. Registry default (fallback)
   * Flows into prompt (soul/persona), contract (ACL), and skill manager (scope).
   */
  agentId?: string;
  budget: {
    maxTokens: number; // Total tokens for this task
    maxDurationMs: number; // Wall-clock timeout
    maxRetries: number; // Default: 3 per routing level
  };
  /**
   * Bound counter for the conversational-shortcircuit escape sentinel
   * (`<<NEEDS_AGENTIC_WORKFLOW: ...>>`). Incremented to 1 when the persona
   * emits the sentinel and the orchestrator re-routes to agentic-workflow.
   * The detector ignores subsequent emissions on the same task to prevent
   * re-entry loops — see `intent/escape-sentinel.ts`.
   */
  intentEscapeAttempts?: number;
}

// ---------------------------------------------------------------------------
// Session Plan (→ Phase 7c-2, Vinyan's equivalent of Claude Code's TodoWrite)
// ---------------------------------------------------------------------------

/**
 * A single todo item in the session plan. Stored on the orchestrator side —
 * the agent writes the whole list via `plan_update` each time it changes, and
 * the orchestrator renders the current snapshot back into every subsequent
 * tool result as a `[PLAN]` block so the LLM stays anchored without the list
 * bloating raw context.
 *
 * Invariant enforced by the orchestrator:
 *   - at most ONE item may carry `status: 'in_progress'` at any time
 *   - `content` and `activeForm` are non-empty trimmed strings
 *   - `id` is monotonically assigned on first insertion and remains stable
 *     across updates keyed by array position
 */
export interface PlanTodo {
  /** Monotonic 1-based identifier assigned when the item is first added. */
  id: number;
  /** Imperative phrasing of the task: "Run the test suite". */
  content: string;
  /** Present-continuous phrasing: "Running the test suite". */
  activeForm: string;
  /** Workflow state — exactly one may be 'in_progress' at a time. */
  status: 'pending' | 'in_progress' | 'completed';
}

/** A plan_update call's wire shape — id is not required on the way in. */
export interface PlanTodoInput {
  content: string;
  activeForm: string;
  status: 'pending' | 'in_progress' | 'completed';
}

// ---------------------------------------------------------------------------
// Conversation History (→ Conversation Agent Mode)
// ---------------------------------------------------------------------------

// A7: ConversationEntry definition removed. The Turn model (ContentBlock[])
// below is the only conversation representation. Migration 038 drops the
// session_messages table that backed ConversationEntry.
//
// Merge note: feature/main's Phase 1 turn-importance classifier
// (`src/api/turn-importance.ts::classifyTurn`) duck-types its input as
// `{role, content, toolsUsed?, thinking?}` — that shape is declared inline
// in that module as `ClassifiableTurn` and no longer depends on the
// removed `ConversationEntry` interface.

// ---------------------------------------------------------------------------
// Turn Model (Anthropic-native ContentBlock[]) — the sole conversation path
// for loss-free multi-turn tool-use persistence. See plan commit A.
// ---------------------------------------------------------------------------

/**
 * A single block within a Turn. Mirrors Anthropic's content block shape so
 * multi-turn tool-use loops can resume without re-deriving tool parameters
 * from stringified history.
 */
export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string; signature?: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | {
      type: 'tool_result';
      tool_use_id: string;
      content: string;
      is_error?: boolean;
    };

/** Token accounting per turn — split by cache tier for instrumentation. */
export interface TurnTokenCount {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
}

/**
 * A single conversation turn — user input or assistant response — stored as
 * an ordered sequence of Anthropic-native content blocks.
 *
 * `cancelledAt` is set by the cancel protocol (plan commit C) when the user
 * aborts mid-stream; the partial blocks emitted up to that point are still
 * persisted so the next turn can reference them without losing context.
 */
export interface Turn {
  id: string;
  sessionId: string;
  /** Zero-based ordinal within the session; monotonically increasing. */
  seq: number;
  role: 'user' | 'assistant';
  blocks: ContentBlock[];
  /** Unix millis when the user cancelled this turn (0/undefined = not cancelled). */
  cancelledAt?: number;
  tokenCount: TurnTokenCount;
  createdAt: number;
  /** Optional link to the orchestrator task this turn belongs to (assistant turns). */
  taskId?: string;
}

/** Output of the Orchestrator core loop */
export interface TaskResult {
  id: string;
  /**
   * Task outcome status.
   *
   * - `completed`: task executed successfully.
   * - `failed`:    task ran to failure (e.g., tool error, verification rejection).
   * - `escalated`: higher routing level / human review required.
   * - `uncertain`: agent reported uncertainty; may retry at higher level.
   * - `input-required`: agent paused and is asking the user follow-up questions.
   *   `clarificationNeeded` carries those questions. Distinct from `uncertain`
   *   because no retry/escalation is attempted — the user must answer in the
   *   next turn. Lexically aligned with A2A `A2ATaskState` for future bridging.
   * - `partial`: the work produced a usable answer but at least one sub-step
   *   failed or was skipped (e.g., a multi-step workflow where one
   *   independent branch failed). UI should treat this as success-with-warning,
   *   not a hard failure.
   */
  status: 'completed' | 'failed' | 'escalated' | 'uncertain' | 'input-required' | 'partial';
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
  /**
   * Agent Conversation: follow-up questions the agent is asking the user.
   * Set when `status === 'input-required'`. Each entry is one question.
   * The next user turn should answer these; chat.ts/api clients should surface
   * them as user-facing prompts (not errors).
   */
  clarificationNeeded?: string[];
  /** Wave B: plan used for this task — surfaced so outer-loop can pass to replan engine + decomposition learner. */
  plan?: TaskDAG;
  /**
   * Slice 4 Gap B: A/B/C self-assessment the agent attached to its terminal
   * `done`/`uncertain` turn. Read by the deterministic GoalEvaluator to
   * compute prediction-error vs the orchestrator's own grade (A7 — Prediction
   * Error as Learning). The orchestrator never trusts this for the verdict;
   * it is data, not authority.
   */
  workerSelfAssessment?: { grade: 'A' | 'B' | 'C'; gaps?: string[] };
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
  /**
   * Phase 0 W4: explicit record of what the perception compressor dropped so
   * the worker can see "lintWarnings: dropped 47 entries" instead of
   * silently receiving an empty array. Populated by compressPerception;
   * rendered by the perception prompt section as a [PERCEPTION TRUNCATED]
   * block.
   */
  compressionNotes?: string[];
}

/** Per-task working memory — tracks failed approaches and uncertainties */
/** Wave 2: Working memory state — now includes plan-signature history for replan novelty. */
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
  /** Wave 2: SHA-256 signatures of plans attempted in this task. Used by ReplanEngine for novelty. */
  planSignatures?: string[];
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
  /**
   * M3.5 — Per-task-type signature (e.g. `delete::ts::large-blast`). Populated
   * by CalibratedSelfModel.predict() so phase-verify can construct
   * GateRequest.commonsenseSignals without re-deriving the signature. See
   * docs/design/commonsense-substrate-system-design.md §6 (M3).
   */
  taskTypeSignature?: string;
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
  type: 'anti-pattern' | 'success-pattern' | 'worker-performance' | 'decomposition-pattern';
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
  /**
   * Multi-agent: owning specialist agent id (e.g., 'developer').
   * NULL/undefined = legacy shared skill (readable by any agent).
   * New skills are written with the creating agent's id.
   */
  agentId?: string;
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
  action: 'escalate' | 'require-oracle' | 'prefer-model' | 'adjust-threshold' | 'assign-worker' | 'promote-capability';
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

export interface GovernanceEvidenceReference {
  kind: 'task-input' | 'file' | 'oracle-verdict' | 'routing-factor' | 'policy' | 'tool-result' | 'trace' | 'other';
  source: string;
  contentHash?: string;
  observedAt?: number;
  summary?: string;
}

export interface GovernanceProvenance {
  decisionId: string;
  policyVersion: string;
  attributedTo: string;
  wasGeneratedBy: string;
  wasDerivedFrom: GovernanceEvidenceReference[];
  decidedAt: number;
  evidenceObservedAt?: number;
  reason?: string;
  escalationPath?: RoutingLevel[];
}

export type GoalGroundingPhase = 'perceive' | 'spec' | 'plan' | 'generate' | 'verify';
export type GoalGroundingAction = 'continue' | 'downgrade-confidence' | 'request-clarification';

export interface GoalGroundingCheck {
  taskId: string;
  phase: GoalGroundingPhase;
  routingLevel: RoutingLevel;
  policyVersion: string;
  checkedAt: number;
  action: GoalGroundingAction;
  reason: string;
  rootGoalHash: string;
  currentGoalHash: string;
  goalDrift: boolean;
  freshnessDowngraded: boolean;
  factCount: number;
  staleFactCount: number;
  minFactConfidence?: number;
  evidence: GovernanceEvidenceReference[];
}

export type OracleIndependenceAssumption = 'independent' | 'shared-evidence' | 'single-oracle';
export type OracleConfidenceCompositionMethod =
  | 'oracle-gate-aggregate-confidence'
  | 'default-pass-fallback'
  | 'default-fail-fallback';

export interface OracleIndependenceAudit {
  policyVersion: string;
  compositionMethod: OracleConfidenceCompositionMethod;
  assumption: OracleIndependenceAssumption;
  oracleCount: number;
  deterministicOracleCount: number;
  heuristicOracleCount: number;
  primaryOracles: string[];
  corroboratingOracles: string[];
  sharedEvidenceWarnings: string[];
}

/** Recorded after each task for Self-Model calibration and Evolution Engine */
export interface ExecutionTrace {
  id: string;
  taskId: string;
  sessionId?: string; // Session grouping for multi-step tasks
  /**
   * Parent task id when this trace belongs to a delegated child. Set from
   * `TaskInput.parentTaskId` (which `buildSubTaskInput` populates from the
   * parent task at delegation time). Without it, downstream consumers
   * (Evolution Engine, observability dashboards, the chat UI's delegation
   * tree) cannot reconstruct parent → child chains from trace storage —
   * they'd see each child as an unrelated top-level trace.
   */
  parentTaskId?: string;
  workerId?: string; // Which worker (oracle/engine) executed this step
  /** Multi-agent: specialist id (e.g., 'developer') — distinct from workerId (oracle). */
  agentId?: string;
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
  outcome: 'success' | 'failure' | 'timeout' | 'escalated' | 'partial';
  failureReason?: string;
  affectedFiles: string[];
  // Phase 2.2 — shadow validation (async, post-commit)
  shadowValidation?: ShadowValidationResult;
  validationDepth?: 'structural' | 'structural_and_tests' | 'full_shadow';
  exploration?: boolean; // PH3.6: true if epsilon-greedy exploration was used
  oracleFailurePattern?: string; // WP-5: sorted failed oracle names joined by "+" (e.g., "lint+type")
  frameworkMarkers?: string[]; // PH4: detected framework markers (e.g., 'react', 'express')
  workerSelectionAudit?: EngineSelectionResult; // PH4: worker selection audit trail
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
  /** Capability route audit: resolver/router rationale for the selected agent. */
  agentSelectionReason?: string;
  // ── Capability-First Orchestration (Phase D) ─────────────────────────
  /**
   * Structured capability requirements the resolver/router judged the task
   * to need. Recorded so sleep-cycle can group traces by `(taskTypeSignature,
   * agentId)` and promote claims for capabilities the agent consistently
   * succeeds on. Optional — present only on traces that flowed through the
   * capability-aware routing path.
   */
  capabilityRequirements?: CapabilityRequirement[];
  /**
   * Output of capability gap analysis. Includes recommended action
   * (proceed/research/synthesize/fallback) and the fit/gap breakdown for
   * the chosen agent. Useful for evolution + dashboard observability.
   */
  capabilityAnalysis?: CapabilityGapAnalysis;
  /** Capability profile id selected by the router/analysis path. */
  selectedCapabilityProfileId?: string;
  /** Provenance of the selected capability profile. */
  selectedCapabilityProfileSource?: AgentCapabilityProfileSource;
  /** Trust tier of the selected capability profile. */
  selectedCapabilityProfileTrustTier?: CapabilityProfileTrustTier;
  /** Fit score of the selected capability candidate that drove routing. */
  capabilityFitScore?: number;
  /** Capability ids still unmet by the selected capability candidate. */
  unmetCapabilityIds?: string[];
  /** Synthesized agent id used for this task, if synthesis fired. */
  syntheticAgentId?: string;
  /** Local-first knowledge contexts surfaced for this task, when research fired. */
  knowledgeUsed?: KnowledgeContext[];
  /** A8 RFC: replayable governance/action/verdict provenance for this trace. */
  governanceProvenance?: GovernanceProvenance;
  /** A10 RFC: phase-boundary root-goal and temporal freshness grounding checks. */
  goalGrounding?: GoalGroundingCheck[];
  /** A5 refinement: audit metadata for oracle independence assumptions during confidence composition. */
  oracleIndependence?: OracleIndependenceAudit;
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
  /**
   * Book-integration Wave 5.2: constraint strings the decomposer
   * wants merged into the parent task's prompt context before the
   * worker runs. Used by deterministic presets (e.g. research-swarm
   * report contract) that want to inject a prompt preamble without
   * mutating the caller's TaskInput.
   *
   * Contract:
   *   - The decomposer sets this field when it needs the worker's
   *     prompt assembler to see additional constraints.
   *   - The core-loop's plan phase merges the preamble into a
   *     *cloned* TaskInput and swaps `ctx.input` for subsequent
   *     phases so the caller's original input is never mutated.
   *   - Downstream phases see the merged constraints on
   *     `ctx.input.constraints`.
   *
   * This replaces the earlier pattern where the research-swarm
   * preset directly mutated `input.constraints` inside the
   * decomposer (Phase A §7 seam #2, closed in Wave 5 phase 2).
   */
  preamble?: string[];
  /**
   * ACR (Agent Conversation Room): when set to 'room', the Generate
   * phase dispatches this DAG through `RoomDispatcher` instead of the
   * default agentic-loop path. The decomposer only sets this after
   * validation when `selectRoomContract()` determines the topology
   * and routing meet the trigger rules. Absent / 'solo' / 'dag'
   * leaves existing dispatch paths unchanged.
   */
  collaborationMode?: 'solo' | 'dag' | 'room';
  /**
   * ACR: room contract for the Supervisor FSM. Required when
   * `collaborationMode === 'room'`. Carries roles, round caps,
   * convergence threshold, and shared token budget. See
   * `src/orchestrator/room/types.ts:RoomContract` for the schema.
   */
  roomContract?: import('./room/types.ts').RoomContract;
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
  /**
   * Plan commit A: Turn-model conversation history. Subprocess workers prefer
   * this over the legacy flat ConversationEntry path — preserves tool_use /
   * tool_result blocks so multi-turn tool loops resume without hallucinating
   * prior parameters.
   */
  turns?: Turn[];
  /**
   * Phase-2 + 5B: persona's loaded SKILL.md cards, computed by the
   * orchestrator (in-process) and forwarded across the subprocess boundary.
   * The worker passes them straight into `assemblePrompt` so the
   * `agent-skill-cards` section renders identically in both dispatch paths.
   */
  loadedSkillCards?: import('./agents/derive-persona-capabilities.ts').SkillCardView[];
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

/** Delta-callback for token-level text streaming (Phase 2 realtime chat). */
export type OnTextDelta = (delta: { text: string }) => void;

/** LLM provider abstraction */
export interface LLMProvider {
  id: string;
  tier: 'fast' | 'balanced' | 'powerful' | 'tool-uses';
  capabilities?: string[]; // e.g., ['tool_use', 'vision', 'long_context']
  maxContextTokens?: number; // Provider's context window size
  supportsToolUse?: boolean; // Whether provider supports tool_use stop reason
  generate(request: LLMRequest): Promise<LLMResponse>;
  /**
   * Optional: token-level streaming. Calls `onDelta` as text chunks arrive.
   * Must still resolve to a complete LLMResponse identical to generate().
   * Callers that want a non-streaming path should fall back to generate().
   */
  generateStream?(request: LLMRequest, onDelta: OnTextDelta): Promise<LLMResponse>;
}

/** Request to an LLM provider */
export interface LLMRequest {
  systemPrompt: string;
  userPrompt: string;
  maxTokens: number;
  /**
   * Provider-level timeout in ms. Non-streaming calls use it as the attempt
   * wall-clock timeout; streaming calls use it as the idle timeout between
   * chunks unless the provider documents a stricter policy.
   */
  timeoutMs?: number;
  temperature?: number;
  /**
   * G3 per-phase sampling: nucleus sampling parameter (0..1). When set,
   * providers forward as `top_p` (Anthropic) or `top_p` (OpenAI-compat).
   * Mutually overridable with `temperature` per provider semantics.
   */
  topP?: number;
  /**
   * G3 per-phase sampling: top-k sampling. Anthropic-only — OpenRouter / OpenAI-compat
   * providers may ignore this field. Set to enforce a hard cap on next-token
   * candidates (e.g., `1` for greedy, larger for diversity).
   */
  topK?: number;
  /**
   * G3 per-phase sampling: stop sequences. Provider stops generation as soon as any
   * of these strings appears in the output. Empty array is treated as unset.
   */
  stopSequences?: string[];
  tools?: Array<{
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  }>;
  messages?: HistoryMessage[];
  /** Thinking configuration — controls extended thinking behavior per routing level. */
  thinking?: ThinkingConfig;
  /**
   * Plan commit B: tier boundaries for prompt caching. When present, the
   * provider splits systemPrompt + userPrompt into Anthropic-native content
   * blocks at frozen→session and session→turn offsets and attaches
   * `cache_control: { type: 'ephemeral' }` at those boundaries so the
   * frozen + session prefixes live in the ephemeral cache while only the
   * turn-volatile suffix is re-processed each request.
   */
  tiers?: import('./llm/prompt-assembler.ts').PromptCacheTiers;
  /**
   * G4 structured output enforcement: ask the provider to constrain output
   * shape at the API level instead of relying on prompt engineering.
   *
   * - `tool_use_required`: emit `tool_choice: { type: 'tool', name }` so the
   *   model MUST call the named tool. Anthropic-friendly. Caller must include
   *   the matching tool definition in `tools[]`.
   * - `json_schema`: provider-specific structured-output mode (OpenAI-compat
   *   `response_format: { type: 'json_schema' }`). For Anthropic providers
   *   this is mapped onto a `tool_choice` directive against a tool whose
   *   name matches `responseFormat.name` (or `'output'`). The provider does
   *   NOT auto-synthesize a tool definition — the caller is still
   *   responsible for including the matching `tools[]` entry, since the
   *   tool description matters for prompt caching and surfacing the
   *   contract to the caller.
   */
  responseFormat?: ResponseFormat;
  /**
   * Optional trace metadata forwarded to providers that support broadcast /
   * trace data (currently OpenRouter — see `llm/llm-trace-context.ts`).
   * Per-request override; missing fields inherit from the ambient context
   * established by `runWithLLMTrace(...)`.
   */
  trace?: import('./llm/llm-trace-context.ts').LLMTraceMetadata;
}

/** G4 response format directive — see `LLMRequest.responseFormat`. */
export type ResponseFormat =
  | { type: 'tool_use_required'; toolName: string }
  | { type: 'json_schema'; schema: Record<string, unknown>; name?: string };

/**
 * G3 per-phase LLM config — overrides sampling parameters when the orchestrator
 * dispatches a specific phase. Resolved by `resolvePhaseConfig()`; missing
 * fields fall back to the phase's hardcoded defaults.
 *
 * Why per-phase: Critic should sample at T≈0 (verify, don't explore), Brainstorm
 * at T≈0.7 (explore), TestGen at higher T for diversity. Keeping these in one
 * shared knob (the routing-level temperature) blurs epistemic separation (A1).
 */
export interface PhaseLLMConfig {
  /** Override the routing-level model id for this phase only. */
  model?: string;
  temperature?: number;
  topP?: number;
  topK?: number;
  stopSequences?: string[];
  /** Override extended-thinking effort. Provider-specific. */
  reasoningEffort?: 'low' | 'medium' | 'high' | 'max';
}

/** Canonical phase names — keep in sync with `src/orchestrator/phases/*`. */
export type PhaseName =
  | 'perceive'
  | 'comprehend'
  | 'predict'
  | 'plan'
  | 'brainstorm'
  | 'generate'
  | 'verify'
  | 'critic'
  | 'spec'
  | 'learn';

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
  timeoutMs?: number;
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

/** Engine profile status lifecycle: probation → active → demoted → retired */
export type EngineProfileStatus = 'probation' | 'active' | 'demoted' | 'retired';

/** Engine profile — reasoning engine configuration paired with empirical performance data. */
export interface EngineProfile {
  id: string; // "worker-{modelBase}-{tempBucket}-{hash(config)}"
  config: EngineConfig;
  status: EngineProfileStatus;
  createdAt: number;
  promotedAt?: number;
  demotedAt?: number;
  demotionReason?: string;
  demotionCount: number; // 3 demotions = permanent retirement
}

/** Engine configuration — identity dimensions for a reasoning engine. */
export interface EngineConfig {
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
  /**
   * Dispatch tier (LLM engines only). Surfaced so the dashboard / fleet
   * tooling can group engines by class without re-parsing the id pattern.
   * Optional — non-LLM engines (Z3, Human-ECP) leave this undefined.
   */
  tier?: 'fast' | 'balanced' | 'powerful' | 'tool-uses';
}

/** Engine stats — computed on-demand from traces via SQL aggregates, 60s TTL cache */
export interface EngineStats {
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
// Agent Profile — workspace-level Vinyan Agent identity (singleton)
// ---------------------------------------------------------------------------

/** Runtime preferences for THE Vinyan Agent in this workspace. */
export interface AgentPreferences {
  /** Approval behavior for high-risk/destructive tasks. Default: 'interactive'. */
  approvalMode: 'strict' | 'interactive' | 'trusting';
  /** Verbosity of CLI output and logging. Default: 'normal'. */
  verbosity: 'quiet' | 'normal' | 'verbose';
  /** Default thinking depth when not overridden per-task. Default: 'medium'. */
  defaultThinkingLevel: 'off' | 'low' | 'medium' | 'high';
  /** Primary interaction language. Default: 'en'. */
  language: 'en' | 'th';
}

/** Default preferences when none are specified. */
export const DEFAULT_AGENT_PREFERENCES: AgentPreferences = {
  approvalMode: 'interactive',
  verbosity: 'normal',
  defaultThinkingLevel: 'medium',
  language: 'en',
};

/**
 * AgentProfile — workspace-level singleton representing THE Vinyan Agent.
 *
 * Exactly ONE per workspace. `id` is always `'local'` (enforced at DB level
 * via CHECK constraint). Persists across runs. Distinct from:
 *   - EngineProfile (per-model execution config, N per workspace)
 *   - Session state (ephemeral, per-task)
 */
export interface AgentProfile {
  /**
   * Agent id. 'local' = workspace host (Phase 1 singleton, preserved for backward compat).
   * Phase 2+ allows specialist ids ('developer', 'reviewer', etc.) from the registry.
   */
  id: string;
  /** A2A instance UUID — reused from `.vinyan/instance-id`. */
  instanceId: string;
  /** Human-readable name shown in CLI and A2A card. Default: 'vinyan'. */
  displayName: string;
  /** Optional tagline/description for A2A discovery. */
  description?: string;
  /** Absolute path of the workspace. */
  workspacePath: string;
  /** Epoch ms of first bootstrap. */
  createdAt: number;
  /** Epoch ms of last preference/capability update. */
  updatedAt: number;
  /** Runtime preferences (config-overridable). */
  preferences: AgentPreferences;
  /** Declared capabilities (oracles, engines, MCP servers) advertised to peers. */
  capabilities: string[];
  /** Resolved path of VINYAN.md if present (memory link). */
  vinyanMdPath?: string;
  /** SHA-256 of VINYAN.md content (freshness tracking). */
  vinyanMdHash?: string;
  /** Phase 2: role classification ('host' | 'specialist' | 'custom'). */
  role?: string;
  /** Phase 2: comma-separated specialization tags for queryable filtering. */
  specialization?: string;
  /** Phase 2: short one-line persona summary (full persona is on filesystem). */
  persona?: string;
}

/**
 * Computed aggregate counters for THE Vinyan Agent.
 * Not stored in DB — computed on-demand via AgentProfileStore.summarize()
 * with 60s in-memory cache.
 */
export interface AgentProfileSummary {
  totalTasks: number;
  distinctTaskTypes: number;
  successRate: number;
  activeSkills: number;
  activeWorkers: number;
  sleepCyclesRun: number;
  lastActiveAt: number;
  lastSleepCycleAt: number;
}

// ---------------------------------------------------------------------------
// Specialist Agent Fleet — multiple named agents (ts-coder, writer, etc.)
// Distinct from workspace singleton AgentProfile (id='local').
// ---------------------------------------------------------------------------

/** Capability overrides for agent ACL intersection (never widens privilege). */
export interface AgentCapabilityOverrides {
  readAny?: boolean;
  writeAny?: boolean;
  network?: boolean;
  shell?: boolean;
}

/** Routing hints — advisory inputs to the intent resolver's agent selection. */
export interface AgentRoutingHints {
  minLevel?: number;
  preferDomains?: string[];
  preferExtensions?: string[];
  preferFrameworks?: string[];
}

/**
 * AgentSpec — runtime representation of a specialist agent.
 *
 * Multiple allowed per workspace. Each has its own persona (soul.md),
 * ACL (allowed tools + capability overrides), and routing hints.
 *
 * Fields:
 *   - id: kebab-case unique identifier (e.g., 'developer', 'reviewer')
 *   - name: human-readable display name
 *   - description: one-line role summary for intent resolver
 *   - role: canonical PersonaRole (Phase 1 redesign) — drives planner-level A1
 *     enforcement (Generator≠Verifier on L2/L3 code-mutation) and ACL defaults.
 *   - soul: pre-loaded soul.md content (persona + philosophy + strategies)
 *   - allowedTools: tool allowlist (intersection with routing defaults)
 *   - capabilityOverrides: capability restrictions (never widens)
 *   - routingHints: advisory hints for auto-classification
 *   - baseSkills: skills loaded at registration (Phase 2 wires these)
 *   - acquirableSkillTags: tag globs that bound runtime skill auto-binding
 *   - builtin: true if shipped with Vinyan
 */
export interface AgentSpec {
  id: string;
  name: string;
  description: string;
  /**
   * Canonical persona role for the redesigned roster. Used by the planner to
   * enforce A1 (Generator≠Verifier persona class on L2/L3 code-mutation) and
   * by the capability router as a coarse pre-filter. Optional for backward
   * compatibility with user-authored agents that pre-date the redesign.
   */
  role?: PersonaRole;
  soul?: string;
  soulPath?: string;
  allowedTools?: string[];
  capabilityOverrides?: AgentCapabilityOverrides;
  routingHints?: AgentRoutingHints;
  /**
   * Capability claims — what skills/roles/domains this agent advertises.
   * The capability layer matches task `CapabilityRequirement` against these
   * claims to pick a fit, instead of relying solely on `routingHints` keyword
   * matching. Optional for backward compatibility; agents without claims
   * fall back to inferred capabilities from `routingHints`.
   */
  capabilities?: CapabilityClaim[];
  /**
   * Coarse role tags for natural-language tasks (e.g. 'editor', 'critic',
   * 'researcher', 'planner'). Independent from `id`. Used by the capability
   * router when the task requests a role, so we are not coupled to specific
   * agent ids.
   */
  roles?: string[];
  /**
   * Skills loaded at agent registration (base scope). Phase 1 leaves this
   * empty for shipped personas — skill packs ship in Phase 2/4. The capability
   * layer treats `baseSkills` as the skill loadout that always travels with
   * the persona, distinct from `bound` (per-workspace persistence) and
   * `acquired` (per-task runtime binding) scopes added in later phases.
   */
  baseSkills?: SkillRef[];
  /**
   * Tag globs that bound which skills the runtime may auto-bind to this
   * persona via the gap → hub-import path. Example: a `developer` persona
   * carries `['language:*', 'framework:*']` so it can acquire any language
   * or framework skill on demand, while `reviewer` carries `['review:*']`
   * to keep its scope narrow. Empty/unset disables auto-binding.
   */
  acquirableSkillTags?: string[];
  builtin?: boolean;
}

/**
 * Canonical persona roles for the redesigned agent roster.
 *
 * Personas are *archetypes of cognition*, not file-extension owners. Domain
 * specialization (TypeScript, fiction, API design) lives in skill packs, not
 * in the persona itself. The role drives:
 *   - planner-level A1 enforcement: Generator-class personas (`developer`,
 *     `architect`, `author`, `researcher`) cannot self-verify on L2/L3
 *     code-mutation tasks; a Verifier-class persona (`reviewer`) is required.
 *   - default ACL floor (e.g. `mentor` is read-only by default, `developer`
 *     gets code-mutation tools, `researcher` gets read+network).
 *   - capability router pre-filter (a code task prefers `developer` over
 *     `author` when no explicit override is given).
 *
 * Cognitive role coverage:
 *   - Generate (artifact production): developer, architect, author, researcher
 *   - Verify (artifact judgement):    reviewer
 *   - Coordinate (route work):        coordinator
 *   - Reflex Q&A:                     assistant
 *   - Investigate (deep synthesis):   researcher
 *   - Guide (dialogue/coaching):      mentor
 *   - Personal logistics:             concierge
 */
export type PersonaRole =
  | 'coordinator'
  | 'developer'
  | 'architect'
  | 'author'
  | 'reviewer'
  | 'assistant'
  | 'researcher'
  | 'mentor'
  | 'concierge';

/**
 * Reference to a runtime skill (SKILL.md artifact) loaded by an agent.
 *
 * `pinnedVersion` and `contentHash` are A4 (content-addressed truth) anchors:
 * a SkillRef with both fields set freezes the agent's view of the skill so
 * later hub upgrades don't silently change behavior. Phase 1 ships only the
 * type — runtime resolution is Phase 2.
 */
export interface SkillRef {
  /** Stable skill id, matches SkillMdFrontmatter.id. */
  id: string;
  /** Optional semver pin. When set, resolver refuses non-matching versions. */
  pinnedVersion?: string;
  /** Optional sha256 pin (A4). When set, resolver refuses non-matching hashes. */
  contentHash?: string;
}

// ---------------------------------------------------------------------------
// Capability layer — task ⇄ agent matching by skills, not names
// ---------------------------------------------------------------------------

/**
 * Source of a capability declaration. Used to weight confidence: builtin
 * declarations are trusted as-is, evolved skills carry empirical confidence,
 * inferred entries (from routingHints) are weakest, synthesized entries from
 * a task-scoped agent are tentative until validated.
 */
export type CapabilityEvidence = 'builtin' | 'evolved' | 'synthesized' | 'inferred';

/** A capability the agent claims to handle. */
export interface CapabilityClaim {
  /** Stable id, e.g. 'code.refactor.ts', 'writing.prose.long-form', 'design.api'. */
  id: string;
  /** Optional human-readable label for prompts/UI. */
  label?: string;
  /** File extensions this capability typically targets (lowercase, leading dot). */
  fileExtensions?: string[];
  /** Action verbs this capability handles (matches TaskFingerprint.actionVerb vocabulary). */
  actionVerbs?: string[];
  /** Coarse domains, e.g. 'code-mutation', 'creative-writing'. */
  domains?: string[];
  /** Framework markers this capability is tuned for. */
  frameworkMarkers?: string[];
  /** Coarse role tag, e.g. 'editor', 'planner'. */
  role?: string;
  /** Where the claim came from. Affects confidence weighting at routing time. */
  evidence: CapabilityEvidence;
  /** [0,1] confidence in this claim. Builtin defaults near 1; inferred ≤ 0.5. */
  confidence: number;
}

/** A single capability the task is judged to need. */
export interface CapabilityRequirement {
  id: string;
  /** [0,1] importance for the task. The router weights fit/gap by this. */
  weight: number;
  /** Optional structured signals so the router can match without re-parsing. */
  fileExtensions?: string[];
  actionVerbs?: string[];
  domains?: string[];
  frameworkMarkers?: string[];
  /** Soft role hint when the task explicitly asks for one. */
  role?: string;
  /** How the requirement was derived. */
  source: 'fingerprint' | 'router-hint' | 'llm-extract' | 'caller';
}

export type AgentCapabilityProfileSource = 'registry' | 'synthetic' | 'peer' | 'external';

export type CapabilityProfileTrustTier = 'deterministic' | 'heuristic' | 'probabilistic';

export interface AgentCapabilityProfile {
  /** Stable profile id. For local registry agents this matches `AgentSpec.id`. */
  id: string;
  /** Runtime route target id. Local profiles route back to an AgentSpec id. */
  routeTargetId: string;
  displayName?: string;
  source: AgentCapabilityProfileSource;
  provenance: string;
  trustTier: CapabilityProfileTrustTier;
  taskScope?: { taskId: string };
  claims: CapabilityClaim[];
  roles: string[];
  acl: {
    allowedTools?: string[];
    readAny?: boolean;
    writeAny?: boolean;
    network?: boolean;
    shell?: boolean;
  };
  routingHints?: AgentRoutingHints;
}

/** Agent-level fit summary for one task. */
export interface CapabilityFit {
  agentId: string;
  /** Capability profile scored to produce this fit. Defaults to agentId for legacy callers. */
  profileId?: string;
  profileSource?: AgentCapabilityProfileSource;
  trustTier?: CapabilityProfileTrustTier;
  /** [0,1] composite fit score across required capabilities. */
  fitScore: number;
  /** Capability ids the agent claims (and weight contribution). */
  matched: Array<{ id: string; weight: number; confidence: number }>;
  /** Capability ids the agent does NOT claim, with their weight. */
  gap: Array<{ id: string; weight: number }>;
}

/**
 * Output of capability analysis + matching for a task.
 * Drives the router's recommended action (proceed / research / synthesize / fallback).
 */
export interface CapabilityGapAnalysis {
  taskId: string;
  required: CapabilityRequirement[];
  /** Sorted by fitScore desc. First entry is the recommended agent. */
  candidates: CapabilityFit[];
  /** [0,1] sum of weight of UNMET requirements at the best candidate. 0 = perfect. */
  gapNormalized: number;
  /**
   * Recommended action for the orchestrator. Determined by deterministic
   * thresholds, never by LLM output. The router still emits a concrete
   * agentId (best candidate or default) regardless.
   */
  recommendedAction: 'proceed' | 'research' | 'synthesize' | 'fallback';
}

/**
 * Plan to construct a task-scoped synthetic agent when no existing agent
 * fits well enough. The synthesis step is responsible for producing an
 * AgentSpec whose ACL is an INTERSECTION of the routing-level defaults and
 * any template caps — never widening privilege.
 */
export interface AgentSynthesisPlan {
  taskId: string;
  /** Suggested kebab-case id, e.g. 'task-<short>-researcher'. */
  suggestedId: string;
  /** Capability claims to attach to the synthesized agent. */
  capabilities: CapabilityClaim[];
  /** Roles to expose. */
  roles: string[];
  /** Soul template id to seed from, when known. */
  soulTemplateId?: string;
  /** Why synthesis is requested (gap summary for traces). */
  rationale: string;
}

export type AgentProposalStatus = 'pending' | 'approved' | 'rejected' | 'retired';
export type AgentProposalTrustTier = 'low' | 'medium' | 'high';

/**
 * Quarantined proposal for a persistent custom agent. Created offline from
 * repeated task-scoped synthetic-agent successes; never activated directly.
 */
export interface AgentProposal {
  id: string;
  status: AgentProposalStatus;
  suggestedAgentId: string;
  name: string;
  description: string;
  taskTypeSignature: string;
  unmetCapabilityIds: string[];
  capabilityClaims: CapabilityClaim[];
  roles: string[];
  allowedTools: string[];
  capabilityOverrides: AgentCapabilityOverrides;
  sourceSyntheticAgentIds: string[];
  evidenceTraceIds: string[];
  observationCount: number;
  successCount: number;
  wilsonLowerBound: number;
  trustTier: AgentProposalTrustTier;
  provenance: string;
  rationale: string;
  createdAt: number;
  updatedAt: number;
  decidedAt?: number;
  decisionReason?: string;
}

/**
 * Request for external knowledge acquisition before/while the agent runs.
 * The acquisition layer (web fetch, MCP, world-graph, docs) treats this as
 * a search spec. Findings are attached as RESEARCH context — they NEVER
 * rewrite the task goal or override LLM agentic output.
 */
export interface KnowledgeAcquisitionRequest {
  taskId: string;
  /** Capability ids this request is trying to fill. */
  capabilities: string[];
  /** Free-form queries the LLM/router formulated for retrieval providers. */
  queries: string[];
  /** Suggested provider order: 'world-graph' | 'docs' | 'mcp' | 'web' | 'peer'. */
  providers?: Array<'world-graph' | 'docs' | 'mcp' | 'web' | 'peer'>;
}

export type KnowledgeAcquisitionProviderId = NonNullable<KnowledgeAcquisitionRequest['providers']>[number];

/**
 * A single piece of evidence returned by the knowledge acquisition layer.
 * Findings are CONTEXT, never authoritative — they reach the LLM as a
 * `[RESEARCH CONTEXT]` block and are explicitly tagged probabilistic so
 * the agent treats them as weak hints, not facts (A2, A5).
 *
 * Producers MUST set `confidence` and `source` from a closed enum so
 * downstream rendering / promotion stays deterministic.
 */
export interface KnowledgeContext {
  /** Where the evidence came from. Closed vocabulary by design. */
  source: 'world-graph' | 'workspace-docs' | 'mcp' | 'web' | 'peer' | 'trace-cache';
  /** Capability id this evidence is meant to fill, when known. */
  capability?: string;
  /** The query string that produced this hit (for trace replay). */
  query: string;
  /** The actual evidence text — already truncated by the producer. */
  content: string;
  /** Pointer back to source: file path, fact id, URL, etc. */
  reference?: string;
  /** [0, 1] — producer-assigned, never read from external sources. */
  confidence: number;
  /** Wall-clock ms epoch — bound retrievals to a time window. */
  retrievedAt: number;
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
// Engine Selection (→ Phase 4.4)
// ---------------------------------------------------------------------------

/** Result of capability-based engine selection — audit trail */
export interface EngineSelectionResult {
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
  isUncertain?: boolean; // Phase 4: true if all engines below capability threshold (A2)
}
