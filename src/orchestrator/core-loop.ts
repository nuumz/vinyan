/**
 * Orchestrator Core Loop — the central nervous system of Vinyan Phase 1.
 *
 * 6-step lifecycle: Perceive → Predict → Plan → Generate → Verify → Learn
 * Nested loops: outer = routing level escalation, inner = retry within level.
 *
 * Each phase is extracted into its own module under ./phases/.
 * This file is the coordinator: pre-routing setup, loop control, and
 * success/failure paths.
 *
 * Source of truth: spec/tdd.md §16.2
 * Axioms: A3 (deterministic governance), A6 (zero-trust execution)
 */

import { resolve as resolvePath } from 'node:path';
import type { VinyanBus } from '../core/bus.ts';
import { LEVEL_CONFIG } from '../gate/risk-router.ts';
import { validateInput } from '../guardrails/index.ts';
import type { AgentMemoryAPI } from './agent-memory/agent-memory-api.ts';
import type { GoalEvaluator } from './goal-satisfaction/goal-evaluator.ts';
import { executeWithGoalLoop } from './goal-satisfaction/outer-loop.ts';
import { executeGeneratePhase } from './phases/phase-generate.ts';
import type { WorkflowRegistry } from './workflows/workflow-registry.ts';
import { executeLearnPhase } from './phases/phase-learn.ts';
import { executePerceivePhase } from './phases/phase-perceive.ts';
import { executePlanPhase } from './phases/phase-plan.ts';
import { executePredictPhase } from './phases/phase-predict.ts';
import { executeVerifyPhase } from './phases/phase-verify.ts';
import type { PhaseContext } from './phases/types.ts';
import type {
  CachedSkill,
  ExecutionTrace,
  IntentResolution,
  PerceptualHierarchy,
  PredictionError,
  ReasoningPolicy,
  RoutingDecision,
  RoutingLevel,
  SelfModelPrediction,
  SemanticTaskUnderstanding,
  TaskDAG,
  TaskInput,
  TaskResult,
  WorkingMemoryState,
} from './types.ts';
import { checkComprehension, isComprehensionCheckDisabled } from './understanding/comprehension-check.ts';
import { commitArtifacts } from './worker/artifact-commit.ts';
import { WorkingMemory } from './working-memory.ts';

// ---------------------------------------------------------------------------
// Dependency interfaces (injected — each implemented in its own module)
// ---------------------------------------------------------------------------

export interface PerceptionAssembler {
  assemble(
    input: TaskInput,
    level: RoutingLevel,
    understanding?: import('./types.ts').TaskUnderstanding,
  ): Promise<PerceptualHierarchy>;
}

export interface RiskRouter {
  assessInitialLevel(input: TaskInput): Promise<RoutingDecision>;
}

export interface SelfModel {
  predict(input: TaskInput, perception: PerceptualHierarchy): Promise<SelfModelPrediction>;
  calibrate?(
    prediction: SelfModelPrediction,
    trace: ExecutionTrace,
    engineCertaintyMap?: Record<string, number>,
  ): PredictionError | undefined;
  /** EO #6: Get Self-Model calibrated reasoning budget policy for a task type. */
  getReasoningPolicy?(taskTypeSignature: string): ReasoningPolicy;
  /** STU Phase D: Access per-task-type params for enriched signature computation. */
  getTaskTypeParams?(sig: string): { observationCount: number } | undefined;
}

export interface TaskDecomposer {
  /**
   * Decompose a task into a DAG. The optional `routing` argument lets the
   * decomposer post-analyze the validated DAG for ACR room eligibility
   * without requiring every caller to provide it — older callers that pass
   * fewer arguments still work and simply opt out of room selection.
   */
  decompose(
    input: TaskInput,
    perception: PerceptualHierarchy,
    memory: WorkingMemoryState,
    routing?: RoutingDecision,
  ): Promise<TaskDAG>;
  /** Wave 2: alternative plan after a failed outer-loop attempt. Optional — stubs don't implement it. */
  replan?(
    input: TaskInput,
    perception: PerceptualHierarchy,
    memory: WorkingMemoryState,
    failure: import('./replan/replan-prompt.ts').FailureContext,
  ): Promise<TaskDAG>;
}

export interface WorkerPool {
  dispatch(
    input: TaskInput,
    perception: PerceptualHierarchy,
    memory: WorkingMemoryState,
    plan: TaskDAG | undefined,
    routing: RoutingDecision,
    understanding?: SemanticTaskUnderstanding,
    contract?: import('../core/agent-contract.ts').AgentContract,
    conversationHistory?: import('./types.ts').ConversationEntry[],
  ): Promise<import('./phases/types.ts').WorkerResult>;
  /** Returns agent loop deps if configured (Phase 6.3+), null otherwise. */
  getAgentLoopDeps?(): import('./agent/agent-loop.ts').AgentLoopDeps | null;
}

export interface OracleGate {
  verify(
    mutations: Array<{ file: string; content: string }>,
    workspace: string,
    verificationHint?: import('./types.ts').VerificationHint,
    routingLevel?: number,
  ): Promise<import('./phases/types.ts').VerificationResult>;
}

export interface TraceCollector {
  record(trace: ExecutionTrace): Promise<void>;
  /** Optional: returns total trace count for data-gated features. */
  getTraceCount?(): number;
}

// ---------------------------------------------------------------------------
// Orchestrator deps (consumed by factory.ts and tests)
// ---------------------------------------------------------------------------

export interface OrchestratorDeps {
  perception: PerceptionAssembler;
  riskRouter: RiskRouter;
  selfModel: SelfModel;
  decomposer: TaskDecomposer;
  workerPool: WorkerPool;
  oracleGate: OracleGate;
  traceCollector: TraceCollector;
  bus?: VinyanBus;
  /** Workspace root — needed for commitArtifacts after oracle verification. */
  workspace?: string;
  // Phase 2 — optional, activated by factory when DB is available
  skillManager?: import('./skill-manager.ts').SkillManager;
  shadowRunner?: import('./shadow-runner.ts').ShadowRunner;
  ruleStore?: import('../db/rule-store.ts').RuleStore;
  toolExecutor?: import('./tools/tool-executor.ts').ToolExecutor;
  // Phase 4 — optional, activated by factory when worker profiles are available
  workerSelector?: import('./fleet/worker-selector.ts').WorkerSelector;
  workerStore?: import('../db/worker-store.ts').WorkerStore;
  workerLifecycle?: import('./fleet/worker-lifecycle.ts').WorkerLifecycle;
  /** WorldGraph for committing verified facts (A4: content-addressed truth). */
  worldGraph?: import('../world-graph/world-graph.ts').WorldGraph;
  /** CriticEngine — L2+ semantic verification (§17.6). Skip gracefully if absent. */
  criticEngine?: import('./critic/critic-engine.ts').CriticEngine;
  /** TestGenerator — L2+ generative verification (§17.7). Skip gracefully if absent. */
  testGenerator?: import('./test-gen/test-generator.ts').TestGenerator;
  /** Epsilon-greedy exploration rate (default 0.05). Set to 0 in tests for determinism. */
  explorationEpsilon?: number;
  // Phase 5 — optional, activated when A2A instances configured
  /** InstanceCoordinator for cross-instance task delegation and remote oracle dispatch (PH5.8). */
  instanceCoordinator?: import('./instance-coordinator.ts').InstanceCoordinator;
  /** ApprovalGate for human-in-the-loop approval of high-risk tasks (A6). */
  approvalGate?: import('./approval-gate.ts').ApprovalGate;
  /** ForwardPredictor — World Model for probabilistic outcome prediction (A7). */
  forwardPredictor?: import('./forward-predictor-types.ts').ForwardPredictor;
  /** ThinkingPolicyCompiler — 2D routing grid (Extensible Thinking Phase 2.1). */
  thinkingPolicyCompiler?: import('./thinking/thinking-policy.ts').ThinkingPolicyCompiler;
  /** G2+G5: RejectedApproachStore — persists failed approaches for cross-task learning. */
  rejectedApproachStore?: import('../db/rejected-approach-store.ts').RejectedApproachStore;
  /** STU: TraceStore for historical profiler in enrichUnderstanding(). */
  traceStore?: import('../db/trace-store.ts').TraceStore;
  /** STU Layer 2: Understanding engine for semantic intent extraction. */
  understandingEngine?: import('./understanding/understanding-engine.ts').UnderstandingEngine;
  /** K2: Provider trust store for recording per-provider success/failure outcomes. */
  providerTrustStore?: import('../db/provider-trust-store.ts').ProviderTrustStore;
  /** Economy: Cost ledger for persistent cost tracking. */
  costLedger?: import('../economy/cost-ledger.ts').CostLedger;
  /** Economy: Budget enforcer for global budget cap enforcement. */
  budgetEnforcer?: import('../economy/budget-enforcer.ts').BudgetEnforcer;
  /** Economy: Rate cards config for cost computation. */
  economyRateCards?: Record<string, import('../economy/economy-config.ts').RateCardEntry>;
  /** Economy L2: Cost predictor for per-task-type cost forecasting. */
  costPredictor?: import('../economy/cost-predictor.ts').CostPredictor;
  /** Economy L2: Dynamic budget allocator for adaptive per-task budgets. */
  dynamicBudgetAllocator?: import('../economy/dynamic-budget-allocator.ts').DynamicBudgetAllocator;
  /** HMS: Hallucination Mitigation System config (disabled by default). */
  hmsConfig?: import('../hms/hms-config.ts').HMSConfig;
  /** K2.2: Engine selector for trust-weighted provider selection. */
  engineSelector?: import('./engine-selector.ts').EngineSelector;
  /** K2.3: Concurrent dispatcher for parallel multi-task execution. */
  concurrentDispatcher?: import('./concurrent-dispatcher.ts').ConcurrentDispatcher;
  /** K2.5: MCP client pool for external tool access with oracle verification. */
  mcpClientPool?: import('../mcp/client.ts').MCPClientPool;
  /** Crash Recovery: Task checkpoint store for pre-dispatch persistence. */
  taskCheckpoint?: import('../db/task-checkpoint-store.ts').TaskCheckpointStore;
  /** Session manager for conversation history loading (conversation agent mode). */
  sessionManager?: import('../api/session-manager.ts').SessionManager;
  /** LLM provider registry for Intent Resolver pre-routing classification. */
  llmRegistry?: import('./llm/provider-registry.ts').LLMProviderRegistry;
  /** Remediation engine for automatic tool failure recovery (fast-tier LLM). */
  remediationEngine?: import('./remediation-engine.ts').RemediationEngine;
  /** User preference store for learned app/tool preferences. */
  userPreferenceStore?: import('../db/user-preference-store.ts').UserPreferenceStore;
  /** Mines user interests from traces + session messages. Enriches intent resolution. */
  userInterestMiner?: import('./user-context/user-interest-miner.ts').UserInterestMiner;
  /** Workflow approval gating config (from vinyan.json `workflow`). */
  workflowConfig?: import('./workflow/approval-gate.ts').WorkflowConfig;
  // Monitoring — Self-Improving Autonomy.
  /** Per-engine EMA accuracy calibrator. Optional; phase-learn updates it on every trace. */
  oracleEMACalibrator?: import('./monitoring/oracle-ema-calibrator.ts').OracleEMACalibrator;
  /** Silent-regression watchdog. Optional; phase-learn feeds task outcomes into it per trace. */
  regressionMonitor?: import('./monitoring/regression-monitor.ts').RegressionMonitor;
  // Wave 1: Goal-Satisfaction Outer Loop (gated OFF by default).
  /** Deterministic goal evaluator reused across outer iterations (A1/A3). */
  goalEvaluator?: GoalEvaluator;
  /** Goal-loop runtime config. When `enabled`, executeTask wraps attempts in executeWithGoalLoop. */
  goalLoop?: { enabled: boolean; maxOuterIterations: number; goalSatisfactionThreshold: number };
  // Wave 3: Agent-Facing Memory API ("second brain") — read-only queries over all stores.
  agentMemory?: AgentMemoryAPI;
  // Wave 2: Replan Engine (gated OFF by default). Requires Wave 1 (goalLoop).
  replanEngine?: import('./replan/replan-engine.ts').ReplanEngine;
  replanConfig?: import('./replan/replan-engine.ts').ReplanEngineConfig;
  // Wave 6: Workflow registry — metadata surface for strategy validation.
  // When present, the dispatch path uses it as a fallback gate: unknown
  // strategies (e.g. LLM-fabricated labels) are routed to registry.fallback()
  // instead of falling through to the bare `full-pipeline` path silently.
  workflowRegistry?: WorkflowRegistry;
  // Wave A: Error attribution bus — routes orphaned learning signals into corrective actions (A7).
  errorAttributionBus?: import('./prediction/error-attribution-bus.ts').ErrorAttributionBus;
  // Wave B: Decomposition learner — records winning DAG shapes for future seed retrieval.
  decompositionLearner?: import('./replan/decomposition-learner.ts').DecompositionLearner;
  // ACR (Agent Conversation Room): dispatcher wired by factory when a
  // workerSelector + workerStore are available. When absent, phase-generate
  // falls through to the existing L2+ agentic-loop branch even if the
  // decomposer emits `collaborationMode: 'room'`.
  roomDispatcher?: import('./room/room-dispatcher.ts').RoomDispatcher;
  // Agent Context Layer: post-task learning for persistent agent identity/memory/skills.
  agentContextUpdater?: import('./agent-context/context-updater.ts').AgentContextUpdater;
  // Unified profile: read-only fleet view passed to phases (Predict/Plan/Generate).
  // Attenuation of oracle verdicts (Verify) uses the module-level store injected
  // into gate.ts via setLocalOracleProfileStore — not carried here.
  fleetRegistry?: import('./profile/fleet-registry.ts').FleetRegistry;
  // AgentProfile — workspace-level Vinyan Agent identity (singleton).
  // Set by factory after bootstrapAgentProfile() during construction.
  agentProfile?: import('./types.ts').AgentProfile;
  /** Store for reading/updating the singleton AgentProfile at runtime. */
  agentProfileStore?: import('../db/agent-profile-store.ts').AgentProfileStore;
  /**
   * Multi-agent: specialist registry (ts-coder, writer, etc.).
   * Built from vinyan.json `agents[]` + built-in defaults by the factory.
   * Intent resolver uses this for auto-classification; prompt assembly for persona injection.
   */
  agentRegistry?: import('./agents/registry.ts').AgentRegistry;
  /**
   * Multi-agent: SOUL.md store for evolved/reflected persona content.
   * Used by conversational short-circuit to inject the same persona that
   * worker-pool injects in full-pipeline. When absent, falls back to the
   * inline `agent.soul` baked into AgentSpec.
   */
  soulStore?: import('./agent-context/soul-store.ts').SoulStore;
  /**
   * Phase 2: rule-first AgentRouter. Pre-routes the task to a specialist based on
   * file extensions, frameworks, and domain signals. When the rule path fires,
   * the intent resolver's agent-selection step is skipped (deterministic, A3).
   */
  agentRouter?: import('./agent-router.ts').AgentRouter;
  /**
   * Phase 2: when true, the conversational short-circuit path uses
   * `provider.generateStream` (if available) and emits `agent:text_delta`
   * bus events as tokens arrive. Purely observational (A3). Default false.
   */
  streamingAssistantDelta?: boolean;
  /**
   * Conversation comprehension engine — runs BEFORE intent resolution to
   * produce an oracle-verified, structured understanding of the current
   * turn (rootGoal anchoring, clarification-answer detection, referent
   * ambiguity flagging). When omitted, the core-loop instantiates a
   * rule-based comprehender on demand — the pipeline never hard-fails
   * because comprehension is available; it either produces a verified
   * envelope or a `type:'unknown'` envelope that downstream routing
   * gracefully ignores.
   *
   * See `src/orchestrator/comprehension/` and `src/oracle/comprehension/`.
   */
  comprehensionEngine?: import('./comprehension/types.ts').ComprehensionEngine;
  /**
   * A7 learning-loop persistence (P2.A). When provided, each comprehension
   * turn is recorded via ComprehensionStore, and the prior turn's outcome
   * is marked via CorrectionDetector before the new turn runs. Without
   * this, the pipeline works identically — just without calibration data
   * for `comprehension:calibrated` bus events or data-gate enforcement.
   */
  comprehensionStore?: import('../db/comprehension-store.ts').ComprehensionStore;
  /**
   * P2.C stage-2 engine — LLM-backed comprehender. Runs ONLY when the
   * rule-based stage 1 flags `hasAmbiguousReferents=true`. Its envelope
   * is verified separately (engineType='llm' → tier ceiling 'probabilistic')
   * and merged into the final output via A5 rules (see merge.ts).
   *
   * When omitted the pipeline runs stage 1 alone — identical to P2.B
   * behavior. Graceful degradation; never hard-fails on missing stage 2.
   */
  llmComprehensionEngine?: import('./comprehension/types.ts').ComprehensionEngine;
}

const MAX_ROUTING_LEVEL: RoutingLevel = 3;

/** Configurable constants for the core orchestration loop. */
export interface CoreLoopConfig {
  /** Multiplier for global token budget cap (maxTokens * multiplier). Default: 6 */
  budgetCapMultiplier: number;
  /** Maximum routing level for conversational/inquire tasks. Default: 1 */
  maxConversationalLevel: RoutingLevel;
}

export const CORE_LOOP_DEFAULTS: CoreLoopConfig = {
  budgetCapMultiplier: 6,
  maxConversationalLevel: 1 as RoutingLevel,
};

// Re-export for backward compatibility
export { mergeForwardAndSelfModel } from './phases/generate-helpers.ts';
export { scorePlanByPrediction } from './phases/phase-plan.ts';

// ---------------------------------------------------------------------------
// Pre-routing setup
// ---------------------------------------------------------------------------

async function prepareExecution(
  input: TaskInput,
  deps: OrchestratorDeps,
  presetWorkingMemory?: WorkingMemory,
): Promise<
  | {
      understanding: SemanticTaskUnderstanding;
      routing: RoutingDecision;
      workingMemory: WorkingMemory;
      explorationFlag: boolean;
      intentResolution?: IntentResolution;
      /**
       * Oracle-verified conversation comprehension (A1). Present when the
       * comprehension phase ran AND the oracle accepted the envelope.
       * Downstream phases (intent resolver, gate, worker prompt) read
       * structured state (isClarificationAnswer, rootGoal, resolvedGoal)
       * from here; they fall back to the literal goal when absent.
       */
      comprehension?: import('./comprehension/types.ts').ComprehendedTaskMessage;
    }
  | TaskResult
> {
  // ── K1.5: Input validation gate ──
  const inputCheck = validateInput(input.goal);
  if (inputCheck.status === 'rejected') {
    deps.bus?.emit('security:injection_detected', {
      taskId: input.id,
      detections: inputCheck.detections,
      timestamp: Date.now(),
    });
    const securityTrace: ExecutionTrace = {
      id: `trace-${input.id}-security`,
      taskId: input.id,
      workerId: 'kernel',
      timestamp: Date.now(),
      routingLevel: 0,
      approach: 'security-rejection',
      oracleVerdicts: {},
      modelUsed: 'none',
      tokensConsumed: 0,
      durationMs: 0,
      outcome: 'failure',
      failureReason: inputCheck.reason,
      affectedFiles: [],
    };
    await deps.traceCollector.record(securityTrace);
    return { id: input.id, status: 'failed', mutations: [], trace: securityTrace };
  }

  // STU: Build SemanticTaskUnderstanding (Layer 0+1)
  const { enrichUnderstanding } = await import('./understanding/task-understanding.ts');
  const understandingStart = Date.now();
  let understanding = enrichUnderstanding(input, {
    workspace: deps.workspace ?? '.',
    worldGraph: deps.worldGraph,
    traceStore: deps.traceStore,
  });
  const understandingDurationMs = Date.now() - understandingStart;
  deps.bus?.emit('understanding:layer0_complete', {
    taskId: input.id,
    durationMs: understandingDurationMs,
    verb: understanding.actionVerb,
    category: understanding.actionCategory,
  });
  deps.bus?.emit('understanding:layer1_complete', {
    taskId: input.id,
    durationMs: understandingDurationMs,
    entitiesResolved: understanding.resolvedEntities.length,
    isRecurring: understanding.historicalProfile?.isRecurring ?? false,
  });

  // ── Conversation Comprehension (A1: engine proposes → oracle verifies) ──
  // Runs BEFORE intent resolution so the resolver sees structured state
  // flags (isClarificationAnswer, rootGoal, resolvedGoal) instead of
  // having to rediscover them from raw conversation history. Any failure
  // (missing session manager, engine error, oracle reject) falls back to
  // the literal goal — the pipeline never hard-fails.
  let comprehension: import('./comprehension/types.ts').ComprehendedTaskMessage | undefined;
  try {
    const { newRuleComprehender } = await import('./comprehension/rule-comprehender.ts');
    const { verifyComprehension } = await import('../oracle/comprehension/index.ts');
    const { loadAutoMemory } = await import('../memory/auto-memory-loader.ts');
    const { detectCorrection } = await import('./comprehension/learning/correction-detector.ts');
    const engine = deps.comprehensionEngine ?? newRuleComprehender();

    // A7 learning-loop step 1 (markOutcome on prior turn):
    // BEFORE running this turn's comprehension, look up the session's
    // most-recent comprehension record and label its outcome based on
    // what the user just said. This closes the calibration half of A7.
    // Purely best-effort — a DB error / missing store skips this step.
    if (deps.comprehensionStore && input.sessionId) {
      try {
        const priorRows = deps.comprehensionStore.mostRecentForSession(input.sessionId, 1);
        const priorRecord = priorRows[0] ?? null;
        if (priorRecord && !priorRecord.outcome) {
          // Peek at pending clarifications for this turn's message to decide
          // if this is a clarification-answer continuation.
          let thisTurnIsClarAnswer = false;
          try {
            const pending = deps.sessionManager?.getPendingClarifications(input.sessionId) ?? [];
            thisTurnIsClarAnswer = pending.length > 0;
          } catch { /* best-effort */ }
          // Simple new-topic heuristic: no prior user turns in history other
          // than the current message. Detailed detection lives in the
          // comprehender, but we don't have its output YET at this point —
          // so we use the session manager's raw history count.
          let thisTurnIsNewTopic = false;
          try {
            const histAll = deps.sessionManager?.getConversationHistory(input.sessionId, 2000) ?? [];
            const priorUserCount = histAll.filter(
              (h) => h.role === 'user' && h.content !== input.goal,
            ).length;
            thisTurnIsNewTopic = priorUserCount === 0;
          } catch { /* best-effort */ }

          const verdict = detectCorrection({
            priorRecord,
            currentUserMessage: input.goal,
            currentIsClarificationAnswer: thisTurnIsClarAnswer,
            currentIsNewTopic: thisTurnIsNewTopic,
          });
          if (verdict) {
            deps.comprehensionStore.markOutcome(priorRecord.input_hash, {
              outcome: verdict.outcome,
              evidence: verdict.evidence,
            });
            deps.bus?.emit('comprehension:calibrated', {
              taskId: input.id,
              priorInputHash: priorRecord.input_hash,
              engineId: priorRecord.engine_id,
              outcome: verdict.outcome,
              evidence: verdict.evidence,
            });

            // AXM#3: after labeling an outcome, check whether this
            // engine's recent accuracy has dropped materially below its
            // historical window. When the divergence gate fires, emit
            // a bus event — consumers (oracle tier-clamp, dashboards)
            // react without blocking the pipeline.
            try {
              const { ComprehensionCalibrator } = await import(
                './comprehension/learning/calibrator.ts'
              );
              const calib = new ComprehensionCalibrator(deps.comprehensionStore);
              const signal = calib.detectDivergence(priorRecord.engine_id);
              if (signal && signal.diverged) {
                deps.bus?.emit('comprehension:calibration_diverged', {
                  taskId: input.id,
                  engineId: signal.engineId,
                  engineType: priorRecord.engine_type ?? 'unknown',
                  recentAccuracy: signal.recentAccuracy,
                  historicalAccuracy: signal.historicalAccuracy,
                  delta: signal.delta,
                  recentSamples: signal.recentSamples,
                  historicalSamples: signal.historicalSamples,
                });
              }
            } catch { /* divergence check is advisory */ }
          }
        }
      } catch { /* best-effort — calibration never blocks the pipeline */ }
    }

    // Build input from session + pending clarifications.
    let history: import('./types.ts').ConversationEntry[] = [];
    let pendingQuestions: string[] = [];
    let rootGoal: string | null = null;
    if (input.sessionId && deps.sessionManager) {
      try {
        history = deps.sessionManager.getConversationHistory(input.sessionId, 4000);
      } catch { /* best-effort */ }
      try {
        pendingQuestions = deps.sessionManager.getPendingClarifications(input.sessionId);
      } catch { /* best-effort */ }
      try {
        rootGoal = deps.sessionManager.getOriginalTaskGoal(input.sessionId);
      } catch { /* best-effort */ }
    }

    // Clarification-answer fallback: when the API handler records the user
    // turn BEFORE dispatching this task, `getPendingClarifications()` returns
    // `[]` (its guard: "last message is user → already answered"). The
    // original questions + user reply survive in the `CLARIFICATION_BATCH:`
    // constraint emitted by server.ts/chat.ts. Parse them here so the
    // comprehender sees `pendingQuestions` non-empty and can flag
    // `isClarificationAnswer=true` — preventing the intent-resolver from
    // re-triggering the same contradiction that produced the clarification.
    if (pendingQuestions.length === 0 && input.constraints) {
      for (const c of input.constraints) {
        if (!c.startsWith('CLARIFICATION_BATCH:')) continue;
        try {
          const raw = c.slice('CLARIFICATION_BATCH:'.length);
          const parsed = JSON.parse(raw) as { questions?: unknown };
          if (Array.isArray(parsed.questions)) {
            const qs = parsed.questions.filter((q): q is string => typeof q === 'string');
            if (qs.length > 0) {
              pendingQuestions = qs;
              break;
            }
          }
        } catch { /* malformed constraint — best-effort */ }
      }
    }

    // Load user AutoMemory (`~/.vinyan/memory/<slug>/MEMORY.md` or Claude
    // Code shared path). Null when absent — engine emits empty
    // memoryLaneRelevance. Every returned entry is tagged
    // `trustTier: 'probabilistic'` and passes through `sanitizeForPrompt`
    // (A5 + Red Team #3 — second-order injection defense).
    let autoMemory: Awaited<ReturnType<typeof loadAutoMemory>> = null;
    try {
      autoMemory = loadAutoMemory({ workspace: deps.workspace ?? process.cwd() });
    } catch { /* best-effort — null means no memory lane, pipeline proceeds */ }

    const generatedAt = Date.now();
    const comprehensionInput = {
      input,
      history,
      pendingQuestions,
      rootGoal,
      autoMemory,
    };
    const stage1Envelope = await engine.comprehend(comprehensionInput);
    // The envelope USED by downstream is stage1 until stage 2 contributes.
    let envelope = stage1Envelope;
    deps.bus?.emit('comprehension:generated', {
      taskId: input.id,
      engineId: engine.id,
      tier: envelope.params.tier,
      type: envelope.params.type,
      confidence: envelope.params.confidence,
      inputHash: envelope.params.inputHash,
      durationMs: Date.now() - generatedAt,
    });

    const stage1Verdict = verifyComprehension({
      message: stage1Envelope,
      history,
      pendingQuestions,
      // AXM#1 (A3/A5): pass the orchestrator-declared engineType so the
      // oracle enforces a per-type tier ceiling. Prevents an LLM engine
      // from claiming deterministic/heuristic at face value.
      engineType: engine.engineType,
    });
    let verdict = stage1Verdict;

    // P2.C.3 — HYBRID pipeline. Run the LLM comprehender only when:
    //   (a) stage 1 succeeded AND stage 1 explicitly flagged ambiguous referents
    //       (no speculative LLM invocations — A3 discipline), AND
    //   (b) a stage-2 engine is registered.
    // Merge via A5 rules (see merge.ts). Stage-2 failure is graceful —
    // we keep stage 1's result and its verdict.
    if (
      deps.llmComprehensionEngine &&
      stage1Verdict.verified &&
      stage1Envelope.params.type === 'comprehension' &&
      stage1Envelope.params.data?.state.hasAmbiguousReferents === true
    ) {
      try {
        const stage2Engine = deps.llmComprehensionEngine;
        const stage2StartMs = Date.now();
        const stage2Envelope = await stage2Engine.comprehend(comprehensionInput);
        const stage2GenDurationMs = Date.now() - stage2StartMs;
        deps.bus?.emit('comprehension:generated', {
          taskId: input.id,
          engineId: stage2Engine.id,
          tier: stage2Envelope.params.tier,
          type: stage2Envelope.params.type,
          confidence: stage2Envelope.params.confidence,
          inputHash: stage2Envelope.params.inputHash,
          durationMs: stage2GenDurationMs,
        });
        const stage2Verdict = verifyComprehension({
          message: stage2Envelope,
          history,
          pendingQuestions,
          engineType: stage2Engine.engineType,
        });
        deps.bus?.emit('comprehension:verified', {
          taskId: input.id,
          verified: stage2Verdict.verified,
          verdictType: stage2Verdict.type,
          tier: stage2Verdict.tier,
          rejectReason: stage2Verdict.rejectReason,
          durationMs: stage2Verdict.durationMs,
        });

        // P3.A.3 — parity with stage 1: record an ExecutionTrace for
        // stage 2 so Sleep Cycle + SelfModel see both engines
        // uniformly. Without this, per-engine analytics would silently
        // miss stage-2 activity (its data only lived in
        // comprehension_records, not execution_traces).
        try {
          await deps.traceCollector.record({
            id: `trace-${input.id}-comprehension-stage2`,
            taskId: input.id,
            sessionId: input.sessionId,
            workerId: 'comprehension-phase',
            timestamp: Date.now(),
            routingLevel: 0,
            approach: 'comprehension',
            approachDescription: `engine=${stage2Engine.id}, tier=${stage2Envelope.params.tier}, type=${stage2Envelope.params.type}, verified=${stage2Verdict.verified}`,
            oracleVerdicts: { 'comprehension-oracle': stage2Verdict.verified },
            modelUsed: stage2Engine.id,
            engineId: stage2Engine.id,
            tokensConsumed: 0,
            durationMs: stage2GenDurationMs + stage2Verdict.durationMs,
            outcome: stage2Verdict.verified ? 'success' : 'failure',
            failureReason: stage2Verdict.rejectReason,
            affectedFiles: [],
          });
        } catch { /* TraceCollector is best-effort */ }

        if (stage2Verdict.verified) {
          const { mergeComprehensions } = await import('./comprehension/merge.ts');
          const merged = mergeComprehensions(stage1Envelope, stage2Envelope);
          if (merged.s2Contributed) {
            envelope = merged.envelope;
            // verdict stays stage 1 — both sides were independently verified,
            // and the merged envelope carries the lower of the two tiers.
          }
        }

        // Always persist stage 2's record (even on reject) — calibration
        // feeds on every outcome, including rejected ones.
        if (deps.comprehensionStore) {
          try {
            deps.comprehensionStore.record({
              envelope: stage2Envelope,
              taskId: input.id,
              sessionId: input.sessionId,
              engineId: stage2Engine.id,
              engineType: stage2Engine.engineType,
              verdictPass: stage2Verdict.verified,
              verdictReason: stage2Verdict.rejectReason,
            });
          } catch { /* best-effort */ }
        }
      } catch {
        // Stage-2 engines are FAIL-OPEN — any unhandled exception leaves
        // stage 1's result intact.
      }
    }
    deps.bus?.emit('comprehension:verified', {
      taskId: input.id,
      verified: verdict.verified,
      verdictType: verdict.type,
      tier: verdict.tier,
      rejectReason: verdict.rejectReason,
      durationMs: verdict.durationMs,
    });

    // A7 scaffolding: record an ExecutionTrace for the comprehension phase
    // so SelfModel / Sleep Cycle can calibrate comprehension accuracy from
    // downstream outcomes (falsifiable_by: user-corrects-resolved-goal).
    // durationMs = generate + verify (both rule-based, typically <70ms).
    const totalDurationMs = Date.now() - generatedAt;
    try {
      await deps.traceCollector.record({
        id: `trace-${input.id}-comprehension`,
        taskId: input.id,
        sessionId: input.sessionId,
        workerId: 'comprehension-phase',
        timestamp: Date.now(),
        routingLevel: 0,
        approach: 'comprehension',
        approachDescription: `engine=${engine.id}, tier=${envelope.params.tier}, type=${envelope.params.type}, verified=${verdict.verified}`,
        oracleVerdicts: { 'comprehension-oracle': verdict.verified },
        modelUsed: engine.id,
        engineId: engine.id,
        tokensConsumed: 0,
        durationMs: totalDurationMs,
        outcome: verdict.verified ? 'success' : 'failure',
        failureReason: verdict.rejectReason,
        affectedFiles: [],
      });
    } catch { /* TraceCollector is best-effort */ }

    // A7 learning-loop step 2 (record this turn's comprehension). We
    // persist EVERY turn — verified or rejected — because calibration
    // feeds on both (a rejected engine output still counts as a
    // negative sample for that engine's accuracy).
    if (deps.comprehensionStore) {
      try {
        deps.comprehensionStore.record({
          envelope,
          taskId: input.id,
          sessionId: input.sessionId,
          engineId: engine.id,
          engineType: engine.engineType,
          verdictPass: verdict.verified,
          verdictReason: verdict.rejectReason,
        });
      } catch { /* best-effort — persistence never blocks the pipeline */ }
    }

    if (verdict.verified && envelope.params.type === 'comprehension') {
      comprehension = envelope;
      // Thread a compact summary of the oracle-verified comprehension into
      // the DOWNSTREAM understanding.constraints (NOT input.constraints).
      //
      // Two bugs this avoids:
      //  (A6) Mutating `input.constraints` leaks oracle-verified state back
      //       to the caller's reference — a side-channel no upstream code
      //       subscribed to. `understanding` is orchestrator-local and safe
      //       to mutate.
      //  (ref-staleness) `enrichUnderstanding` already ran above, so
      //       `understanding.constraints` is a separate reference from
      //       `input.constraints`. Reassigning `input.constraints` to a
      //       new array would leave `understanding.constraints` pointing
      //       at the old array — the worker (which reads from
      //       understanding) would never see the payload.
      //
      // The projection carries only the minimal shape the worker prompt
      // cares about; the full ECP envelope stays internal to the
      // orchestrator / telemetry.
      const data = envelope.params.data;
      if (data) {
        const summary = {
          rootGoal: data.state.rootGoal ?? undefined,
          resolvedGoal: data.resolvedGoal,
          priorContextSummary: data.priorContextSummary,
          isClarificationAnswer: data.state.isClarificationAnswer,
        };
        const extraConstraints: string[] = [
          `COMPREHENSION_SUMMARY:${JSON.stringify(summary)}`,
        ];

        // P1: when the comprehender flagged relevant AutoMemory entries,
        // look them up in the loaded memory (which the orchestrator holds
        // but the envelope does not — envelope carries refs only), and
        // emit a MEMORY_CONTEXT: payload with the actual content. The
        // worker renders this as `## Relevant User Memory (trust=probabilistic)`.
        //
        // Security notes:
        //  - `trustTier: 'probabilistic'` is fixed at envelope schema level
        //    (Zod literal). No promotion path without explicit verification.
        //  - Content was already sanitized at load time (auto-memory-loader).
        //  - The rule-comprehender caps floor-only entries to 1 and
        //    overall count to MAX_MEMORY_HITS, so a malicious memory pile
        //    cannot crowd out substance-matched hits.
        const matchedRefs = data.memoryLaneRelevance.autoMem ?? [];
        if (matchedRefs.length > 0 && autoMemory) {
          const entriesByRef = new Map(
            autoMemory.entries.map((e) => [e.ref, e] as const),
          );
          const payload = {
            entries: matchedRefs
              .map((m) => {
                const full = entriesByRef.get(m.ref);
                if (!full) return null;
                return {
                  ref: m.ref,
                  type: full.type,
                  description: full.description,
                  trustTier: m.trustTier,
                  content: full.content,
                };
              })
              .filter((e): e is NonNullable<typeof e> => e !== null),
          };
          if (payload.entries.length > 0) {
            extraConstraints.push(`MEMORY_CONTEXT:${JSON.stringify(payload)}`);
          }
        }

        understanding = {
          ...understanding,
          constraints: [...(understanding.constraints ?? []), ...extraConstraints],
        };
      }
      deps.bus?.emit('comprehension:committed', {
        taskId: input.id,
        resolvedGoal: envelope.params.data?.resolvedGoal ?? input.goal,
        used: true,
      });
    } else {
      // Oracle rejected OR engine honestly reported unknown — fall back.
      deps.bus?.emit('comprehension:committed', {
        taskId: input.id,
        resolvedGoal: input.goal,
        used: false,
        fallbackReason:
          verdict.rejectReason ?? `engine.type=${envelope.params.type}`,
      });
    }
  } catch (err) {
    // Comprehension is advisory — never throw out of this block.
    const reason = err instanceof Error ? err.message : String(err);
    deps.bus?.emit('comprehension:committed', {
      taskId: input.id,
      resolvedGoal: input.goal,
      used: false,
      fallbackReason: `comprehension error: ${reason}`,
    });
  }

  // ── LLM Intent Resolution — semantic classification before pipeline ──
  // Skip for code-mutation tasks (already well-classified by regex) and tasks with explicit target files.
  // Phase 2: AgentRouter — rule-first specialist selection BEFORE intent resolver.
  // When rule-match or CLI override fires, we skip the LLM agent pick entirely.
  // When ambiguous ('needs-llm'), the intent resolver classifies and we use its agentId.
  if (deps.agentRouter) {
    const routeDecision = deps.agentRouter.route(input);
    if (routeDecision.reason === 'override' || routeDecision.reason === 'rule-match') {
      // Deterministic decision — set it on input; intent resolver (if called)
      // will see input.agentId pre-set and skip its own classification.
      input.agentId = routeDecision.agentId;
      deps.bus?.emit('agent:routed', {
        taskId: input.id,
        agentId: routeDecision.agentId,
        reason: routeDecision.reason,
        score: routeDecision.score,
      });
    }
  }

  // Guard on actual provider presence — an empty registry can't resolve intent and will throw.
  const hasProviders = (deps.llmRegistry?.listProviders().length ?? 0) > 0;
  const needsIntentResolution =
    hasProviders && understanding.taskDomain !== 'code-mutation' && !input.targetFiles?.length;
  let intentResolution: IntentResolution | undefined;
  if (needsIntentResolution && deps.llmRegistry) {
    try {
      const { resolveIntent } = await import('./intent-resolver.ts');
      // Load conversation history for multi-turn intent classification
      let conversationCtx: import('./types.ts').ConversationEntry[] | undefined;
      if (input.sessionId && deps.sessionManager) {
        try {
          conversationCtx = deps.sessionManager.getConversationHistoryCompacted(input.sessionId, 2000);
        } catch { /* non-fatal */ }
      }
      intentResolution = await resolveIntent(input, {
        registry: deps.llmRegistry,
        availableTools: deps.toolExecutor?.getToolNames(),
        bus: deps.bus,
        userPreferences: deps.userPreferenceStore?.formatForPrompt(),
        conversationHistory: conversationCtx,
        agents: deps.agentRegistry?.listAgents(),
        defaultAgentId: deps.agentRegistry?.defaultAgent().id,
        userInterestMiner: deps.userInterestMiner,
        sessionId: input.sessionId,
        // Deterministic-first pipeline: pass STU so the resolver can compute
        // a rule candidate before the LLM runs (tier 0.8, may bypass LLM).
        understanding,
        // Oracle-verified conversation comprehension (A1): cache-key binding
        // (A4) + explicit "isClarificationAnswer" routing rule in the prompt.
        comprehension,
      });
      // Multi-agent: propagate resolved agentId onto the input for downstream phases
      if (intentResolution.agentId) {
        input.agentId = intentResolution.agentId;
      }
      // resolveIntent now emits 'intent:resolved' itself with richer payload
      // (type, source). Legacy emit kept for listeners that haven't migrated —
      // but only when resolver didn't already emit (cache hit path). Skipping
      // duplicate emits by default.
    } catch (err) {
      // Intent resolution failure is non-fatal — fall back to regex-based classification
      const reason = err instanceof Error ? err.message : String(err);
      const { fallbackStrategy } = await import('./intent-resolver.ts');
      const strategy = fallbackStrategy(
        understanding.taskDomain,
        understanding.taskIntent,
        understanding.toolRequirement,
        // Pass comprehension so context-aware fallback preserves workflow
        // on clarification-answer turns even when LLM is down (A3 graceful
        // degradation).
        comprehension,
      );
      intentResolution = {
        strategy,
        refinedGoal: input.goal,
        confidence: 0.5,
        reasoning: `Fallback: regex-based (${reason})`,
        reasoningSource: 'fallback',
        type: 'known',
      };
      deps.bus?.emit('intent:resolved', {
        taskId: input.id,
        strategy: intentResolution.strategy,
        confidence: intentResolution.confidence,
        reasoning: intentResolution.reasoning,
        type: 'known',
        source: 'fallback',
      });
    }
  }

  // G2: Wire archiver for rejected approaches
  const archiver = deps.rejectedApproachStore
    ? (entry: WorkingMemoryState['failedApproaches'][number]) => {
        deps.rejectedApproachStore!.store({
          taskId: input.id,
          taskType: input.taskType,
          fileTarget: input.targetFiles?.[0],
          approach: entry.approach,
          oracleVerdict: entry.oracleVerdict,
          verdictConfidence: entry.verdictConfidence,
          failureOracle: entry.failureOracle,
          source: 'eviction',
          actionVerb: understanding.actionVerb,
        });
      }
    : undefined;
  let workingMemory: WorkingMemory;
  if (presetWorkingMemory) {
    workingMemory = presetWorkingMemory;
    if (archiver) workingMemory.attachArchiver(archiver);
  } else {
    workingMemory = new WorkingMemory({ bus: deps.bus, taskId: input.id, archiver });
  }

  // Session memory: hydrate from prior turns (A7: cross-turn learning)
  // Wave 1 gap fix: use idempotent flag on WM so outer-loop iterations
  // don't duplicate hydrated entries. First call hydrates + marks;
  // subsequent calls skip via the flag check.
  if (!workingMemory.isSessionHydrated() && input.sessionId && deps.sessionManager) {
    try {
      const memoryJson = deps.sessionManager.getSessionWorkingMemory(input.sessionId);
      if (memoryJson) {
        const prior = JSON.parse(memoryJson) as WorkingMemoryState;
        // Seed failed approaches from prior turns
        for (const fa of prior.failedApproaches ?? []) {
          workingMemory.recordFailedApproach(fa.approach, fa.oracleVerdict, fa.verdictConfidence, fa.failureOracle);
        }
        // Seed scoped facts from prior turns
        for (const fact of prior.scopedFacts ?? []) {
          workingMemory.addScopedFact(fact.target, fact.pattern, fact.verified, fact.hash);
        }
      }
      workingMemory.markSessionHydrated();
    } catch {
      // Session memory hydration is best-effort
      workingMemory.markSessionHydrated(); // mark to avoid retry storms
    }
  }

  // Cross-task learning: load prior failed approaches
  // Wave 1 gap fix: idempotent flag — load once per task regardless of
  // outer-loop iteration count.
  if (!workingMemory.isCrossTaskLoaded() && deps.rejectedApproachStore && input.targetFiles?.length) {
    try {
      const { loadPriorFailedApproaches } = await import('./cross-task-loader.ts');
      const priorApproaches = loadPriorFailedApproaches(
        deps.rejectedApproachStore,
        input.targetFiles[0]!,
        input.taskType,
        undefined,
        understanding.actionVerb,
      );
      for (const approach of priorApproaches) {
        workingMemory.recordFailedApproach(
          approach.approach,
          approach.oracleVerdict,
          approach.verdictConfidence,
          approach.failureOracle,
        );
      }
      workingMemory.markCrossTaskLoaded();
    } catch {
      // Cross-task loading is best-effort
      workingMemory.markCrossTaskLoaded(); // mark to avoid retry storms
    }
  }

  // Routing
  let routing = await deps.riskRouter.assessInitialLevel(input);

  // Evolution Rules (Phase 2.6)
  if (deps.ruleStore) {
    const fp = (input.targetFiles ?? []).sort().join(',') || '*';
    const matchingRules = deps.ruleStore.findMatching({ filePattern: fp });
    if (matchingRules.length > 0) {
      const { resolveRuleConflicts } = await import('../evolution/rule-resolver.ts');
      const { checkSafetyInvariants } = await import('../evolution/safety-invariants.ts');
      const winners = resolveRuleConflicts(matchingRules);
      for (const rule of winners) {
        if (!checkSafetyInvariants(rule).safe) continue;
        if (rule.action === 'escalate' && typeof rule.parameters.toLevel === 'number') {
          const newLevel = rule.parameters.toLevel as RoutingLevel;
          if (newLevel > routing.level) routing = { ...routing, level: newLevel };
        }
        if (rule.action === 'require-oracle' && typeof rule.parameters.oracleName === 'string') {
          routing = { ...routing, mandatoryOracles: [...(routing.mandatoryOracles ?? []), rule.parameters.oracleName] };
        }
        if (rule.action === 'prefer-model' && typeof rule.parameters.preferredModel === 'string') {
          routing = { ...routing, model: rule.parameters.preferredModel };
        }
        if (rule.action === 'adjust-threshold' && typeof rule.parameters.riskThreshold === 'number') {
          routing = { ...routing, riskThresholdOverride: rule.parameters.riskThreshold };
        }
        if (rule.action === 'assign-worker' && typeof rule.parameters.workerId === 'string') {
          routing = { ...routing, workerId: rule.parameters.workerId };
        }
      }
      deps.bus?.emit('evolution:rulesApplied', { taskId: input.id, rules: winners });
    }
  }

  // Epsilon-greedy exploration
  const EPSILON = deps.explorationEpsilon ?? 0.05;
  let explorationFlag = false;
  if (routing.level < MAX_ROUTING_LEVEL && Math.random() < EPSILON) {
    const fromLevel = routing.level;
    const newLevel = (routing.level + 1) as RoutingLevel;
    const cfg = LEVEL_CONFIG[newLevel];
    routing = {
      ...routing,
      level: newLevel,
      model: cfg.model,
      budgetTokens: cfg.budgetTokens,
      latencyBudgetMs: cfg.latencyBudgetMs,
    };
    explorationFlag = true;
    deps.bus?.emit('task:explore', { taskId: input.id, fromLevel, toLevel: routing.level });
  }

  // Domain-aware routing caps
  const MAX_CONVERSATIONAL_LEVEL = 1 as RoutingLevel;
  if (understanding.taskDomain === 'conversational' && routing.level > MAX_CONVERSATIONAL_LEVEL) {
    routing = { ...routing, level: MAX_CONVERSATIONAL_LEVEL };
  }
  if (
    understanding.taskDomain === 'general-reasoning' &&
    understanding.taskIntent === 'inquire' &&
    understanding.toolRequirement === 'none' &&
    routing.level > MAX_CONVERSATIONAL_LEVEL
  ) {
    routing = { ...routing, level: MAX_CONVERSATIONAL_LEVEL };
  }

  // Capability floor: tool-needed tasks require L2+
  if (understanding.toolRequirement === 'tool-needed' && routing.level < (2 as RoutingLevel)) {
    const l2Cfg = LEVEL_CONFIG[2];
    routing = {
      ...routing,
      level: 2 as RoutingLevel,
      model: l2Cfg.model,
      budgetTokens: l2Cfg.budgetTokens,
      latencyBudgetMs: l2Cfg.latencyBudgetMs,
    };
  }

  // CLI --tool flag: force tool-needed regardless of classification
  if (input.constraints?.includes('TOOLS:enabled') && understanding.toolRequirement === 'none') {
    understanding = { ...understanding, toolRequirement: 'tool-needed' };
    if (routing.level < (2 as RoutingLevel)) {
      const l2Cfg = LEVEL_CONFIG[2];
      routing = { ...routing, level: 2 as RoutingLevel, model: l2Cfg.model, budgetTokens: l2Cfg.budgetTokens, latencyBudgetMs: l2Cfg.latencyBudgetMs };
    }
  }

  // CLI --thinking flag
  if (input.constraints?.includes('THINKING:enabled') && routing.thinkingConfig?.type === 'disabled') {
    routing = { ...routing, thinkingConfig: { type: 'adaptive', effort: 'low', display: 'summarized' } };
  }

  // Economy L2: Dynamic budget allocation
  if (deps.dynamicBudgetAllocator) {
    const taskSig = (understanding.taskTypeSignature as string | undefined) ?? null;
    const allocation = deps.dynamicBudgetAllocator.allocate(taskSig, routing.level, routing.budgetTokens);
    if (allocation.source !== 'default') {
      routing = { ...routing, budgetTokens: allocation.maxTokens };
      deps.bus?.emit('economy:budget_allocated', {
        taskId: input.id,
        maxTokens: allocation.maxTokens,
        source: allocation.source,
      });
    }
  }

  // Economy: Budget enforcement
  if (deps.budgetEnforcer) {
    const budgetCheck = deps.budgetEnforcer.canProceed();
    if (!budgetCheck.allowed) {
      const trace: ExecutionTrace = {
        id: `trace-${input.id}-budget`,
        taskId: input.id,
        timestamp: Date.now(),
        routingLevel: routing.level,
        taskTypeSignature: understanding.taskTypeSignature as string | undefined,
        approach: 'budget-blocked',
        oracleVerdicts: {},
        modelUsed: routing.model ?? 'none',
        tokensConsumed: 0,
        durationMs: 0,
        outcome: 'failure',
        failureReason: 'Global budget exceeded',
        affectedFiles: input.targetFiles ?? [],
      };
      await deps.traceCollector.record(trace);
      deps.bus?.emit('task:budget-exceeded', { taskId: input.id, totalTokensConsumed: 0, globalCap: 0 });
      return { id: input.id, status: 'failed', mutations: [], trace, escalationReason: 'Global budget exceeded' };
    }
    if (budgetCheck.degradeToLevel !== undefined && routing.level > budgetCheck.degradeToLevel) {
      const fromLevel = routing.level;
      const degradeLevel = budgetCheck.degradeToLevel as RoutingLevel;
      const cfg = LEVEL_CONFIG[degradeLevel];
      routing = {
        ...routing,
        level: degradeLevel,
        model: cfg.model,
        budgetTokens: cfg.budgetTokens,
        latencyBudgetMs: cfg.latencyBudgetMs,
      };
      deps.bus?.emit('economy:budget_degraded', {
        taskId: input.id,
        fromLevel,
        toLevel: degradeLevel,
        reason: 'Global budget pressure',
      });
    }
  }

  return {
    understanding,
    routing,
    workingMemory,
    explorationFlag,
    intentResolution,
    comprehension,
  };
}

// ---------------------------------------------------------------------------
// Strategy short-circuit helpers
// ---------------------------------------------------------------------------

async function buildConversationalResult(
  input: TaskInput,
  intent: IntentResolution,
  deps: OrchestratorDeps,
): Promise<TaskResult> {
  const provider = deps.llmRegistry?.selectByTier('fast') ?? deps.llmRegistry?.selectByTier('balanced');
  const providerCount = deps.llmRegistry?.listProviders().length ?? 0;

  // A2: Honest "I don't know" — no provider available means no conversational answer possible.
  // Previous behavior echoed the goal back as the answer, which was dishonest.
  if (!provider && providerCount === 0) {
    const trace: ExecutionTrace = {
      id: `trace-${input.id}-no-provider`,
      taskId: input.id,
      workerId: 'kernel',
      timestamp: Date.now(),
      routingLevel: 0,
      approach: 'no-provider-escalation',
      oracleVerdicts: {},
      modelUsed: 'none',
      tokensConsumed: 0,
      durationMs: 0,
      outcome: 'escalated',
      failureReason: 'No LLM provider configured',
      affectedFiles: [],
    };
    await deps.traceCollector.record(trace);
    deps.bus?.emit('trace:record', { trace });
    const result: TaskResult = {
      id: input.id,
      status: 'escalated',
      mutations: [],
      trace,
      answer: '',
      notes: ['No LLM provider configured — set OPENROUTER_API_KEY or ANTHROPIC_API_KEY'],
    };
    deps.bus?.emit('task:complete', { result });
    return result;
  }

  // Provider exists: attempt conversational generation. If generate throws (transient/auth error),
  // fall back to refinedGoal — this is a degraded-but-recoverable path, not a no-provider case.
  let answer = intent.refinedGoal;

  // Multi-agent: resolve the specialist persona for this turn so the
  // short-circuit reply matches the same identity that worker-pool would
  // inject in full-pipeline. Falls back to generic Vinyan when no registry.
  const resolvedAgent = (() => {
    const reg = deps.agentRegistry;
    if (!reg) return undefined;
    const id = intent.agentId ?? reg.defaultAgent().id;
    return reg.getAgent(id) ?? reg.defaultAgent();
  })();
  const personaSystemPrompt = buildConversationalSystemPrompt(resolvedAgent, deps);

  if (provider) {
    try {
      // Load session history for multi-turn conversation continuity
      let messages: import('./types.ts').HistoryMessage[] | undefined;
      if (input.sessionId && deps.sessionManager) {
        try {
          const history = deps.sessionManager.getConversationHistoryCompacted(input.sessionId, 4000);
          if (history.length > 0) {
            messages = history.map((e) => ({
              role: e.role as 'user' | 'assistant',
              content: e.content,
            }));
          }
        } catch { /* non-fatal */ }
      }
      const llmReq = {
        systemPrompt: personaSystemPrompt,
        userPrompt: input.goal,
        maxTokens: 2000,
        temperature: 0.3,
        messages,
      };
      const response =
        deps.streamingAssistantDelta && provider.generateStream
          ? await provider.generateStream(llmReq, ({ text }) => {
              if (!text) return;
              deps.bus?.emit('agent:text_delta', { taskId: input.id, text });
              // Mirror to llm:stream_delta so newer UIs (ChatStreamRenderer,
              // VS Code panel) see the superset shape too.
              deps.bus?.emit('llm:stream_delta', {
                taskId: input.id,
                kind: 'content',
                text,
              });
            })
          : await provider.generate(llmReq);
      answer = response.content;
    } catch {
      answer = intent.refinedGoal;
    }
  }
  const trace: ExecutionTrace = {
    id: `trace-${input.id}-conversational`,
    taskId: input.id,
    // Multi-agent: attribute the trace to the resolved specialist (e.g. 'secretary')
    // so context-builder/agent-evolution count this episode against the right agent.
    // Falls back to 'intent-resolver' for the legacy no-registry path.
    workerId: resolvedAgent?.id ?? 'intent-resolver',
    timestamp: Date.now(),
    routingLevel: 0,
    approach: 'conversational-shortcircuit',
    oracleVerdicts: {},
    modelUsed: provider?.id ?? 'none',
    tokensConsumed: 0,
    durationMs: 0,
    outcome: 'success',
    affectedFiles: [],
  };
  await deps.traceCollector.record(trace);
  deps.bus?.emit('trace:record', { trace });
  const result: TaskResult = { id: input.id, status: 'completed', mutations: [], trace, answer };
  deps.bus?.emit('task:complete', { result });
  return result;
}

/**
 * Compose the conversational short-circuit system prompt with specialist
 * persona injection. Mirrors the persona/peer sections produced by
 * `assemblePrompt()` for the full pipeline so the same identity speaks in
 * both paths. When no agent registry is wired, returns the legacy generic
 * Vinyan prompt for backward compatibility.
 *
 * Soul lookup precedence: SoulStore (evolved/reflected) → AgentSpec.soul (built-in).
 */
function buildConversationalSystemPrompt(
  agent: import('./types.ts').AgentSpec | undefined,
  deps: OrchestratorDeps,
): string {
  const closing = `Respond naturally. Match the user's language. Maintain context across turns.
Never reveal your underlying model name or provider — you are Vinyan.
Do NOT use JSON or code blocks unless the user asks for code.
Do NOT narrate your reasoning process — just respond directly to the user.`;

  if (!agent) {
    return `You are Vinyan, a friendly and capable assistant. You can help with creative writing, analysis, Q&A, brainstorming, and general assistance.
${closing}`;
  }

  const lines: string[] = [];
  lines.push(`You are ${agent.name} (${agent.id}), a Vinyan specialist agent.`);
  lines.push(agent.description);

  // Soul: prefer disk-backed evolved soul (SoulReflector writes here), fall back to built-in.
  const evolvedSoul = deps.soulStore?.loadSoulRaw(agent.id) ?? null;
  const soul = evolvedSoul ?? agent.soul ?? null;
  if (soul) {
    lines.push('');
    lines.push('[AGENT SOUL]');
    lines.push(soul.trim());
  }

  // Peer roster: list other specialists this agent can mention/recommend
  // delegating to. Conversational path can't dispatch (no tool layer here),
  // but knowing peers exist prevents the "I don't have specialist agents"
  // misanswer that triggered this fix.
  const peers = (deps.agentRegistry?.listAgents() ?? []).filter((a) => a.id !== agent.id);
  if (peers.length > 0) {
    lines.push('');
    lines.push('[CONSULTABLE AGENTS]');
    lines.push('Vinyan also has these specialist agents you can suggest delegating to when a request is outside your role:');
    for (const p of peers) {
      lines.push(`  - ${p.id}: ${p.description}`);
    }
  }

  lines.push('');
  lines.push(closing);
  return lines.join('\n');
}

async function executeDirectTool(
  input: TaskInput,
  intent: IntentResolution,
  deps: OrchestratorDeps,
): Promise<TaskResult | null> {
  if (!deps.toolExecutor || !intent.directToolCall) return null;
  const toolCall = {
    id: `tc-intent-${input.id}`,
    tool: intent.directToolCall.tool,
    parameters: intent.directToolCall.parameters,
  };
  const context = {
    workspace: deps.workspace ?? process.cwd(),
    allowedPaths: [] as string[],
    routingLevel: 2 as const,
  };
  try {
    let results = await deps.toolExecutor.executeProposedTools([toolCall], context);
    let toolResult = results[0];
    let modelUsed = 'none';

    // ── Remediation: if tool failed with recoverable error, try discovery then LLM fix ──
    if (toolResult?.status !== 'success' && toolResult?.error) {
      const { classifyToolFailure } = await import('./tool-failure-classifier.ts');
      const exitCode = extractExitCode(toolResult.error);
      const command = (toolCall.parameters.command as string) ?? '';
      const isMacAppLaunch = /^open\s+-a\s+/i.test(command);
      const analysis = classifyToolFailure(exitCode, toolResult.error);

      deps.bus?.emit('tool:failure_classified', {
        taskId: input.id,
        type: analysis.type,
        recoverable: analysis.recoverable,
        error: toolResult.error,
      });

      // Step 1: Deterministic app discovery (no LLM, fast)
      if ((analysis.type === 'not_found' || (isMacAppLaunch && exitCode === 1)) && intent.directToolCall?.tool === 'shell_exec') {
        const { discoverApp } = await import('./tools/direct-tool-resolver.ts');
        // Extract the app name from "open -a <name>" pattern
        const appNameMatch = command.match(/open\s+-a\s+(?:"([^"]+)"|(\S+))/);
        const failedAppName = appNameMatch?.[1] ?? appNameMatch?.[2];
        if (failedAppName) {
          const discovered = await discoverApp(failedAppName);
          if (discovered && discovered.toLowerCase() !== failedAppName.toLowerCase()) {
            const correctedCommand = `open -a ${quoteArgForDiscovery(discovered)}`;
            deps.bus?.emit('tool:remediation_attempted', {
              taskId: input.id,
              correctedCommand,
              confidence: 1.0,
              reasoning: `Discovered installed app: "${discovered}"`,
            });
            const retryCall = {
              id: `tc-discover-${input.id}`,
              tool: toolCall.tool,
              parameters: { ...toolCall.parameters, command: correctedCommand },
            };
            results = await deps.toolExecutor.executeProposedTools([retryCall], context);
            toolResult = results[0];
            modelUsed = 'discovery';
            if (toolResult?.status === 'success') {
              deps.bus?.emit('tool:remediation_succeeded', {
                taskId: input.id,
                correctedCommand,
              });
            }
          }
        }
      }

      // Step 2: LLM remediation (if discovery didn't work)
      if (toolResult?.status !== 'success' && analysis.recoverable && deps.remediationEngine) {
        const suggestion = await deps.remediationEngine.suggest(input.goal, command, analysis, process.platform);

        if (
          suggestion.action === 'retry_corrected' &&
          suggestion.correctedCommand &&
          suggestion.confidence >= deps.remediationEngine.confidenceThreshold
        ) {
          deps.bus?.emit('tool:remediation_attempted', {
            taskId: input.id,
            correctedCommand: suggestion.correctedCommand,
            confidence: suggestion.confidence,
            reasoning: suggestion.reasoning,
          });

          const retryCall = {
            id: `tc-remediate-${input.id}`,
            tool: toolCall.tool,
            parameters: { ...toolCall.parameters, command: suggestion.correctedCommand },
          };
          results = await deps.toolExecutor.executeProposedTools([retryCall], context);
          toolResult = results[0];
          modelUsed = deps.remediationEngine.providerId ?? 'remediation';

          if (toolResult?.status === 'success') {
            deps.bus?.emit('tool:remediation_succeeded', {
              taskId: input.id,
              correctedCommand: suggestion.correctedCommand,
            });
          } else {
            deps.bus?.emit('tool:remediation_failed', {
              taskId: input.id,
              reason: toolResult?.error ?? 'Corrected command also failed',
            });
          }
        } else {
          deps.bus?.emit('tool:remediation_failed', {
            taskId: input.id,
            reason: suggestion.reasoning,
          });
        }
      }
    }

    const trace: ExecutionTrace = {
      id: `trace-${input.id}-direct-tool`,
      taskId: input.id,
      workerId: 'intent-resolver',
      timestamp: Date.now(),
      routingLevel: 2,
      approach: 'direct-tool-shortcircuit',
      oracleVerdicts: {},
      modelUsed,
      tokensConsumed: 0,
      durationMs: toolResult?.durationMs ?? 0,
      outcome: toolResult?.status === 'success' ? 'success' : 'failure',
      failureReason: toolResult?.error,
      affectedFiles: [],
    };
    await deps.traceCollector.record(trace);
    deps.bus?.emit('trace:record', { trace });

    // ── Learn user preference from successful direct-tool execution ──
    if (toolResult?.status === 'success' && deps.userPreferenceStore && intent.directToolCall?.tool === 'shell_exec') {
      try {
        const { detectAppCategory, extractSpecificApp } = await import('../db/user-preference-store.ts');
        const command = String(intent.directToolCall.parameters.command ?? '');
        const specificApp = extractSpecificApp(input.goal);
        const category = detectAppCategory(input.goal);
        // Only record when user explicitly named a specific app.
        // Category-level requests ("แอพ mail") must NOT overwrite
        // learned preferences with the platform default.
        if (category && specificApp && command) {
          deps.userPreferenceStore.recordUsage(category, specificApp, command);
        }
      } catch {
        // Preference recording failure is non-fatal
      }
    }

    const answer =
      toolResult?.status === 'success'
        ? normalizeDirectToolAnswer(toolResult.output)
        : (toolResult?.error ?? 'Tool execution failed');

    const result: TaskResult = {
      id: input.id,
      status: toolResult?.status === 'success' ? 'completed' : 'failed',
      mutations: [],
      trace,
      answer,
    };
    deps.bus?.emit('task:complete', { result });
    return result;
  } catch {
    return null; // Fall through to pipeline
  }
}

function normalizeDirectToolAnswer(output: unknown): string | undefined {
  if (typeof output === 'string') {
    return output.trim() ? output : undefined;
  }
  if (output === undefined || output === null) {
    return undefined;
  }
  return JSON.stringify(output);
}

function shouldFireAndForgetDirectCommand(command: string): boolean {
  const normalized = command.trim().toLowerCase();
  return /^(open(\s+-a)?\s|xdg-open\s|start\s+""\s)/.test(normalized);
}

function enrichDirectToolCall(call: { tool: string; parameters: Record<string, unknown> }): {
  tool: string;
  parameters: Record<string, unknown>;
} {
  if (call.tool !== 'shell_exec' || call.parameters.fireAndForget !== undefined) {
    return call;
  }
  const command = typeof call.parameters.command === 'string' ? call.parameters.command : undefined;
  if (!command || !shouldFireAndForgetDirectCommand(command)) {
    return call;
  }
  return {
    ...call,
    parameters: {
      ...call.parameters,
      fireAndForget: true,
    },
  };
}

/** Extract exit code from error string like "Exit code 127: ..." */
function extractExitCode(error: string): number {
  const match = error.match(/Exit code (\d+)/i);
  return match?.[1] ? parseInt(match[1], 10) : 1;
}

/** Shell-safe quoting for discovered app names. */
function quoteArgForDiscovery(s: string): string {
  if (/^[a-zA-Z0-9_./:@-]+$/.test(s)) return s;
  return `"${s.replace(/"/g, '\\"')}"`;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Execute a task through the full Orchestrator lifecycle.
 *
 * Outer wrapper (Wave 1+3):
 *   - Wave 3: begin/end per-task AgentMemoryAPI cache scope around the entire task
 *   - Wave 1: when goalLoop.enabled, delegate to executeWithGoalLoop so a task can
 *     re-run until the goal evaluator reports satisfaction (budget-gated, A3/A7)
 *   - Default: delegate to executeTaskCore for byte-identical legacy behavior
 */
export async function executeTask(input: TaskInput, deps: OrchestratorDeps): Promise<TaskResult> {
  deps.agentMemory?.beginTask(input.id);
  try {
    const goalLoop = deps.goalLoop;
    if (goalLoop?.enabled && deps.goalEvaluator) {
      return await executeWithGoalLoop(
        input,
        deps,
        (i, wm) => executeTaskCore(i, deps, wm),
        {
          maxOuterIterations: goalLoop.maxOuterIterations,
          goalSatisfactionThreshold: goalLoop.goalSatisfactionThreshold,
        },
      );
    }
    return await executeTaskCore(input, deps);
  } finally {
    deps.agentMemory?.endTask(input.id);
  }
}

/**
 * Core single-attempt task execution — the original executeTask body.
 *
 * Outer loop: escalate routing level on repeated failure (L0 → L1 → L2 → L3 → human)
 * Inner loop: retry within routing level (up to budget.maxRetries)
 *
 * `presetWorkingMemory` is non-undefined only when the goal-satisfaction outer loop
 * passes a carried-over instance so failed approaches + scoped facts accumulate
 * across outer iterations.
 */
async function executeTaskCore(
  input: TaskInput,
  deps: OrchestratorDeps,
  presetWorkingMemory?: WorkingMemory,
): Promise<TaskResult> {
  // Deep-audit #4 (2026-04-15): capture the incoming task id BEFORE
  // any reassignment (Wave 5.2 may reassign `input` to an enhanced
  // clone after plan phase — the clone has the same `id` by spread,
  // but grabbing the id up-front avoids any future maintenance risk
  // if the clone semantics change). The finally block uses this to
  // call `criticEngine.clearTask(taskId)` so DebateRouterCritic
  // releases its per-task budget counter when the task exits.
  const finalizedTaskId = input.id;
  try {
    const prep = await prepareExecution(input, deps, presetWorkingMemory);
    if ('status' in prep) return prep; // Early return (security rejection or budget block)

    // ── Strategy routing — short-circuit non-pipeline strategies ──
    const intentResolution = prep.intentResolution;
    if (intentResolution) {
      // ── Uncertain / contradictory intent → ask the user instead of guessing ──
      // A3 safety: when the resolver flagged epistemic failure, we refuse to
      // dispatch a strategy that may be wrong. Task returns status='input-required'
      // with the clarification carried from the resolver, matching A2A
      // semantics (the next user turn answers the question).
      if (intentResolution.type === 'uncertain' || intentResolution.type === 'contradictory') {
        const clarifText = intentResolution.clarificationRequest
          ?? 'Vinyan is uncertain about how to proceed. Could you clarify?';
        const trace: ExecutionTrace = {
          id: `trace-${input.id}-intent-clarify`,
          taskId: input.id,
          workerId: 'intent-resolver',
          timestamp: Date.now(),
          routingLevel: 0,
          approach: intentResolution.type === 'contradictory' ? 'intent-contradiction' : 'intent-uncertain',
          oracleVerdicts: {},
          modelUsed: intentResolution.reasoningSource ?? 'none',
          tokensConsumed: 0,
          durationMs: 0,
          outcome: 'escalated',
          failureReason: intentResolution.reasoning,
          affectedFiles: [],
        };
        await deps.traceCollector.record(trace);
        deps.bus?.emit('trace:record', { trace });
        const result: TaskResult = {
          id: input.id,
          status: 'input-required',
          mutations: [],
          trace,
          answer: clarifText,
          clarificationNeeded: intentResolution.clarificationOptions?.length
            ? [clarifText, ...intentResolution.clarificationOptions]
            : [clarifText],
          escalationReason: `intent:${intentResolution.type}: ${intentResolution.reasoning}`,
        };
        deps.bus?.emit('task:complete', { result });
        return result;
      }

      // Wave 6: validate strategy against registry. Unknown strategies
      // (e.g. LLM-fabricated labels that don't match any registered
      // handler metadata) fall back to registry.fallback() which by
      // default is 'full-pipeline'. When no registry is wired, behavior
      // is unchanged — the if-chain below handles known strategies
      // and an unknown label implicitly falls through to 'full-pipeline'.
      if (deps.workflowRegistry && !deps.workflowRegistry.has(intentResolution.strategy)) {
        const fallback = deps.workflowRegistry.fallback();
        deps.bus?.emit('intent:resolved', {
          taskId: input.id,
          strategy: fallback as typeof intentResolution.strategy,
          confidence: intentResolution.confidence,
          reasoning: `${intentResolution.reasoning ?? ''} [workflow-registry: unknown '${intentResolution.strategy}' → fallback '${fallback}']`,
        });
        intentResolution.strategy = fallback as typeof intentResolution.strategy;
      }
      if (intentResolution.strategy === 'conversational') {
        return buildConversationalResult(input, intentResolution, deps);
      }
      // Direct-tool: preserve the LLM-produced tool call when present.
      // Deterministic resolution is fallback-only when classification exists but
      // the model omitted an executable call.
      if (intentResolution.strategy === 'direct-tool') {
        // ── Preference / disambiguation for category-level requests (A7) ──
        // "แอพ mail" is ambiguous — could mean Gmail, Outlook, Apple Mail, etc.
        // Decision: learned preference → use it; no preference → ask user.
        if (deps.userPreferenceStore) {
          const { extractSpecificApp, detectAppCategory, getAppsInCategory } = await import('../db/user-preference-store.ts');
          if (!extractSpecificApp(input.goal)) {
            const category = detectAppCategory(input.goal);
            if (category) {
              const pref = deps.userPreferenceStore.getPreference(category);
              if (pref) {
                // Has learned preference (any status) → use it.
                // Even probation (1 use) is a stronger signal than the platform default.
                intentResolution.directToolCall = enrichDirectToolCall({
                  tool: 'shell_exec',
                  parameters: { command: pref.resolvedCommand },
                });
                deps.bus?.emit('preference:applied', {
                  taskId: input.id,
                  category,
                  preferredApp: pref.preferredApp,
                  usageCount: pref.usageCount,
                });
              } else {
                // No preference at all → disambiguate instead of guessing.
                const apps = getAppsInCategory(category);
                if (apps.length > 1) {
                  const examples = apps.slice(0, 5).map((a) => `  - ${a}`).join('\n');
                  const answer = `ไม่แน่ใจว่าคุณต้องการเปิดแอพ ${category} ตัวไหน:\n${examples}\n\nลองระบุชื่อแอพที่ต้องการ เช่น "เปิด ${apps[0]}" — ระบบจะจดจำตัวเลือกของคุณสำหรับครั้งถัดไป`;
                  const trace: ExecutionTrace = {
                    id: `trace-${input.id}-disambiguate`,
                    taskId: input.id,
                    workerId: 'intent-resolver',
                    timestamp: Date.now(),
                    routingLevel: 0,
                    approach: 'preference-disambiguation',
                    oracleVerdicts: {},
                    modelUsed: 'none',
                    tokensConsumed: 0,
                    durationMs: 0,
                    outcome: 'success',
                    affectedFiles: [],
                  };
                  await deps.traceCollector.record(trace);
                  deps.bus?.emit('trace:record', { trace });
                  const result: TaskResult = { id: input.id, status: 'completed', mutations: [], trace, answer };
                  deps.bus?.emit('task:complete', { result });
                  return result;
                }
              }
            }
          }
        }
        if (intentResolution.directToolCall) {
          intentResolution.directToolCall = enrichDirectToolCall(intentResolution.directToolCall);
        } else {
          const { classifyDirectTool, resolveCommand } = await import('./tools/direct-tool-resolver.ts');
          const classification = classifyDirectTool(input.goal);
          if (classification && classification.confidence >= 0.7) {
            const command = resolveCommand(classification, process.platform);
            if (command) {
              intentResolution.directToolCall = enrichDirectToolCall({
                tool: 'shell_exec',
                parameters: { command },
              });
            }
          }
        }
      }
      if (intentResolution.strategy === 'direct-tool' && intentResolution.directToolCall) {
        const directResult = await executeDirectTool(input, intentResolution, deps);
        if (directResult) return directResult;
        // Fall through to pipeline if direct tool execution failed
      }
      if (intentResolution.strategy === 'agentic-workflow') {
        // Phase D+E gate: fresh long-form creative tasks surface structured
        // clarification questions (genre/audience/tone/length/platform) before
        // dispatching the workflow. Skipped once the session has any prior
        // turns — history = implicit consent to proceed.
        const { maybeEmitCreativeClarificationGate } = await import('./creative-clarification-gate.ts');
        const creativeClarify = await maybeEmitCreativeClarificationGate(input, prep.routing, deps);
        if (creativeClarify) return creativeClarify;

        // Workflow Planner + Executor: LLM-powered multi-step workflow that
        // selects per-step strategy and synthesizes a final result. Falls back
        // to legacy goal-rewrite when planner unavailable or on any error.
        try {
          const { executeWorkflow } = await import('./workflow/workflow-executor.ts');
          const workflowResult = await executeWorkflow(input, {
            llmRegistry: deps.llmRegistry,
            worldGraph: deps.worldGraph,
            agentMemory: deps.agentMemory,
            toolExecutor: deps.toolExecutor as import('./workflow/workflow-executor.ts').WorkflowExecutorDeps['toolExecutor'],
            bus: deps.bus,
            workspace: deps.workspace,
            executeTask: (subInput: TaskInput) => executeTask(subInput, deps),
            intentWorkflowPrompt: intentResolution.workflowPrompt,
            workflowConfig: deps.workflowConfig,
          });
          const trace: ExecutionTrace = {
            id: `trace-${input.id}-workflow`,
            taskId: input.id,
            workerId: 'workflow-executor',
            timestamp: Date.now(),
            routingLevel: 2,
            approach: 'agentic-workflow',
            oracleVerdicts: {},
            modelUsed: 'workflow-planner',
            tokensConsumed: workflowResult.totalTokensConsumed,
            durationMs: workflowResult.totalDurationMs,
            outcome: workflowResult.status === 'completed' ? 'success' : 'failure',
            affectedFiles: input.targetFiles ?? [],
          };
          await deps.traceCollector.record(trace);
          const result: TaskResult = {
            id: input.id,
            status: workflowResult.status === 'completed' ? 'completed' : 'failed',
            mutations: [],
            trace,
            answer: workflowResult.synthesizedOutput,
          };
          deps.bus?.emit('task:complete', { result });
          return result;
        } catch {
          // Workflow failed — fall back to legacy goal-rewrite path.
          // Only rewrite when confidence clears the threshold; below it the
          // LLM's paraphrase may drift from user intent, so we let downstream
          // phases plan from the raw goal instead.
          const AGENTIC_REWRITE_CONFIDENCE = 0.7;
          if (
            intentResolution.workflowPrompt &&
            intentResolution.confidence >= AGENTIC_REWRITE_CONFIDENCE
          ) {
            intentResolution.originalGoal = input.goal;
            input = { ...input, goal: intentResolution.workflowPrompt };
          }
        }
      }
    }
    // 'full-pipeline' or failed resolution → existing 6-phase loop

    let { understanding, routing } = prep;
    const { workingMemory, explorationFlag } = prep;

    // Agentic-workflow requires tool access (minimum L2) and generous latency for multi-step execution
    if (intentResolution?.strategy === 'agentic-workflow') {
      const AGENTIC_LATENCY_FLOOR = 120_000;
      if (routing.level < 2) {
        const { LEVEL_CONFIG } = await import('../gate/risk-router.ts');
        const l2 = LEVEL_CONFIG[2];
        routing = {
          ...routing,
          level: 2,
          model: routing.model ?? l2.model,
          budgetTokens: Math.max(routing.budgetTokens, l2.budgetTokens),
          latencyBudgetMs: Math.max(routing.latencyBudgetMs, AGENTIC_LATENCY_FLOOR),
        };
      } else {
        routing = {
          ...routing,
          latencyBudgetMs: Math.max(routing.latencyBudgetMs, AGENTIC_LATENCY_FLOOR),
        };
      }
      // Ensure wall-clock timeout fits at least one full agentic attempt
      if (input.budget.maxDurationMs < routing.latencyBudgetMs * 1.5) {
        input = {
          ...input,
          budget: { ...input.budget, maxDurationMs: Math.ceil(routing.latencyBudgetMs * 1.5) },
        };
      }
    }
    const startTime = Date.now();

    // Conversation Agent Mode: load conversation history if session context present
    // Uses compacted version for long sessions (A3: rule-based, no LLM in compaction path)
    let conversationHistory: import('./types.ts').ConversationEntry[] | undefined;
    if (input.sessionId && deps.sessionManager) {
      try {
        const historyBudget = Math.floor((routing.budgetTokens ?? 8000) * 0.25);
        conversationHistory = deps.sessionManager.getConversationHistoryCompacted(input.sessionId, historyBudget);
      } catch {
        // Non-fatal: proceed without conversation history
      }
    }

    deps.bus?.emit('task:start', { input, routing });

    // Crash Recovery: mark checkpoint complete/failed on task completion.
    // Agent Conversation: input-required is treated as completed from the
    // checkpoint's perspective — this turn's work is done; the agent just
    // asked the user for clarification before the next turn.
    const detachCheckpoint =
      deps.taskCheckpoint && deps.bus
        ? deps.bus.on('task:complete', ({ result }) => {
            if (result.id !== input.id) return;
            try {
              if (result.status === 'completed' || result.status === 'input-required') {
                deps.taskCheckpoint!.complete(result.id);
              } else {
                deps.taskCheckpoint!.fail(result.id, result.trace?.failureReason ?? result.status);
              }
            } catch {
              // Checkpoint update failure is non-fatal
            }
          })
        : undefined;

    let lastWorkerSelection: import('./types.ts').EngineSelectionResult | undefined;
    const BUDGET_CAP_MULTIPLIER = 6;
    let totalTokensConsumed = 0;
    const MAX_CONVERSATIONAL_LEVEL = 1 as RoutingLevel;

    // Wave 5.2: `ctx` is declared with `let` so the plan phase can hand
    // back an `enhancedInput` (with the DAG's preamble merged into
    // `constraints`) and the core-loop swaps `ctx.input` for subsequent
    // phases. The caller's original `input` is never mutated because the
    // enhanced variant is a shallow clone produced by phase-plan.
    // Multi-agent: resolve the specialist spec from input.agentId (set by intent resolver).
    const agentProfile = input.agentId ? deps.agentRegistry?.getAgent(input.agentId) ?? undefined : undefined;
    let ctx: PhaseContext = {
      input,
      deps,
      startTime,
      workingMemory,
      explorationFlag,
      conversationHistory,
      agentProfile,
    };

    // Outer loop: routing level escalation
    routingLoop: while (routing.level <= MAX_ROUTING_LEVEL) {
      let matchedSkill: CachedSkill | null = null;
      const deliberationBonusRetries = 0;

      // Inner loop: retry within current routing level
      for (let retry = 0; retry < input.budget.maxRetries + deliberationBonusRetries; retry++) {
        // ── Wall-clock timeout check ──────────────────────────────────
        if (Date.now() - startTime > input.budget.maxDurationMs) {
          const timeoutTrace: ExecutionTrace = {
            id: `trace-${input.id}-timeout`,
            taskId: input.id,
            workerId: routing.workerId ?? routing.model ?? 'unknown',
    agentId: input.agentId,
            timestamp: Date.now(),
            routingLevel: routing.level,
            approach: 'wall-clock-timeout',
            oracleVerdicts: {},
            modelUsed: routing.model ?? 'none',
            tokensConsumed: 0,
            durationMs: Date.now() - startTime,
            outcome: 'timeout',
            failureReason: `Wall-clock timeout exceeded: ${input.budget.maxDurationMs}ms`,
            affectedFiles: input.targetFiles ?? [],
            workerSelectionAudit: lastWorkerSelection,
          };
          await deps.traceCollector.record(timeoutTrace);
          deps.bus?.emit('trace:record', { trace: timeoutTrace });
          deps.bus?.emit('task:timeout', {
            taskId: input.id,
            elapsedMs: Date.now() - startTime,
            budgetMs: input.budget.maxDurationMs,
          });
          const timeoutResult: TaskResult = {
            id: input.id,
            status: 'failed',
            mutations: [],
            trace: timeoutTrace,
            // Surface a user-facing explanation so chat UIs don't render an
            // empty "(no response)" bubble. The trace carries the full detail;
            // this field is the TL;DR for clients that don't inspect traces.
            answer:
              `Task timed out after ${Math.round((Date.now() - startTime) / 1000)}s ` +
              `(budget: ${Math.round(input.budget.maxDurationMs / 1000)}s) at routing level L${routing.level}. ` +
              `Try narrowing the request, or raise --max-duration if the task legitimately needs more time.`,
          };
          deps.bus?.emit('task:complete', { result: timeoutResult });
          return timeoutResult;
        }

        // ── L0 Skill Shortcut (Phase 2.5) ──────────────────────────────
        // Phase 3: skill lookup is scoped by specialist agent. A ts-coder task
        // sees ts-coder's skills (+ legacy shared), never writer's private skills.
        if (deps.skillManager && routing.level <= 1) {
          const fp = (input.targetFiles ?? []).sort().join(',') || '*';
          const taskSig = `${input.goal.slice(0, 50)}::${fp}`;
          const skill = deps.skillManager.match(taskSig, input.agentId);
          if (skill) {
            const check = deps.skillManager.verify(skill);
            if (check.valid) {
              matchedSkill = skill;
              workingMemory.addHypothesis(`Proven approach: ${skill.approach}`, skill.successRate, 'cached-skill');
              deps.bus?.emit('skill:match', { taskId: input.id, skill });
            } else {
              deps.bus?.emit('skill:miss', { taskId: input.id, taskSignature: taskSig });
            }
          }
        }

        // ═══════════════════════════════════════════════════════════════
        // Step 1: PERCEIVE
        // ═══════════════════════════════════════════════════════════════
        const perceiveStart = Date.now();
        const perceiveResult = await executePerceivePhase(ctx, routing, understanding, totalTokensConsumed);
        deps.bus?.emit('phase:timing', {
          taskId: input.id,
          phase: 'perceive',
          durationMs: Date.now() - perceiveStart,
          routingLevel: routing.level,
        });
        const { perception } = perceiveResult.value;
        understanding = perceiveResult.value.understanding;

        // ═══════════════════════════════════════════════════════════════
        // Agent Conversation: Comprehension Gate (orchestrator-driven)
        // ═══════════════════════════════════════════════════════════════
        //
        // The Perceive phase has produced a fully enriched understanding
        // (Layer 0 + Layer 1 entity resolution + optional Layer 2 semantic
        // intent + Phase C claim verification). Before committing any
        // Predict/Plan/Generate budget, run a deterministic comprehension
        // check: if the goal is clearly ambiguous, pause and ask the user.
        //
        // This is the ORCHESTRATOR-driven path to `input-required`,
        // complementing the AGENT-driven path at Step 4 (where an agent
        // calls attempt_completion with needsUserInput=true). Both emit
        // the same TaskResult.status='input-required' shape and the same
        // agent:clarification_requested bus event (distinguished by a
        // `source` field on the payload).
        //
        // Closes the A1 gap flagged in concept.md §1.1 and
        // docs/design/agent-conversation.md: comprehension decisions
        // must not be made by the agent itself (that's LLM self-evaluation).
        //
        // Disabled by default via `COMPREHENSION_CHECK:off` constraint —
        // useful for tests that want to force the pipeline through to
        // Generate without the gate interfering.
        //
        // Axiom safety:
        //   - A1: checkComprehension is a pure function distinct from
        //     the generator; no LLM in the decision path.
        //   - A3: rule-based heuristics; reproducible from the same
        //     understanding.
        //   - A5: conservative — fires only on clearly ambiguous cases,
        //     never on a mere suspicion.
        //   - A6: asserts no mutations were committed (they can't be —
        //     Perceive has no mutation path) before returning.
        if (!isComprehensionCheckDisabled(input.constraints)) {
          const verdict = checkComprehension(understanding);
          if (!verdict.confident && verdict.questions.length > 0) {
            const comprehensionTrace: ExecutionTrace = {
              id: `trace-${input.id}-comprehension-pause`,
              taskId: input.id,
              sessionId: input.sessionId,
              workerId: 'orchestrator',
              timestamp: Date.now(),
              routingLevel: routing.level,
              approach: 'comprehension-pause',
              approachDescription: `Orchestrator detected ${verdict.failedChecks.length} comprehension issue(s) before generation: ${verdict.failedChecks.map((c) => c.check).join(', ')}`,
              oracleVerdicts: { comprehension: false },
              modelUsed: 'orchestrator',
              tokensConsumed: 0,
              durationMs: Date.now() - startTime,
              // Outcome is 'success' because the gate fired cleanly —
              // the orchestrator decided to pause, not fail. Mirrors the
              // existing input-required-pause branch semantics.
              outcome: 'success',
              affectedFiles: input.targetFiles ?? [],
              workerSelectionAudit: lastWorkerSelection,
            };
            await deps.traceCollector.record(comprehensionTrace);
            deps.bus?.emit('trace:record', { trace: comprehensionTrace });

            const { liftStringsToStructured } = await import('../core/clarification.ts');
            deps.bus?.emit('agent:clarification_requested', {
              taskId: input.id,
              sessionId: input.sessionId,
              questions: [...verdict.questions],
              structuredQuestions: liftStringsToStructured([...verdict.questions]),
              routingLevel: routing.level,
              source: 'orchestrator',
            });

            const comprehensionResult: TaskResult = {
              id: input.id,
              status: 'input-required',
              mutations: [],
              trace: comprehensionTrace,
              clarificationNeeded: [...verdict.questions],
            };
            deps.bus?.emit('task:complete', { result: comprehensionResult });
            return comprehensionResult;
          }
        }

        // ═══════════════════════════════════════════════════════════════
        // Step 2: PREDICT + SELECT WORKER
        // ═══════════════════════════════════════════════════════════════
        const predictStart = Date.now();
        const predictOutcome = await executePredictPhase(ctx, routing, perception, understanding);
        deps.bus?.emit('phase:timing', {
          taskId: input.id,
          phase: 'predict',
          durationMs: Date.now() - predictStart,
          routingLevel: routing.level,
        });
        if (predictOutcome.action === 'return') return predictOutcome.result;
        const { prediction, predictionConfidence, metaPredictionConfidence, forwardPrediction, workerSelection } =
          predictOutcome.value;
        routing = predictOutcome.value.routing;
        if (workerSelection) lastWorkerSelection = workerSelection;

        // ═══════════════════════════════════════════════════════════════
        // Step 3: PLAN
        // ═══════════════════════════════════════════════════════════════
        const planStart = Date.now();
        const planOutcome = await executePlanPhase(ctx, routing, perception, understanding, forwardPrediction);
        deps.bus?.emit('phase:timing', {
          taskId: input.id,
          phase: 'plan',
          durationMs: Date.now() - planStart,
          routingLevel: routing.level,
        });
        if (planOutcome.action === 'return') return planOutcome.result;
        const { plan, enhancedInput } = planOutcome.value;

        // Wave 5.2: if the plan phase produced an enhanced input (e.g.
        // research-swarm preset attached a report-contract preamble),
        // rebuild the phase context so subsequent phases see the merged
        // constraints. This replaces the earlier in-place mutation of
        // `input.constraints` inside the decomposer (Phase A §7 seam #2).
        //
        // We ALSO reassign the outer `input` binding so any downstream
        // code inside this function that still references `input` directly
        // (instead of `ctx.input`) sees the enhanced view. This prevents
        // a future "silently reads stale constraints" footgun where a
        // new check added after plan phase might accidentally bypass
        // the preamble merge. Reassignment is local — the caller's
        // original TaskInput is not affected because JS function
        // parameters bind a local reference that can be reassigned
        // without mutating the caller's variable.
        if (enhancedInput) {
          ctx = { ...ctx, input: enhancedInput };
          input = enhancedInput;
        }

        // ═══════════════════════════════════════════════════════════════
        // Step 4: GENERATE
        // ═══════════════════════════════════════════════════════════════
        const generateStart = Date.now();
        const generateOutcome = await executeGeneratePhase(ctx, {
          routing,
          perception,
          understanding,
          plan,
          totalTokensConsumed,
          budgetCapMultiplier: BUDGET_CAP_MULTIPLIER,
          workerSelection,
          lastWorkerSelection,
          retry,
        });
        if (generateOutcome.action === 'return') return generateOutcome.result;
        if (generateOutcome.action === 'retry') continue;
        if (generateOutcome.action === 'throw') throw generateOutcome.error;
        deps.bus?.emit('phase:timing', {
          taskId: input.id,
          phase: 'generate',
          durationMs: Date.now() - generateStart,
          routingLevel: routing.level,
        });
        const { workerResult, isAgenticResult, lastAgentResult, dagResult, mutatingToolCalls, roomId } = generateOutcome.value;
        totalTokensConsumed = generateOutcome.value.totalTokensConsumed;

        // ═══════════════════════════════════════════════════════════════
        // Agent Conversation: input-required short-circuit
        // ═══════════════════════════════════════════════════════════════
        //
        // When the agent calls attempt_completion with needsUserInput=true,
        // its `uncertainties` are phrased as questions to the user. This is
        // a collaborative pause, not a failure — do NOT run verify, do NOT
        // retry, do NOT escalate. Build an input-required TaskResult and
        // return immediately. The calling layer (CLI chat, API client) is
        // responsible for surfacing the questions and submitting the next
        // user turn.
        //
        // Axiom safety:
        //  - A1 (Epistemic Separation): no verification is needed because
        //    no mutations were committed (asserted below) and no claims are
        //    being accepted — we're just passing the agent's questions up.
        //  - A6 (Zero-Trust Execution): defense-in-depth — if mutations are
        //    somehow present, fall through to the normal verify path.
        if (isAgenticResult && lastAgentResult?.needsUserInput === true && workerResult.mutations.length === 0) {
          const inputRequiredTrace: ExecutionTrace = {
            id: `trace-${input.id}-input-required`,
            taskId: input.id,
            sessionId: input.sessionId,
            workerId: routing.workerId ?? routing.model ?? 'unknown',
    agentId: input.agentId,
            timestamp: Date.now(),
            routingLevel: routing.level,
            approach: 'input-required-pause',
            approachDescription: 'Agent requested clarification from the user',
            oracleVerdicts: {},
            modelUsed: routing.model ?? 'none',
            tokensConsumed: workerResult.tokensConsumed,
            durationMs: Date.now() - startTime,
            // Outcome is 'success' because the current turn completed cleanly —
            // the agent explicitly decided to pause and ask rather than fail.
            // ExecutionTrace.outcome does not yet have a dedicated 'input-required'
            // value; when it is extended, this mapping should change.
            outcome: 'success',
            affectedFiles: input.targetFiles ?? [],
            workerSelectionAudit: lastWorkerSelection,
          };
          await deps.traceCollector.record(inputRequiredTrace);
          deps.bus?.emit('trace:record', { trace: inputRequiredTrace });

          // Agent Conversation: emit a dedicated observability event so
          // listeners (TUI, API clients, logging) can surface the questions
          // as a user-friendly prompt instead of waiting for the generic
          // task:complete handler to interpret status='input-required'.
          // `source: 'agent'` distinguishes this from the orchestrator-driven
          // comprehension gate emit site earlier in the pipeline.
          const { liftStringsToStructured: liftAgentQuestions } = await import('../core/clarification.ts');
          deps.bus?.emit('agent:clarification_requested', {
            taskId: input.id,
            sessionId: input.sessionId,
            questions: [...lastAgentResult.uncertainties],
            structuredQuestions: liftAgentQuestions([...lastAgentResult.uncertainties]),
            routingLevel: routing.level,
            source: 'agent',
          });

          const inputRequiredResult: TaskResult = {
            id: input.id,
            status: 'input-required',
            mutations: [],
            trace: inputRequiredTrace,
            clarificationNeeded: [...lastAgentResult.uncertainties],
            // Preserve any proposedContent (e.g., partial summary) so the
            // user sees context alongside the questions.
            ...(lastAgentResult.proposedContent ? { answer: lastAgentResult.proposedContent } : {}),
          };
          deps.bus?.emit('task:complete', { result: inputRequiredResult });
          return inputRequiredResult;
        }

        // ═══════════════════════════════════════════════════════════════
        // Step 5: VERIFY
        // ═══════════════════════════════════════════════════════════════
        const verifyStart = Date.now();
        const verifyOutcome = await executeVerifyPhase(ctx, {
          routing,
          perception,
          understanding,
          plan,
          workerResult,
          isAgenticResult,
          lastAgentResult,
          dagResult,
          prediction,
          predictionConfidence,
          metaPredictionConfidence,
          forwardPrediction,
          workerSelection,
          lastWorkerSelection,
          matchedSkill,
          retry,
          roomId,
        });
        if (verifyOutcome.action === 'return') return verifyOutcome.result;
        if (verifyOutcome.action === 'escalate') {
          routing = verifyOutcome.routing;
          continue routingLoop;
        }
        deps.bus?.emit('phase:timing', {
          taskId: input.id,
          phase: 'verify',
          durationMs: Date.now() - verifyStart,
          routingLevel: routing.level,
        });
        const {
          verification,
          passedOracles,
          failedOracles,
          verificationConfidence,
          qualityScore,
          shouldCommit,
          trace,
        } = verifyOutcome.value;

        // ═══════════════════════════════════════════════════════════════
        // Step 6: LEARN
        // ═══════════════════════════════════════════════════════════════
        const learnResult = await executeLearnPhase(ctx, {
          routing,
          understanding,
          prediction,
          forwardPrediction,
          verification,
          trace,
          isAgenticResult,
          lastAgentResult,
        });
        const finalTrace = learnResult.trace;

        // shouldCommit=false from verify means confidence decision wants retry
        if (!shouldCommit) continue;

        // ═══════════════════════════════════════════════════════════════
        // SUCCESS PATH — critic, test gen, commit, shadow
        // ═══════════════════════════════════════════════════════════════
        if (shouldCommit || finalTrace.outcome === 'success') {
          // ── WP-2: LLM-as-Critic (semantic verification at L2+) ──
          if (deps.criticEngine && routing.level >= 2 && workerResult.mutations.length > 0) {
            try {
              const proposal = { mutations: workerResult.mutations, approach: finalTrace.approach };
              // Book-integration Wave 5.1: routing signal is now threaded
              // through a typed `CriticContext` argument rather than the
              // earlier `(task as unknown as { riskScore? }).riskScore` cast.
              // DebateRouterCritic reads `context.riskScore` directly; the
              // baseline critic and the 3-seat debate both accept-and-ignore.
              const criticContext = {
                riskScore: routing.riskScore,
                routingLevel: routing.level,
              };
              const criticResult = await deps.criticEngine.review(
                proposal,
                input,
                perception,
                input.acceptanceCriteria,
                criticContext,
              );
              deps.bus?.emit('critic:verdict', {
                taskId: input.id,
                accepted: criticResult.approved,
                confidence: criticResult.confidence,
                reason: criticResult.reason,
              });
              if (!criticResult.approved) {
                workingMemory.recordFailedApproach(
                  finalTrace.approach,
                  `critic: ${criticResult.reason ?? 'Critic rejected proposal'}`,
                  criticResult.confidence,
                  'critic',
                );
                continue;
              }

              // EHD Phase 2: Recompute pipeline confidence WITH critic dimension
              if (criticResult.confidence !== undefined && routing.level > 0) {
                const { computePipelineConfidence, deriveConfidenceDecision } = await import(
                  './pipeline-confidence.ts'
                );
                const updatedPipeline = computePipelineConfidence({
                  prediction: predictionConfidence,
                  metaPrediction: metaPredictionConfidence,
                  verification: verificationConfidence,
                  critic: criticResult.confidence,
                });
                const updatedDecision = deriveConfidenceDecision(updatedPipeline.composite);
                finalTrace.confidenceDecision = {
                  action: updatedDecision,
                  confidence: updatedPipeline.composite,
                  reason: updatedPipeline.formula,
                };
                finalTrace.pipelineConfidence = {
                  composite: updatedPipeline.composite,
                  formula: updatedPipeline.formula,
                };
              }
            } catch (criticError) {
              deps.bus?.emit('critic:verdict', {
                taskId: input.id,
                accepted: false,
                confidence: 0,
                reason: `Critic engine error: ${criticError instanceof Error ? criticError.message : String(criticError)}`,
              });
              workingMemory.recordFailedApproach(
                finalTrace.approach,
                `critic-error: ${criticError instanceof Error ? criticError.message : String(criticError)}`,
                0,
                'critic',
              );
              continue;
            }
          }

          // ── WP-3: TestGenerator (L2+) ──
          if (deps.testGenerator && routing.level >= 2 && workerResult.mutations.length > 0) {
            try {
              const testGenResult = await deps.testGenerator.generateAndRun(
                { mutations: workerResult.mutations, approach: finalTrace.approach },
                perception,
              );
              if (testGenResult.failures.length > 0) {
                const failNames = testGenResult.failures.map((f) => f.name).join(', ');
                workingMemory.recordFailedApproach(
                  finalTrace.approach,
                  `test-gen: ${testGenResult.failures.length} generated test(s) failed: ${failNames}`,
                  undefined,
                  'test-gen',
                );
                continue;
              }
            } catch (testGenError) {
              deps.bus?.emit('testgen:error', {
                taskId: input.id,
                error: testGenError instanceof Error ? testGenError.message : String(testGenError),
              });
            }
          }

          // ── Execute mutating tools ONLY after verification ──
          if (verification.passed && deps.toolExecutor && mutatingToolCalls.length > 0) {
            const toolContext = {
              workspace: deps.workspace ?? process.cwd(),
              allowedPaths: input.targetFiles ?? [],
              routingLevel: routing.level,
            } as import('./tools/tool-interface.ts').ToolContext;
            const mutatingResults = await deps.toolExecutor.executeProposedTools(mutatingToolCalls, toolContext);
            deps.bus?.emit('tools:executed', { taskId: input.id, results: mutatingResults });
            for (const tr of mutatingResults) {
              if (tr.status === 'success' && tr.output && typeof tr.output === 'object') {
                const out = tr.output as { file?: string; content?: string };
                if (out.file && out.content) {
                  const existing = workerResult.mutations.find((m) => m.file === out.file);
                  if (!existing) {
                    workerResult.mutations.push({
                      file: out.file,
                      content: out.content,
                      diff: '',
                      explanation: `Tool ${tr.tool} output`,
                    });
                  }
                }
              }
            }
          }

          // ── I10: Probation workers — shadow only ──
          if (deps.workerStore && routing.workerId) {
            const workerProfile = deps.workerStore.findById(routing.workerId);
            if (workerProfile?.status === 'probation') {
              if (deps.shadowRunner) {
                const job = deps.shadowRunner.enqueue(
                  input.id,
                  workerResult.mutations.map((m) => ({ file: m.file, content: m.content })),
                );
                deps.bus?.emit('shadow:enqueue', { job });
                if (deps.workerLifecycle?.shouldShadowForProbation(input.id, routing.workerId!)) {
                  deps.shadowRunner
                    .runAlternativeWorker(
                      input.id,
                      workerResult.mutations.map((m) => ({ file: m.file, content: m.content })),
                      routing.workerId!,
                    )
                    .then((result) => {
                      deps.bus?.emit('shadow:complete', {
                        job: {
                          id: '',
                          taskId: input.id,
                          status: 'done' as const,
                          enqueuedAt: 0,
                          retryCount: 0,
                          maxRetries: 1,
                        },
                        result,
                      });
                    })
                    .catch(() => {
                      /* fire-and-forget */
                    });
                }
              }
              const probationResult: TaskResult = {
                id: input.id,
                status: 'completed',
                mutations: [],
                trace: { ...finalTrace, outcome: 'success' as const },
                notes: ['probation-shadow-only: I10 — probation worker result not committed'],
              };
              deps.bus?.emit('task:complete', { result: probationResult });
              return probationResult;
            }
          }

          // ── Commit verified mutations to workspace ──
          let commitResult: { applied: string[]; rejected: Array<{ path: string; reason: string }> } | undefined;
          if (deps.workspace && workerResult.mutations.length > 0) {
            commitResult = commitArtifacts(
              deps.workspace,
              workerResult.mutations.map((m) => ({ path: m.file, content: m.content })),
            );
            if (commitResult.rejected.length > 0) {
              deps.bus?.emit('commit:rejected', { taskId: input.id, rejected: commitResult.rejected });
            }
          }

          // ── A4: Commit verified oracle verdicts as World Graph facts ──
          if (deps.worldGraph && deps.workspace && commitResult && commitResult.applied.length > 0) {
            const validUntils = Object.values(verification.verdicts)
              .filter((v) => v.temporalContext?.validUntil)
              .map((v) => v.temporalContext!.validUntil);
            const factValidUntil = validUntils.length > 0 ? Math.min(...validUntils) : undefined;
            const decayModels = Object.values(verification.verdicts)
              .map((v) => v.temporalContext?.decayModel)
              .filter(Boolean) as string[];
            const factDecayModel =
              decayModels.length > 0
                ? decayModels.includes('exponential')
                  ? ('exponential' as const)
                  : (decayModels[0] as 'linear' | 'step' | 'none' | 'exponential')
                : undefined;
            try {
              for (const file of commitResult.applied) {
                const absPath = resolvePath(deps.workspace, file);
                const hash = deps.worldGraph.computeFileHash(absPath);
                deps.worldGraph.storeFact({
                  target: file,
                  pattern: 'oracle-verified',
                  evidence: Object.entries(verification.verdicts).map(([oracle, v]) => ({
                    file,
                    line: 0,
                    snippet: `${oracle}: ${v.verified ? 'pass' : 'fail'}`,
                  })),
                  oracleName: 'orchestrator',
                  sourceFile: file,
                  fileHash: hash,
                  verifiedAt: Date.now(),
                  sessionId: input.id,
                  confidence: computeFactConfidence(verification.verdicts),
                  validUntil: factValidUntil,
                  decayModel: factDecayModel,
                  tierReliability: (() => {
                    const conf = computeFactConfidence(verification.verdicts);
                    return conf >= 0.95 ? 1.0 : conf >= 0.7 ? 0.8 : 0.5;
                  })(),
                });
              }
            } catch {
              // WorldGraph fact commitment is best-effort
            }
          }

          const appliedSet = commitResult
            ? new Set(commitResult.applied)
            : new Set(workerResult.mutations.map((m) => m.file));
          const appliedMutations = workerResult.mutations.filter((m) => appliedSet.has(m.file));
          const allRejected = commitResult && commitResult.applied.length === 0 && commitResult.rejected.length > 0;

          const contradictions =
            passedOracles.length > 0 && failedOracles.length > 0
              ? [`Oracle contradiction: passed=[${passedOracles.join(',')}] failed=[${failedOracles.join(',')}]`]
              : undefined;

          const successResult: TaskResult = {
            id: input.id,
            status: allRejected ? 'failed' : 'completed',
            mutations: appliedMutations.map((m) => ({
              file: m.file,
              diff: m.diff,
              oracleVerdicts: verification.verdicts,
            })),
            trace: finalTrace,
            qualityScore,
            answer: workerResult.proposedContent,
            thinking: workerResult.thinking,
            notes: commitResult?.rejected.length
              ? [`Rejected files: ${commitResult.rejected.map((r) => `${r.path} (${r.reason})`).join(', ')}`]
              : undefined,
            contradictions,
            plan,
          };

          // ── Shadow Enqueue (Phase 2.2) ──
          if (deps.shadowRunner && routing.level >= 2) {
            const job = deps.shadowRunner.enqueue(
              input.id,
              workerResult.mutations.map((m) => ({ file: m.file, content: m.content })),
            );
            finalTrace.validationDepth = 'structural';
            deps.bus?.emit('shadow:enqueue', { job });
            deps.shadowRunner
              .processNext()
              .then((result) => {
                if (result) deps.bus?.emit('shadow:complete', { job, result });
              })
              .catch((err) => {
                deps.bus?.emit('shadow:failed', { job, error: String(err) });
              });
          }

          // ── Skill outcome: success ──
          if (matchedSkill && deps.skillManager) {
            deps.skillManager.recordOutcome(matchedSkill, true);
            deps.bus?.emit('skill:outcome', { taskId: input.id, skill: matchedSkill, success: true });
          }

          serializeApproachesToStore(workingMemory, input, deps);
          persistSessionMemory(workingMemory, input, deps);
          deps.bus?.emit('task:complete', { result: successResult });
          detachCheckpoint?.();
          return successResult;
        }

        // ── FAILURE → record in working memory, retry ────────────────
        workingMemory.recordFailedApproach(
          finalTrace.approach,
          verification.reason ?? 'unknown',
          verificationConfidence,
          failedOracles[0],
        );

        // G5: Archive failed verdicts to World Graph
        if (deps.worldGraph && failedOracles.length > 0) {
          try {
            for (const oracleName of failedOracles) {
              deps.worldGraph.storeFailedVerdict({
                target: input.targetFiles?.[0] ?? input.id,
                pattern: finalTrace.approach,
                oracleName,
                verdict: verification.reason ?? 'unknown',
                confidence: verificationConfidence,
                fileHash: undefined,
                sessionId: undefined,
              });
            }
          } catch {
            // Best-effort
          }
        }

        for (const oracleName of failedOracles) {
          deps.bus?.emit('context:verdict_omitted', {
            taskId: input.id,
            oracleName,
            reason: 'Oracle verdict available but not propagated to worker context on retry',
          });
        }

        if (matchedSkill && deps.skillManager) {
          deps.skillManager.recordOutcome(matchedSkill, false);
          deps.bus?.emit('skill:outcome', { taskId: input.id, skill: matchedSkill, success: false });
          matchedSkill = null;
        }
      }

      // ── RETRY EXHAUSTED → escalate routing level ─────────────────
      const nextLevel = (routing.level + 1) as RoutingLevel;
      const effectiveMaxLevel =
        understanding.taskDomain === 'conversational' ? MAX_CONVERSATIONAL_LEVEL : MAX_ROUTING_LEVEL;
      if (nextLevel > effectiveMaxLevel) break;

      deps.bus?.emit('task:escalate', {
        taskId: input.id,
        fromLevel: routing.level,
        toLevel: nextLevel,
        reason: `Exhausted ${input.budget.maxRetries} retries at L${routing.level}`,
      });
      routing = await deps.riskRouter.assessInitialLevel({
        ...input,
        constraints: [...(input.constraints ?? []), `MIN_ROUTING_LEVEL:${nextLevel}`],
      });
      routing = { ...routing, isEscalated: true };
    }

    // ── ALL LEVELS EXHAUSTED → escalate to human ───────────────────
    const escalationTrace: ExecutionTrace = {
      id: `trace-${input.id}-escalation`,
      taskId: input.id,
      workerId: routing.workerId ?? routing.model ?? 'unknown',
    agentId: input.agentId,
      timestamp: Date.now(),
      routingLevel: MAX_ROUTING_LEVEL,
      approach: 'all-levels-exhausted',
      oracleVerdicts: {},
      modelUsed: routing.model ?? 'none',
      tokensConsumed: 0,
      durationMs: Date.now() - startTime,
      outcome: 'escalated',
      failureReason: `Failed after ${workingMemory.getSnapshot().failedApproaches.length} attempts across all routing levels`,
      affectedFiles: input.targetFiles ?? [],
      workerSelectionAudit: lastWorkerSelection,
      failedApproaches: workingMemory.getSnapshot().failedApproaches.map((fa) => ({
        approach: fa.approach,
        oracleVerdict: fa.oracleVerdict,
        verdictConfidence: fa.verdictConfidence,
        failureOracle: fa.failureOracle,
      })),
    };

    serializeApproachesToStore(workingMemory, input, deps);
    await deps.traceCollector.record(escalationTrace);
    deps.bus?.emit('trace:record', { trace: escalationTrace });

    const escalationResult: TaskResult = {
      id: input.id,
      status: 'escalated',
      mutations: [],
      trace: escalationTrace,
      escalationReason: `Task could not be completed after exhausting all routing levels (L0-L3). ${workingMemory.getSnapshot().failedApproaches.length} failed approaches recorded.`,
    };
    deps.bus?.emit('task:complete', { result: escalationResult });
    persistSessionMemory(workingMemory, input, deps);
    detachCheckpoint?.();
    return escalationResult;
  } finally {
    // Deep-audit #4 (2026-04-15): fire the criticEngine.clearTask hook
    // on every exit path so DebateRouterCritic releases its per-task
    // budget counter. Best-effort — a throwing clearTask must not
    // overwrite the task's actual return value or mask a thrown
    // error from the main path. Optional-chain lets critics without
    // per-task state opt out.
    try {
      deps.criticEngine?.clearTask?.(finalizedTaskId);
    } catch {
      /* hook errors are swallowed — cleanup must not fail the task */
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function serializeApproachesToStore(workingMemory: WorkingMemory, input: TaskInput, deps: OrchestratorDeps): void {
  if (!deps.rejectedApproachStore) return;
  const snapshot = workingMemory.getSnapshot();
  for (const entry of snapshot.failedApproaches) {
    try {
      deps.rejectedApproachStore.store({
        taskId: input.id,
        taskType: input.taskType,
        fileTarget: input.targetFiles?.[0],
        approach: entry.approach,
        oracleVerdict: entry.oracleVerdict,
        verdictConfidence: entry.verdictConfidence,
        failureOracle: entry.failureOracle,
        source: 'task-end',
      });
    } catch {
      // Best-effort
    }
  }
}

/** Persist working memory snapshot to session store for cross-turn learning. */
function persistSessionMemory(workingMemory: WorkingMemory, input: TaskInput, deps: OrchestratorDeps): void {
  if (!input.sessionId || !deps.sessionManager) return;
  try {
    const snapshot = workingMemory.getSnapshot();
    deps.sessionManager.saveSessionWorkingMemory(input.sessionId, JSON.stringify(snapshot));
  } catch {
    // Session memory persistence is best-effort
  }
}

function computeFactConfidence(allVerdicts: Record<string, import('../core/types.ts').OracleVerdict>): number {
  const passingConfidences = Object.values(allVerdicts)
    .filter((v) => v.verified)
    .map((v) => v.confidence);
  if (passingConfidences.length === 0) return 0;
  return Math.min(...passingConfidences);
}

// ---------------------------------------------------------------------------
// K2.3: Batch execution — dispatch multiple tasks concurrently
// ---------------------------------------------------------------------------

/**
 * Execute multiple tasks concurrently using the concurrent dispatcher.
 * Falls back to sequential execution if no concurrent dispatcher is configured.
 */
export async function executeTaskBatch(tasks: TaskInput[], deps: OrchestratorDeps): Promise<TaskResult[]> {
  if (deps.concurrentDispatcher) {
    return deps.concurrentDispatcher.dispatch(tasks);
  }
  // Fallback: sequential execution
  const results: TaskResult[] = [];
  for (const task of tasks) {
    results.push(await executeTask(task, deps));
  }
  return results;
}
