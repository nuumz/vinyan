/**
 * Orchestrator Core Loop — the central nervous system of Vinyan Phase 1.
 *
 * 6-step lifecycle: Perceive → Predict → Plan → Generate → Verify → Learn
 * Nested loops: outer = routing level escalation, inner = retry within level.
 *
 * Source of truth: spec/tdd.md §16.2
 * Axioms: A3 (deterministic governance), A6 (zero-trust execution)
 *
 * STATUS: Phase 1 complete — all dependencies implemented (CalibratedSelfModel,
 * TaskDecomposerImpl, WorkerPoolImpl, OracleGateAdapter, TraceCollectorImpl).
 */

import { resolve as resolvePath } from 'node:path';
import type { VinyanBus } from '../core/bus.ts';
import { validateInput } from '../guardrails/index.ts';
import { buildComplexityContext, computeQualityScore } from '../gate/quality-score.ts';
import { applyPredictionEscalation, LEVEL_CONFIG } from '../gate/risk-router.ts';
import { createContract } from '../core/agent-contract.ts';
import { type DAGExecutionResult, executeDAG, type NodeDispatcher } from './dag-executor.ts';
import { type ConfidenceDecision, computePipelineConfidence, deriveConfidenceDecision } from './pipeline-confidence.ts';
import type {
  CachedSkill,
  ExecutionTrace,
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
  ToolCall,
  VerificationHint,
  WorkingMemoryState,
} from './types.ts';
import { commitArtifacts } from './worker/artifact-commit.ts';
import { classifyAllFailures } from './failure-classifier.ts';
import { WorkingMemory } from './working-memory.ts';

// ---------------------------------------------------------------------------
// Dependency interfaces (injected — each implemented in its own module)
// ---------------------------------------------------------------------------

export interface PerceptionAssembler {
  assemble(input: TaskInput, level: RoutingLevel, understanding?: import('./types.ts').TaskUnderstanding): Promise<PerceptualHierarchy>;
}

export interface RiskRouter {
  assessInitialLevel(input: TaskInput): Promise<RoutingDecision>;
}

export interface SelfModel {
  predict(input: TaskInput, perception: PerceptualHierarchy): Promise<SelfModelPrediction>;
  calibrate?(prediction: SelfModelPrediction, trace: ExecutionTrace, engineCertaintyMap?: Record<string, number>): PredictionError | undefined;
  /** EO #6: Get Self-Model calibrated reasoning budget policy for a task type. */
  getReasoningPolicy?(taskTypeSignature: string): ReasoningPolicy;
  /** STU Phase D: Access per-task-type params for enriched signature computation. */
  getTaskTypeParams?(sig: string): { observationCount: number } | undefined;
}

export interface TaskDecomposer {
  decompose(input: TaskInput, perception: PerceptualHierarchy, memory: WorkingMemoryState): Promise<TaskDAG>;
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
  ): Promise<WorkerResult>;
  /** Returns agent loop deps if configured (Phase 6.3+), null otherwise. */
  getAgentLoopDeps?(): import('./worker/agent-loop.ts').AgentLoopDeps | null;
}

export interface OracleGate {
  verify(
    mutations: Array<{ file: string; content: string }>,
    workspace: string,
    verificationHint?: import('./types.ts').VerificationHint,
  ): Promise<VerificationResult>;
}

export interface TraceCollector {
  record(trace: ExecutionTrace): Promise<void>;
  /** Optional: returns total trace count for data-gated features. */
  getTraceCount?(): number;
}

// ---------------------------------------------------------------------------
// Internal result types
// ---------------------------------------------------------------------------

interface WorkerResult {
  mutations: Array<{
    file: string;
    content: string;
    diff: string;
    explanation: string;
  }>;
  proposedToolCalls: ToolCall[];
  uncertainties?: string[];
  tokensConsumed: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  /** Extensible Thinking: thinking tokens used (from LLM response). */
  thinkingTokensUsed?: number;
  /** Raw thinking content from the LLM. */
  thinking?: string;
  durationMs: number;
  proposedContent?: string;
  /** When set, indicates a permanent error — skip retries and escalation. */
  nonRetryableError?: string;
}

interface VerificationResult {
  passed: boolean;
  verdicts: Record<string, import('../core/types.ts').OracleVerdict>;
  reason?: string;
  epistemicDecision?: import('../gate/epistemic-decision.ts').EpistemicGateDecision;
  aggregateConfidence?: number;
  caveats?: string[];
}

// ---------------------------------------------------------------------------
// Orchestrator
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
  workerSelector?: import('./worker-selector.ts').WorkerSelector;
  workerStore?: import('../db/worker-store.ts').WorkerStore;
  workerLifecycle?: import('./worker-lifecycle.ts').WorkerLifecycle;
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
  thinkingPolicyCompiler?: import('./thinking-policy.ts').ThinkingPolicyCompiler;
  /** G2+G5: RejectedApproachStore — persists failed approaches for cross-task learning. */
  rejectedApproachStore?: import('../db/rejected-approach-store.ts').RejectedApproachStore;
  /** STU: TraceStore for historical profiler in enrichUnderstanding(). */
  traceStore?: import('../db/trace-store.ts').TraceStore;
  /** STU Layer 2: Understanding engine for semantic intent extraction. */
  understandingEngine?: import('./understanding-engine.ts').UnderstandingEngine;
  /** K2: Provider trust store for recording per-provider success/failure outcomes. */
  providerTrustStore?: import('../db/provider-trust-store.ts').ProviderTrustStore;
}

const MAX_ROUTING_LEVEL: RoutingLevel = 3;

/** Build retry context from an agentic session result (Phase 6.3). */
function buildAgentSessionSummary(
  result: import('./worker/agent-loop.ts').WorkerLoopResult,
  attempt: number,
  outcome: 'uncertain' | 'oracle_failed',
): import('./types.ts').AgentSessionSummary {
  return {
    sessionId: `session-${Date.now()}`,
    attempt,
    outcome,
    filesRead: result.mutations.filter((m) => m.content !== null).map((m) => m.file),
    filesWritten: result.mutations.filter((m) => m.content !== null).map((m) => m.file),
    turnsCompleted: result.transcript.length,
    tokensConsumed: result.tokensConsumed,
    failurePoint: result.uncertainties[0] ?? 'unknown',
    lastIntent: result.transcript[result.transcript.length - 1]?.type ?? 'unknown',
    uncertainties: result.uncertainties,
  };
}

/**
 * Map ExecutionTrace outcome to ForwardPredictor PredictionOutcome.
 * Only records outcomes that reflect test results; skips infrastructure failures.
 */
function mapTraceToFPOutcome(
  predictionId: string,
  trace: ExecutionTrace,
): import('./forward-predictor-types.ts').PredictionOutcome | undefined {
  let testResult: 'pass' | 'partial' | 'fail';
  switch (trace.outcome) {
    case 'success':
      testResult = 'pass';
      break;
    case 'failure': {
      const verdicts = Object.values(trace.oracleVerdicts ?? {});
      const failCount = verdicts.filter((v) => !v).length;
      const failRate = verdicts.length === 0 ? 1.0 : failCount / verdicts.length;
      if (failRate >= 0.8) testResult = 'fail';
      else if (failRate >= 0.2) testResult = 'partial';
      else testResult = 'pass';
      break;
    }
    case 'timeout':
      return undefined; // Infrastructure issue — skip
    case 'escalated':
      if (trace.shadowValidation) {
        testResult = trace.shadowValidation.testsPassed ? 'pass' : 'fail';
      } else {
        return undefined; // No shadow validation — skip
      }
      break;
    default:
      return undefined;
  }
  return {
    predictionId,
    actualTestResult: testResult,
    actualBlastRadius: trace.affectedFiles?.length ?? 0,
    actualQuality: trace.qualityScore?.composite ?? 0.5,
    actualDuration: trace.durationMs,
    affectedFiles: trace.affectedFiles,
  };
}

/**
 * Confidence-weighted merge of SelfModel and ForwardPredictor predictions.
 * w_fp = forwardPrediction.confidence, w_sm = 1 - fp.confidence.
 * Pure function — returns merged pPass.
 */
export function mergeForwardAndSelfModel(
  selfModelPrediction: SelfModelPrediction,
  forwardPrediction: import('./forward-predictor-types.ts').OutcomePrediction,
): number {
  const wFp = forwardPrediction.confidence;
  const wSm = 1 - wFp;
  const smPPass = selfModelPrediction.pPass ?? 0.5;
  const fpPPass = forwardPrediction.testOutcome.pPass;
  return wFp * fpPPass + wSm * smPPass;
}

/**
 * Score plan nodes by causal risk and reorder for fail-fast execution.
 * Mutates plan.nodes order. Nodes with highest risk execute first.
 */
export function scorePlanByPrediction(
  plan: TaskDAG,
  forwardPrediction: import('./forward-predictor-types.ts').OutcomePrediction,
): void {
  if (!forwardPrediction.causalRiskFiles.length) return;
  for (const node of plan.nodes) {
    const matchingRisks = forwardPrediction.causalRiskFiles.filter((r) => node.targetFiles.includes(r.filePath));
    node.riskScore = matchingRisks.reduce((sum, r) => sum + r.breakProbability, 0);
  }
  // Sort: highest risk first → fail fast
  plan.nodes.sort((a, b) => (b.riskScore ?? 0) - (a.riskScore ?? 0));
}

/**
 * Execute a task through the full Orchestrator lifecycle.
 *
 * Outer loop: escalate routing level on repeated failure (L0 → L1 → L2 → L3 → human)
 * Inner loop: retry within routing level (up to budget.maxRetries)
 *
 * This is the single function that transforms Vinyan from a verification library
 * into an autonomous agent. Everything flows through here.
 */
export async function executeTask(input: TaskInput, deps: OrchestratorDeps): Promise<TaskResult> {
  // ── K1.5: Input validation gate — reject prompt injection before any LLM call ──
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
    return {
      id: input.id,
      status: 'failed',
      mutations: [],
      trace: securityTrace,
    };
  }

  // STU: Build SemanticTaskUnderstanding (Layer 0+1) once at ingestion — single source of truth
  const { enrichUnderstanding, enrichWithPerception } = await import('./task-understanding.ts');
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

  // G2: Wire archiver to persist evicted approaches to rejected_approaches table
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
          actionVerb: understanding.actionVerb, // Gap 6B: persist verb for cross-task learning
        });
      }
    : undefined;
  const workingMemory = new WorkingMemory({ bus: deps.bus, taskId: input.id, archiver });
  const startTime = Date.now();

  // Cross-task learning: load prior failed approaches from rejected_approaches table
  if (deps.rejectedApproachStore && input.targetFiles?.length) {
    try {
      const { loadPriorFailedApproaches } = await import('./cross-task-loader.ts');
      const priorApproaches = loadPriorFailedApproaches(
        deps.rejectedApproachStore,
        input.targetFiles[0]!,
        input.taskType,
        undefined,
        understanding.actionVerb, // Gap 8A: verb-aware cross-task loading
      );
      for (const approach of priorApproaches) {
        workingMemory.recordFailedApproach(
          approach.approach,
          approach.oracleVerdict,
          approach.verdictConfidence,
          approach.failureOracle,
        );
      }
    } catch {
      // Cross-task loading is best-effort — proceed without prior context
    }
  }

  // Outer loop: routing level escalation
  let routing = await deps.riskRouter.assessInitialLevel(input);

  // ── Evolution Rules (Phase 2.6) — apply before main loop ─────────
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

  // PH3.6: Epsilon-greedy exploration — with probability ε, route UP one level (never down)
  const EPSILON = deps.explorationEpsilon ?? 0.05;
  let explorationFlag = false;
  if (routing.level < MAX_ROUTING_LEVEL && Math.random() < EPSILON) {
    const fromLevel = routing.level;
    // R3: model/budget must follow level — re-derive from LEVEL_CONFIG
    const newLevel = (routing.level + 1) as RoutingLevel;
    const cfg = LEVEL_CONFIG[newLevel];
    routing = { ...routing, level: newLevel, model: cfg.model, budgetTokens: cfg.budgetTokens, latencyBudgetMs: cfg.latencyBudgetMs };
    explorationFlag = true;
    deps.bus?.emit('task:explore', { taskId: input.id, fromLevel, toLevel: routing.level });
  }

  // Domain-aware routing cap: conversational tasks are trivial — L1 is sufficient.
  // Prevents wasting tokens on L2+ escalation for greetings and simple questions.
  const MAX_CONVERSATIONAL_LEVEL = 1 as RoutingLevel;
  if (understanding.taskDomain === 'conversational' && routing.level > MAX_CONVERSATIONAL_LEVEL) {
    routing = { ...routing, level: MAX_CONVERSATIONAL_LEVEL };
  }

  // Domain-aware routing cap: general-reasoning + inquire + no tools → max L1.
  // L2+ adds agentic loop + tools — useless for pure knowledge questions.
  // Composition matrix (§12): general-reasoning/inquire/none → typical L0-L1.
  if (
    understanding.taskDomain === 'general-reasoning' &&
    understanding.taskIntent === 'inquire' &&
    understanding.toolRequirement === 'none' &&
    routing.level > MAX_CONVERSATIONAL_LEVEL
  ) {
    routing = { ...routing, level: MAX_CONVERSATIONAL_LEVEL };
  }

  // Capability floor: tasks that need tool execution require minimum L2 (agentic mode).
  // L0-L1 are single-shot text-only — no tool access. Without this floor, the LLM
  // hallucinates tool calls in its text response instead of actually executing them.
  if (understanding.toolRequirement === 'tool-needed' && routing.level < (2 as RoutingLevel)) {
    // R3: model/budget must follow level — re-derive from LEVEL_CONFIG
    const l2Cfg = LEVEL_CONFIG[2];
    routing = { ...routing, level: 2 as RoutingLevel, model: l2Cfg.model, budgetTokens: l2Cfg.budgetTokens, latencyBudgetMs: l2Cfg.latencyBudgetMs };
  }

  // CLI --thinking flag: force enable thinking for debugging
  if (input.constraints?.includes('THINKING:enabled') && routing.thinkingConfig?.type === 'disabled') {
    routing = { ...routing, thinkingConfig: { type: 'adaptive', effort: 'low', display: 'summarized' } };
  }

  deps.bus?.emit('task:start', { input, routing });

  // Hoist for audit trail on timeout/escalation traces (Gap #2)
  let lastWorkerSelection: import('./types.ts').WorkerSelectionResult | undefined;

  // G6: Global token budget cap — tracks worker generation tokens across routing levels × retries.
  // Note: critic and test-gen tokens are NOT tracked here (they run post-verification and are bounded
  // by their own maxTokens limits). This cap prevents runaway worker generation costs.
  const BUDGET_CAP_MULTIPLIER = 6; // ~3 routing levels × 2 retries per level
  let totalTokensConsumed = 0;

  while (routing.level <= MAX_ROUTING_LEVEL) {
    // Track matched skill for feedback loop (H4) — resets on level escalation
    let matchedSkill: CachedSkill | null = null;
    // ECP §7.3: bonus retries granted by oracle deliberation requests
    let deliberationBonusRetries = 0;

    // Inner loop: retry within current routing level
    for (let retry = 0; retry < input.budget.maxRetries + deliberationBonusRetries; retry++) {
      // ── Wall-clock timeout check ──────────────────────────────────
      if (Date.now() - startTime > input.budget.maxDurationMs) {
        const timeoutTrace: ExecutionTrace = {
          id: `trace-${input.id}-timeout`,
          taskId: input.id,
          workerId: routing.workerId ?? routing.model ?? 'unknown',
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
        };
        deps.bus?.emit('task:complete', { result: timeoutResult });
        return timeoutResult;
      }

      // ── L0 Skill Shortcut (Phase 2.5) ──────────────────────────────
      if (deps.skillManager && routing.level <= 1) {
        const fp = (input.targetFiles ?? []).sort().join(',') || '*';
        const taskSig = `${input.goal.slice(0, 50)}::${fp}`;
        const skill = deps.skillManager.match(taskSig);
        if (skill) {
          const check = deps.skillManager.verify(skill);
          if (check.valid) {
            matchedSkill = skill;
            // Inject proven approach as hypothesis — influences LLM generation
            // while still going through full oracle verification (A6 zero-trust)
            workingMemory.addHypothesis(`Proven approach: ${skill.approach}`, skill.successRate, 'cached-skill');
            deps.bus?.emit('skill:match', { taskId: input.id, skill });
          } else {
            deps.bus?.emit('skill:miss', { taskId: input.id, taskSignature: taskSig });
          }
        }
      }

      // ── Step 1: PERCEIVE ──────────────────────────────────────────
      const perception = await deps.perception.assemble(input, routing.level, understanding);

      // Gap 9A: Enrich understanding with perception-derived framework context
      // enrichWithPerception uses spread — preserves SemanticTaskUnderstanding fields
      if (perception.frameworkMarkers?.length) {
        understanding = enrichWithPerception(understanding, perception.frameworkMarkers) as typeof understanding;
      }

      // ── STU Layer 2: Semantic Understanding (post-routing, budget-gated, L2+ only) ──
      if (deps.understandingEngine && routing.level >= 2) {
        const { enrichUnderstandingL2 } = await import('./task-understanding.ts');
        const l2Start = Date.now();
        understanding = await enrichUnderstandingL2(understanding, {
          understandingEngine: deps.understandingEngine,
          workspace: deps.workspace ?? '.',
        }, { remainingTokens: input.budget.maxTokens - totalTokensConsumed });
        deps.bus?.emit('understanding:layer2_complete', {
          taskId: input.id,
          durationMs: Date.now() - l2Start,
          hasIntent: understanding.semanticIntent != null,
          depth: understanding.understandingDepth,
        });
      }

      // ── STU Phase C: Understanding Verification (A1: separate from generation) ──
      if (deps.worldGraph && understanding.understandingDepth >= 1) {
        const { verifyUnderstandingClaims } = await import('./understanding-verifier.ts');
        const verifyStart = Date.now();
        const verifiedClaims = verifyUnderstandingClaims(understanding, deps.worldGraph, deps.workspace ?? '.');
        understanding = { ...understanding, verifiedClaims: [...understanding.verifiedClaims, ...verifiedClaims] };
        deps.bus?.emit('understanding:claims_verified', {
          taskId: input.id,
          durationMs: Date.now() - verifyStart,
          totalClaims: verifiedClaims.length,
          knownClaims: verifiedClaims.filter((c) => c.type === 'known').length,
          contradictoryClaims: verifiedClaims.filter((c) => c.type === 'contradictory').length,
        });
      }

      // ── STU Phase E: Persist verified understanding claims as WorldGraph facts (A4) ──
      if (deps.worldGraph && understanding.verifiedClaims.length > 0) {
        try {
          const workspace = deps.workspace ?? '.';
          const knownClaims = understanding.verifiedClaims.filter((c) => c.type === 'known' && c.evidence.length > 0);
          for (const claim of knownClaims) {
            const sourceFile = claim.evidence[0]!.file;
            if (sourceFile === 'goal') continue; // Skip non-file evidence
            const absPath = resolvePath(workspace, sourceFile);
            let fileHash: string;
            try {
              fileHash = deps.worldGraph.computeFileHash(absPath);
            } catch {
              continue; // File not accessible — skip
            }
            deps.worldGraph.storeFact({
              target: sourceFile,
              pattern: 'understanding-verified',
              evidence: claim.evidence.map((e) => ({ file: e.file, line: e.line ?? 0, snippet: e.snippet ?? '' })),
              oracleName: claim.verifiedBy ?? 'understanding-verifier',
              sourceFile,
              fileHash,
              verifiedAt: Date.now(),
              sessionId: input.id,
              confidence: claim.confidence,
              decayModel: 'linear',
              tierReliability: claim.tierReliability,
            });
          }
        } catch {
          // WorldGraph fact storage is best-effort
        }
      }

      // ── Step 2: PREDICT (L2+ only) ───────────────────────────────
      let prediction: SelfModelPrediction | undefined;
      let predictionConfidence: number | undefined;
      let metaPredictionConfidence: number | undefined;
      let forwardPrediction: import('./forward-predictor-types.ts').OutcomePrediction | undefined;
      if (routing.level >= 2) {
        prediction = await deps.selfModel.predict(input, perception);
        deps.bus?.emit('selfmodel:predict', { prediction });

        // Injection A: capture prediction confidence for pipeline computation
        predictionConfidence = prediction.confidence;
        metaPredictionConfidence = prediction.metaConfidence;

        // FP: Forward Predictor — probabilistic outcome prediction (A7)
        if (deps.forwardPredictor) {
          try {
            forwardPrediction = await Promise.race([
              deps.forwardPredictor.predictOutcome(input, perception),
              new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 3000)),
            ]);
            if (forwardPrediction) {
              deps.bus?.emit('prediction:generated', { prediction: forwardPrediction });
              if (forwardPrediction.upgradedFrom) {
                deps.bus?.emit('prediction:tier_upgraded', {
                  taskId: input.id,
                  fromBasis: forwardPrediction.upgradedFrom,
                  toBasis: forwardPrediction.basis,
                });
              }
            }
          } catch {
            /* FP failure — proceed with selfModel only */
          }
        }

        // C1: Apply prediction-based routing escalation
        if (forwardPrediction) {
          routing = applyPredictionEscalation(routing, forwardPrediction);
        }

        // S1: Cold-start safeguard — enforce minimum routing level
        if (prediction.forceMinLevel != null && routing.level < prediction.forceMinLevel) {
          routing = { ...routing, level: prediction.forceMinLevel as RoutingLevel };
        }
      }

      // ── EO #6: Attach reasoning policy (Self-Model calibrated budget split) ──
      if (deps.selfModel.getReasoningPolicy) {
        const { computeTaskSignature } = await import('./self-model.ts');
        const taskSig = computeTaskSignature(input);
        routing = { ...routing, reasoningPolicy: deps.selfModel.getReasoningPolicy(taskSig) };
      }

      // ── Step 2½a: COMPILE THINKING POLICY (Extensible Thinking Phase 2.1) ──
      if (deps.thinkingPolicyCompiler) {
        const { computeTaskUncertainty } = await import('./uncertainty-computer.ts');
        const { computeTaskSignature } = await import('./self-model.ts');
        const taskSig = computeTaskSignature(input);

        const uncertainty = computeTaskUncertainty({
          taskInput: input,
          priorTraceCount: prediction?.calibrationDataPoints ?? 0,
        });

        const compiledPolicy = await deps.thinkingPolicyCompiler.compile({
          taskInput: input,
          riskScore: routing.riskScore ?? 0,
          uncertaintySignal: uncertainty,
          routingLevel: routing.level as 0 | 1 | 2 | 3,
          taskTypeSignature: taskSig,
          selfModelConfidence: prediction?.confidence,
        });

        // Thinking compiler may downgrade thinking (e.g. Profile A → disabled for reflex tasks).
        // But if the routing level's LEVEL_CONFIG prescribes thinking (e.g. L1 adaptive:low),
        // don't let the compiler disable it — the level config is the floor.
        const compiledThinking = compiledPolicy.thinking;
        const shouldKeepRouting = compiledThinking.type === 'disabled'
          && routing.thinkingConfig?.type !== 'disabled';
        routing = {
          ...routing,
          thinkingPolicy: compiledPolicy,
          thinkingConfig: shouldKeepRouting ? routing.thinkingConfig : compiledThinking,
        };

        deps.bus?.emit('thinking:policy-compiled', {
          taskId: input.id,
          policy: compiledPolicy,
          routingLevel: routing.level,
        });
      }

      // ── Step 2½: SELECT WORKER (Phase 4) ──────────────────────────
      let workerSelection: import('./types.ts').WorkerSelectionResult | undefined;
      if (deps.workerSelector && !routing.workerId) {
        const { computeFingerprint } = await import('./task-fingerprint.ts');
        const fingerprint = computeFingerprint(input, perception, {
          traceCount: deps.traceCollector.getTraceCount?.() ?? 0,
        });
        const selection = deps.workerSelector.selectWorker(
          fingerprint,
          routing.level,
          { maxTokens: input.budget.maxTokens, timeoutMs: input.budget.maxDurationMs },
          undefined,
          input.id,
        );
        workerSelection = selection;
        lastWorkerSelection = selection;

        // A2: Fleet-level uncertainty — all workers below capability threshold
        if (selection.isUncertain) {
          // PH5.8: Try cross-instance delegation before giving up
          if (deps.instanceCoordinator?.canDelegate(input, fingerprint)) {
            const delegation = await deps.instanceCoordinator.delegate(input, fingerprint);
            if (delegation.delegated && delegation.result) {
              // I12: Re-verify delegated result locally — remote cannot bypass verification
              if (delegation.result.mutations.length > 0 && deps.workspace) {
                // Map TaskResult mutations to OracleGate.verify format (file + content)
                const verifyMutations = delegation.result.mutations.map((m) => ({
                  file: m.file,
                  content: m.diff, // Best-effort: use diff as content proxy for re-verification
                }));
                const reVerify = await deps.oracleGate.verify(verifyMutations, deps.workspace);
                if (!reVerify.passed) {
                  deps.bus?.emit('task:uncertain', {
                    taskId: input.id,
                    reason: `Delegated result from ${delegation.peerId} failed local re-verification`,
                    maxCapability: selection.maxCapability ?? 0,
                  });
                  // Fall through to uncertain result below
                } else {
                  deps.bus?.emit('task:complete', { result: delegation.result });
                  return delegation.result;
                }
              } else {
                deps.bus?.emit('task:complete', { result: delegation.result });
                return delegation.result;
              }
            }
          }

          const uncertainTrace: ExecutionTrace = {
            id: `trace-${input.id}-uncertain`,
            taskId: input.id,
            workerId: 'none',
            timestamp: Date.now(),
            routingLevel: routing.level,
            approach: 'fleet-uncertain',
            oracleVerdicts: {},
            modelUsed: 'none',
            tokensConsumed: 0,
            durationMs: Date.now() - startTime,
            outcome: 'failure',
            failureReason: `All workers below capability threshold (max: ${selection.maxCapability?.toFixed(2)}) — abstaining per A2`,
            affectedFiles: input.targetFiles ?? [],
            workerSelectionAudit: selection,
          };
          await deps.traceCollector.record(uncertainTrace);
          deps.bus?.emit('trace:record', { trace: uncertainTrace });
          const uncertainResult: TaskResult = {
            id: input.id,
            status: 'uncertain',
            mutations: [],
            trace: uncertainTrace,
            notes: ['All workers below capability threshold — abstaining per A2'],
          };
          deps.bus?.emit('task:complete', { result: uncertainResult });
          return uncertainResult;
        }

        if (selection.selectedWorkerId) {
          routing = { ...routing, workerId: selection.selectedWorkerId };
        }
      }

      // ── Step 3: PLAN (L2+ only) ──────────────────────────────────
      let plan: TaskDAG | undefined;
      if (routing.level >= 2) {
        plan = await deps.decomposer.decompose(input, perception, workingMemory.getSnapshot());
        if (plan.isFallback) {
          deps.bus?.emit('decomposer:fallback', { taskId: input.id });
        }
      }

      // C2: Score plan nodes by causal risk → reorder for fail-fast
      if (plan && forwardPrediction) {
        scorePlanByPrediction(plan, forwardPrediction);
      }

      // ── Step 3.5: APPROVAL GATE (A6 — human-in-the-loop for high-risk tasks) ──
      if (deps.approvalGate && routing.riskScore != null && routing.riskScore >= 0.8) {
        const decision = await deps.approvalGate.requestApproval(
          input.id,
          routing.riskScore,
          `High risk (${routing.riskScore.toFixed(2)}) at L${routing.level}`,
        );
        if (decision === 'rejected') {
          return {
            id: input.id,
            status: 'failed',
            mutations: [],
            trace: {
              id: `trace-${input.id}-rejected`,
              taskId: input.id,
              timestamp: Date.now(),
              routingLevel: routing.level,
              approach: 'rejected-by-human',
              oracleVerdicts: {},
              modelUsed: routing.model ?? 'none',
              tokensConsumed: 0,
              durationMs: Date.now() - startTime,
              outcome: 'failure',
              failureReason: 'Rejected by human approval gate',
              affectedFiles: input.targetFiles ?? [],
            },
            escalationReason: 'Rejected by human approval gate',
          };
        }
      }

      // ── Step 4: GENERATE (dispatch to worker) ────────────────────
      // K1.2: Create immutable AgentContract before dispatch (A3+A6)
      const contract = createContract(input, routing);
      deps.bus?.emit('worker:dispatch', { taskId: input.id, routing });
      const dispatchStart = Date.now();
      let workerResult: WorkerResult;
      let isAgenticResult = false;
      let lastAgentResult: import('./worker/agent-loop.ts').WorkerLoopResult | null = null;
      let dagResult: DAGExecutionResult | null = null;
      try {
        if (routing.level <= 1 || !deps.workerPool.getAgentLoopDeps?.()) {
          // L0-L1 or no agent deps: single-shot or DAG dispatch
          if (plan && !plan.isFallback && plan.nodes.length > 1) {
            // EO #1+#4: Multi-node plan → DAG executor with parallel dispatch
            const memSnapshot = workingMemory.getSnapshot();
            const dispatcher: NodeDispatcher = async (nodeId, node) => {
              const nodeInput: TaskInput = {
                ...input,
                id: `${input.id}-${nodeId}`,
                targetFiles: node.targetFiles.length > 0 ? node.targetFiles : input.targetFiles,
                goal: node.description || input.goal,
              };
              const result = await deps.workerPool.dispatch(nodeInput, perception, memSnapshot, plan, routing, understanding, contract);
              return {
                nodeId,
                mutations: result.mutations,
                tokensConsumed: result.tokensConsumed,
                durationMs: result.durationMs,
              };
            };
            dagResult = await executeDAG(plan, dispatcher);
            deps.bus?.emit('dag:executed', {
              taskId: input.id,
              nodes: dagResult.results.length,
              parallel: dagResult.usedParallelExecution,
              fileConflicts: dagResult.fileConflicts.length,
            });
            workerResult = {
              mutations: dagResult.results.flatMap((r) =>
                r.mutations.map((m) => ({
                  file: m.file,
                  content: m.content,
                  diff: m.diff ?? '',
                  explanation: m.explanation ?? '',
                })),
              ),
              proposedToolCalls: [],
              tokensConsumed: dagResult.totalTokens,
              durationMs: dagResult.totalDurationMs,
            };
          } else {
            // Single-node or fallback: direct dispatch (TDD: L0 < 100ms, L1 < 2s)
            workerResult = await deps.workerPool.dispatch(
              input,
              perception,
              workingMemory.getSnapshot(),
              plan,
              routing,
              understanding,
              contract,
            );
          }
        } else {
          // L2+: agentic loop (multi-turn with tools)
          const agentLoopDeps = deps.workerPool.getAgentLoopDeps!()!;
          const { runAgentLoop } = await import('./worker/agent-loop.ts');
          lastAgentResult = await runAgentLoop(
            input,
            perception,
            workingMemory.getSnapshot(),
            plan,
            routing,
            agentLoopDeps,
            understanding,
            contract,
          );
          isAgenticResult = true;
          // Adapt WorkerLoopResult → WorkerResult for downstream compatibility
          workerResult = {
            mutations: lastAgentResult.mutations
              .filter((m) => m.content !== null)
              .map((m) => ({
                file: m.file,
                content: m.content ?? '',
                diff: m.diff,
                explanation: m.explanation,
              })),
            proposedToolCalls: lastAgentResult.proposedToolCalls,
            uncertainties: lastAgentResult.uncertainties,
            tokensConsumed: lastAgentResult.tokensConsumed,
            cacheReadTokens: (lastAgentResult as any).cacheReadTokens,
            cacheCreationTokens: (lastAgentResult as any).cacheCreationTokens,
            durationMs: lastAgentResult.durationMs,
            proposedContent: lastAgentResult.proposedContent,
            nonRetryableError: lastAgentResult.nonRetryableError,
          };

          // Build session summary for retry context when uncertain
          if (lastAgentResult.isUncertain) {
            const summary = buildAgentSessionSummary(lastAgentResult, retry, 'uncertain');
            workingMemory.addPriorAttempt(summary);
          }
        }
        deps.bus?.emit('worker:complete', {
          taskId: input.id,
          output: workerResult as unknown as import('./types.ts').WorkerOutput,
          durationMs: Date.now() - dispatchStart,
        });

        // ── Non-retryable error fast-exit (auth, config) ────────────
        if (workerResult.nonRetryableError) {
          console.error(`[vinyan] Non-retryable error — aborting: ${workerResult.nonRetryableError}`);
          const failTrace: ExecutionTrace = {
            id: `trace-${input.id}-non-retryable`,
            taskId: input.id,
            workerId: routing.workerId ?? routing.model ?? 'unknown',
            timestamp: Date.now(),
            routingLevel: routing.level,
            approach: 'non-retryable-error',
            oracleVerdicts: {},
            modelUsed: routing.model ?? 'none',
            tokensConsumed: workerResult.tokensConsumed,
            durationMs: Date.now() - startTime,
            outcome: 'failure',
            failureReason: workerResult.nonRetryableError,
            affectedFiles: input.targetFiles ?? [],
          };
          await deps.traceCollector.record(failTrace);
          deps.bus?.emit('trace:record', { trace: failTrace });
          const failResult: TaskResult = {
            id: input.id,
            status: 'failed',
            mutations: [],
            trace: failTrace,
          };
          deps.bus?.emit('task:complete', { result: failResult });
          return failResult;
        }

        // Answer quality gate: reasoning tasks must produce non-empty answer
        if (input.taskType === 'reasoning' && !workerResult.proposedContent?.trim()) {
          workingMemory.recordFailedApproach(`Empty answer at L${routing.level}`, 'answer-quality-gate');
          continue; // retry with next escalation level
        }

        // A1 Reasoning quality gate: deterministic post-generation checks.
        // Different component (orchestrator) verifies generator (LLM) output.
        if (input.taskType === 'reasoning' && workerResult.proposedContent) {
          // Check 1: Instruction echo detection — LLM parrots system prompt instead of answering.
          // Uses word overlap ratio between output prefix and known system prompt fragments.
          const echoFragments = [
            'do not use json',
            'match the user\'s language',
            'never fabricate facts',
            'answer directly and concisely',
            'code blocks for your answer',
            'produce a concise',
          ];
          const outputPrefix = workerResult.proposedContent.slice(0, 200).toLowerCase();
          const echoCount = echoFragments.filter((f) => outputPrefix.includes(f)).length;
          if (echoCount >= 2) {
            workingMemory.recordFailedApproach(`Instruction echo detected (${echoCount} fragments)`, 'answer-quality-gate');
            continue; // retry — LLM echoed instructions instead of answering
          }

          // Check 1b: Hallucinated tool calls — L0-L1 has no tools, but LLM may generate
          // fake tool-call XML patterns in its text response. Detect and escalate to L2+.
          if (routing.level <= 1) {
            const hallucinationPatterns = [
              '<function_calls>',
              '<invoke name=',
              '<tool_use>',
              '<tool_call>',
              '```tool_code',
            ];
            const contentLower = workerResult.proposedContent.toLowerCase();
            const hasHallucination = hallucinationPatterns.some((p) => contentLower.includes(p));
            if (hasHallucination) {
              workingMemory.recordFailedApproach(
                `Hallucinated tool calls at L${routing.level} (text-only mode has no tools)`,
                'answer-quality-gate',
              );
              continue; // escalate to L2+ where real tools are available
            }
          }

          // Check 2: A6 defense-in-depth — strip mutating tool calls from non-mutation domains.
          // Even if prompt filtering fails, orchestrator blocks execution.
          if (understanding.taskDomain !== 'code-mutation' && workerResult.proposedToolCalls.length > 0) {
            const { READONLY_TOOLS } = await import('./types.ts');
            workerResult.proposedToolCalls = workerResult.proposedToolCalls.filter(
              (tc) => READONLY_TOOLS.has(tc.tool),
            );
          }
        }

        // G6: Accumulate global token budget
        totalTokensConsumed += workerResult.tokensConsumed;
        const globalBudgetCap = input.budget.maxTokens * BUDGET_CAP_MULTIPLIER;
        if (totalTokensConsumed > globalBudgetCap) {
          const budgetTrace: ExecutionTrace = {
            id: `trace-${input.id}-budget-exceeded`,
            taskId: input.id,
            workerId: routing.workerId ?? routing.model ?? 'unknown',
            timestamp: Date.now(),
            routingLevel: routing.level,
            approach: 'global-budget-exceeded',
            oracleVerdicts: {},
            modelUsed: routing.model ?? 'none',
            tokensConsumed: totalTokensConsumed,
            durationMs: Date.now() - startTime,
            outcome: 'failure',
            failureReason: `Global token budget exceeded: ${totalTokensConsumed} > ${globalBudgetCap}`,
            affectedFiles: input.targetFiles ?? [],
            workerSelectionAudit: workerSelection ?? lastWorkerSelection,
          };
          await deps.traceCollector.record(budgetTrace);
          deps.bus?.emit('trace:record', { trace: budgetTrace });
          deps.bus?.emit('task:budget-exceeded', {
            taskId: input.id,
            totalTokensConsumed,
            globalCap: globalBudgetCap,
          });
          const budgetResult: TaskResult = {
            id: input.id,
            status: 'failed',
            mutations: [],
            trace: budgetTrace,
          };
          deps.bus?.emit('task:complete', { result: budgetResult });
          return budgetResult;
        }
      } catch (dispatchErr) {
        deps.bus?.emit('worker:error', {
          taskId: input.id,
          error: String(dispatchErr),
          routing,
        });
        // Record failure trace so dispatch errors are visible to Sleep Cycle and audit
        const dispatchFailTrace: ExecutionTrace = {
          id: `trace-${input.id}-dispatch-error-${routing.level}-${retry}`,
          taskId: input.id,
          workerId: routing.workerId ?? routing.model ?? 'unknown',
          timestamp: Date.now(),
          routingLevel: routing.level,
          approach: 'dispatch-error',
          oracleVerdicts: {},
          modelUsed: routing.model ?? 'none',
          tokensConsumed: 0,
          durationMs: Date.now() - startTime,
          outcome: 'failure',
          failureReason: `Worker dispatch failed: ${String(dispatchErr)}`,
          affectedFiles: input.targetFiles ?? [],
          workerSelectionAudit: workerSelection ?? lastWorkerSelection,
          exploration: explorationFlag || undefined,
        };
        await deps.traceCollector.record(dispatchFailTrace);
        deps.bus?.emit('trace:record', { trace: dispatchFailTrace });
        throw dispatchErr;
      }

      // ── Step 4½a: EXECUTE read-only tool calls (safe pre-verification) ──
      let mutatingToolCalls: import('./types.ts').ToolCall[] = [];
      if (deps.toolExecutor && workerResult.proposedToolCalls.length > 0) {
        const toolContext = {
          workspace: deps.workspace ?? process.cwd(),
          allowedPaths: input.targetFiles ?? [],
          routingLevel: routing.level,
        } as import('./tools/tool-interface.ts').ToolContext;

        const { readOnly, mutating } = deps.toolExecutor.partitionBySideEffect(workerResult.proposedToolCalls);
        mutatingToolCalls = mutating;

        // Execute read-only tools immediately (no side effects)
        if (readOnly.length > 0) {
          const readOnlyResults = await deps.toolExecutor.executeProposedTools(readOnly, toolContext);
          deps.bus?.emit('tools:executed', { taskId: input.id, results: readOnlyResults });
        }
      }

      // ── Step 5: VERIFY (oracle gate) ─────────────────────────────
      // EO #3: Extract verificationHint — per-node merge for DAG, single-node for direct
      let activeHint: VerificationHint | undefined;
      if (dagResult && plan && plan.nodes.length > 1) {
        // Multi-node DAG: merge hints — use oracle intersection if all nodes agree,
        // otherwise run all oracles (safest). skipTestWhen applies if ANY node sets it.
        const nodeHints = plan.nodes.map((n) => n.verificationHint).filter(Boolean) as VerificationHint[];
        if (nodeHints.length > 0) {
          const allOracleSets = nodeHints.filter((h) => h.oracles).map((h) => h.oracles!);
          // Union all oracle sets — DAG touches multiple nodes, need all relevant oracles
          const mergedOracles =
            allOracleSets.length > 0 ? ([...new Set(allOracleSets.flat())] as VerificationHint['oracles']) : undefined;
          const mergedSkip = nodeHints.find((h) => h.skipTestWhen)?.skipTestWhen;
          activeHint = { oracles: mergedOracles, skipTestWhen: mergedSkip };
        }
      } else {
        activeHint = plan?.nodes?.[0]?.verificationHint;
      }
      // A1 Understanding layer: attach TaskUnderstanding for goal-alignment oracle
      if (activeHint) {
        activeHint.understanding = understanding;
        activeHint.targetFiles = input.targetFiles;
      } else {
        activeHint = { understanding, targetFiles: input.targetFiles };
      }
      const verification = await deps.oracleGate.verify(
        workerResult.mutations.map((m) => ({
          file: m.file,
          content: m.content,
        })),
        input.targetFiles?.[0] ?? '.',
        activeHint,
      );

      // ── Emit per-oracle verdicts ──────────────────────────────────
      const passedOracles: string[] = [];
      const failedOracles: string[] = [];
      for (const [oracleName, verdict] of Object.entries(verification.verdicts)) {
        deps.bus?.emit('oracle:verdict', { taskId: input.id, oracleName, verdict });
        if (verdict.verified) passedOracles.push(oracleName);
        else failedOracles.push(oracleName);
      }
      // ── Contradiction detection (A1: surface epistemic disagreements) ──
      const hasContradiction = passedOracles.length > 0 && failedOracles.length > 0;
      if (hasContradiction) {
        deps.bus?.emit('oracle:contradiction', {
          taskId: input.id,
          passed: passedOracles,
          failed: failedOracles,
        });

        // K1.1: Auto-escalate on contradiction — higher routing level brings
        // more oracles and deeper verification to resolve disagreements.
        if (routing.level < (3 as RoutingLevel)) {
          const fromLevel = routing.level;
          const toLevel = (routing.level + 1) as RoutingLevel;
          deps.bus?.emit('verification:contradiction_escalated', {
            taskId: input.id,
            fromLevel,
            toLevel,
            passed: passedOracles,
            failed: failedOracles,
          });
          deps.bus?.emit('task:escalate', {
            taskId: input.id,
            fromLevel,
            toLevel,
            reason: `Contradiction: ${passedOracles.join(',')} passed but ${failedOracles.join(',')} failed`,
          });
          routing = { ...routing, level: toLevel };
          break; // Exit retry loop — re-enter at higher routing level
        }
        // L3 contradiction: nowhere to escalate — surface as unresolved
        deps.bus?.emit('verification:contradiction_unresolved', {
          taskId: input.id,
          passed: passedOracles,
          failed: failedOracles,
        });
      }

      // ── ECP §7.3: Surface deliberation requests from oracles (A2) ──
      let deliberationRequested = false;
      for (const [oracleName, verdict] of Object.entries(verification.verdicts)) {
        if (verdict.deliberationRequest) {
          deps.bus?.emit('oracle:deliberation_request', {
            taskId: input.id,
            oracleName,
            reason: verdict.deliberationRequest.reason,
            suggestedBudget: verdict.deliberationRequest.suggestedBudget,
          });
          deliberationRequested = true;
        }
      }

      // ── ECP §7.3: Act on deliberation requests — grant additional compute budget ──
      // When an oracle requests deliberation, grant +1 retry (capped at 2x original)
      // and escalate routing level if below L2 (deliberation implies deeper analysis needed)
      if (deliberationRequested) {
        deliberationBonusRetries = Math.min(deliberationBonusRetries + 1, input.budget.maxRetries);
        if (routing.level < 2) {
          const fromLevel = routing.level;
          routing = { ...routing, level: (routing.level + 1) as RoutingLevel };
          deps.bus?.emit('task:escalate', {
            taskId: input.id,
            fromLevel,
            toLevel: routing.level,
            reason: 'deliberation_request',
          });
        }
      }

      // ── Oracle failure pattern (WP-5: lightweight fingerprint for trace analysis) ──
      const oracleFailurePattern = failedOracles.length > 0 ? failedOracles.sort().join('+') : undefined;

      // ── Compute QualityScore from available data (A7: gradient signal) ──
      const testVerdictKey = Object.keys(verification.verdicts).find((k) => k.startsWith('test'));
      const testContext = testVerdictKey
        ? { testsExist: true, testsPassed: verification.verdicts[testVerdictKey]?.verified }
        : undefined;
      const complexityCtx = buildComplexityContext(
        workerResult.mutations.map((m) => ({ file: m.file, content: m.content })),
        deps.workspace ?? process.cwd(),
      );
      const qualityScore = computeQualityScore(
        verification.verdicts,
        workerResult.durationMs,
        routing.latencyBudgetMs,
        complexityCtx,
        testContext,
      );

      // ── Injection B: Compute pipeline confidence (L1+ only) ──────
      const verificationConfidence = verification.aggregateConfidence ?? (verification.passed ? 0.85 : 0.3);

      let pipelineConf: ReturnType<typeof computePipelineConfidence> | undefined;
      let confidenceDecision: ConfidenceDecision | undefined;

      if (routing.level > 0) {
        pipelineConf = computePipelineConfidence({
          prediction: predictionConfidence,
          metaPrediction: metaPredictionConfidence,
          verification: verificationConfidence,
        });
        confidenceDecision = deriveConfidenceDecision(pipelineConf.composite);
      }

      // ── Step 6: LEARN ────────────────────────────────────────────
      // Gap 6A: Use unified computeTaskSignature instead of raw goal prefix.
      // This ensures traces cluster by verb+extensions+blastBucket (not freeform goal text)
      // so Sleep Cycle pattern extraction and Self-Model calibration operate on consistent keys.
      const { computeTaskSignature: computeSig } = await import('./self-model.ts');
      const taskTypeSignature = computeSig(input);

      // PH4: Detect framework markers for capability routing (always compute, data-gate only in fingerprint)
      const { detectFrameworkMarkers } = await import('./task-fingerprint.ts');
      const frameworkMarkers = detectFrameworkMarkers(perception);

      // Injection D: determine outcome using confidence decision when available
      // Zero-mutation tasks (reasoning/conversation): pipeline confidence protects against bad code
      // changes — when there are no changes, confidence gatekeeping is unnecessary.
      const zeroMutationPass = workerResult.mutations.length === 0 && verification.passed;
      const effectiveOutcome: ExecutionTrace['outcome'] =
        routing.level === 0 || !confidenceDecision
          ? verification.passed
            ? 'success'
            : 'failure'
          : zeroMutationPass || confidenceDecision === 'allow'
            ? 'success'
            : 'failure';

      const trace: ExecutionTrace = {
        id: `trace-${input.id}-${routing.level}-${retry}-${Math.random().toString(36).slice(2, 6)}`,
        taskId: input.id,
        workerId: routing.workerId ?? routing.model ?? 'unknown',
        timestamp: Date.now(),
        routingLevel: routing.level,
        taskTypeSignature: taskTypeSignature,
        approach: workerResult.mutations.map((m) => m.explanation).join('; '),
        oracleVerdicts: Object.fromEntries(Object.entries(verification.verdicts).map(([k, v]) => [k, v.verified])),
        modelUsed: routing.model ?? 'none',
        tokensConsumed: workerResult.tokensConsumed,
        cacheReadTokens: workerResult.cacheReadTokens,
        cacheCreationTokens: workerResult.cacheCreationTokens,
        durationMs: workerResult.durationMs,
        outcome: effectiveOutcome,
        failureReason: effectiveOutcome === 'success' ? undefined : verification.reason,
        affectedFiles: workerResult.mutations.map((m) => m.file),
        qualityScore,
        prediction,
        forwardPrediction,
        mergedPPass:
          prediction && forwardPrediction ? mergeForwardAndSelfModel(prediction, forwardPrediction) : undefined,
        oracleFailurePattern,
        exploration: explorationFlag || undefined,
        workerSelectionAudit: workerSelection,
        frameworkMarkers: frameworkMarkers.length > 0 ? frameworkMarkers : undefined,
        // Injection D: populate pipeline confidence fields
        verificationConfidence: routing.level > 0 ? verificationConfidence : undefined,
        epistemicDecision: verification.epistemicDecision,
        confidenceDecision: confidenceDecision
          ? {
              action: confidenceDecision,
              confidence: pipelineConf?.composite ?? 0,
              reason: pipelineConf?.formula,
            }
          : undefined,
        pipelineConfidence: pipelineConf
          ? {
              composite: pipelineConf.composite,
              formula: pipelineConf.formula,
            }
          : undefined,
        // Extensible Thinking Phase 0: capture thinking mode and token usage
        thinkingMode: routing.thinkingConfig
          ? routing.thinkingConfig.type === 'adaptive'
            ? `adaptive:${routing.thinkingConfig.effort}`
            : routing.thinkingConfig.type === 'enabled'
              ? `enabled:${routing.thinkingConfig.budgetTokens}`
              : 'disabled'
          : undefined,
        thinkingTokensUsed: workerResult.thinkingTokensUsed,
        // Extensible Thinking Phase 1b: thinking policy metadata
        thinkingMeta: routing.thinkingPolicy
          ? {
              profile_id: routing.thinkingPolicy.profileId,
              uncertainty_score: routing.thinkingPolicy.uncertaintyScore,
              risk_score: routing.thinkingPolicy.riskScore,
              self_model_confidence: routing.thinkingPolicy.selfModelConfidence,
              thinking_ceiling: routing.thinkingPolicy.thinkingCeiling,
              observation_key: routing.thinkingPolicy.observationKey,
              policy_basis: routing.thinkingPolicy.policyBasis,
            }
          : undefined,
        // P1: Serialize working memory failed approaches for cross-task learning
        failedApproaches: workingMemory.getSnapshot().failedApproaches.map(fa => ({
          approach: fa.approach,
          oracleVerdict: fa.oracleVerdict,
          verdictConfidence: fa.verdictConfidence,
          failureOracle: fa.failureOracle,
        })),
      };

      // ── Step 6: LEARN — see calibrate + record block after confidence decision switch ──

      // ── Step 5½: EXECUTE mutating tools ONLY after verification ──
      if (verification.passed && deps.toolExecutor && mutatingToolCalls.length > 0) {
        const toolContext = {
          workspace: deps.workspace ?? process.cwd(),
          allowedPaths: input.targetFiles ?? [],
          routingLevel: routing.level,
        } as import('./tools/tool-interface.ts').ToolContext;

        const mutatingResults = await deps.toolExecutor.executeProposedTools(mutatingToolCalls, toolContext);
        deps.bus?.emit('tools:executed', { taskId: input.id, results: mutatingResults });

        // Merge file-write tool results back into mutations
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

      // ── Injection C: Confidence-driven decision routing ──────────
      // Determine whether to take the success path based on confidence decision (L1+)
      // or binary verification result (L0).
      // Zero-mutation shortcut: nothing to protect → trust binary verification (prevents retry storm)
      const shouldCommit =
        routing.level === 0 || !confidenceDecision
          ? verification.passed
          : zeroMutationPass || confidenceDecision === 'allow';

      // Handle re-verify, escalate, refuse for L1+ before the main success/failure branch
      let shouldContinue = false;
      if (routing.level > 0 && confidenceDecision && !shouldCommit) {
        switch (confidenceDecision) {
          case 're-verify': {
            // DESIGN NOTE (EHD audit): Re-verify runs BEFORE the critic enrichment path (~L865).
            // This is inherent to the architecture — re-verify escalates oracle level while critic
            // enriches opinions post-verification. Fixing this would require critic to run inside
            // the oracle gate, violating A1 (Epistemic Separation). Accepted as-is.
            // Escalate verification level without consuming a retry
            deps.bus?.emit('pipeline:re-verify', {
              taskId: input.id,
              composite: pipelineConf?.composite,
              routing,
            });
            // Re-run verification at a higher level
            const reVerification = await deps.oracleGate.verify(
              workerResult.mutations.map((m) => ({ file: m.file, content: m.content })),
              input.targetFiles?.[0] ?? '.',
              activeHint,
            );
            const reVerConfidence = reVerification.aggregateConfidence ?? (reVerification.passed ? 0.85 : 0.3);
            const reVerPipeline = computePipelineConfidence({
              prediction: predictionConfidence,
              metaPrediction: metaPredictionConfidence,
              verification: reVerConfidence,
            });
            const reVerDecision = deriveConfidenceDecision(reVerPipeline.composite);

            if (reVerDecision === 'allow' || reVerification.passed) {
              // Update trace with re-verification data
              trace.verificationConfidence = reVerConfidence;
              trace.confidenceDecision = {
                action: reVerDecision,
                confidence: reVerPipeline.composite,
                reason: reVerPipeline.formula,
              };
              trace.pipelineConfidence = {
                composite: reVerPipeline.composite,
                formula: reVerPipeline.formula,
              };
              trace.outcome = 'success';
              trace.failureReason = undefined;
              // Fall through to success path by updating verification reference
              // (but we can't reassign const — so we handle commit inline)
              // Commit success directly here
            } else {
              // Re-verify didn't help → fall through to failure
              const classified = classifyAllFailures(verification.verdicts);
              workingMemory.recordFailedApproach(
                trace.approach,
                verification.reason ?? 'unknown',
                verificationConfidence,
                failedOracles[0],
                classified.length > 0 ? classified : undefined,
              );
              // Preserve agentic session context for retry (transcript, tokens, failure point)
              if (isAgenticResult && lastAgentResult) {
                const summary = buildAgentSessionSummary(lastAgentResult, retry, 'oracle_failed');
                workingMemory.addPriorAttempt(summary);
              }
              for (const oName of failedOracles) {
                deps.bus?.emit('context:verdict_omitted', {
                  taskId: input.id,
                  oracleName: oName,
                  reason: 'Oracle verdict available but not propagated to worker context on retry',
                });
              }
              if (matchedSkill && deps.skillManager) {
                deps.skillManager.recordOutcome(matchedSkill, false);
                deps.bus?.emit('skill:outcome', { taskId: input.id, skill: matchedSkill, success: false });
                matchedSkill = null;
              }
              shouldContinue = true;
            }
            break;
          }
          case 'escalate': {
            // Bump routing level and skip remaining retries at this level
            deps.bus?.emit('pipeline:escalate', {
              taskId: input.id,
              composite: pipelineConf?.composite,
              fromLevel: routing.level,
            });
            workingMemory.recordFailedApproach(
              trace.approach,
              verification.reason ?? 'unknown',
              verificationConfidence,
              failedOracles[0],
              classifyAllFailures(verification.verdicts),
            );
            if (isAgenticResult && lastAgentResult) {
              const summary = buildAgentSessionSummary(lastAgentResult, retry, 'oracle_failed');
              workingMemory.addPriorAttempt(summary);
            }
            if (matchedSkill && deps.skillManager) {
              deps.skillManager.recordOutcome(matchedSkill, false);
              deps.bus?.emit('skill:outcome', { taskId: input.id, skill: matchedSkill, success: false });
              matchedSkill = null;
            }
            // Exhaust retries to trigger routing level escalation
            retry = input.budget.maxRetries + deliberationBonusRetries;
            shouldContinue = true;
            break;
          }
          case 'refuse': {
            // Block — record failed approach, do not retry
            deps.bus?.emit('pipeline:refuse', {
              taskId: input.id,
              composite: pipelineConf?.composite,
              reason: 'Pipeline confidence below refuse threshold',
            });
            workingMemory.recordFailedApproach(
              trace.approach,
              verification.reason ?? 'unknown',
              verificationConfidence,
              failedOracles[0],
              classifyAllFailures(verification.verdicts),
            );
            if (isAgenticResult && lastAgentResult) {
              const summary = buildAgentSessionSummary(lastAgentResult, retry, 'oracle_failed');
              workingMemory.addPriorAttempt(summary);
            }
            if (matchedSkill && deps.skillManager) {
              deps.skillManager.recordOutcome(matchedSkill, false);
              deps.bus?.emit('skill:outcome', { taskId: input.id, skill: matchedSkill, success: false });
              matchedSkill = null;
            }
            shouldContinue = true;
            break;
          }
        }
      }

      // ── Step 6: LEARN — calibrate + record trace ──────────────────
      // Placed AFTER confidence decision so trace.outcome reflects final resolved outcome (A7)
      // but BEFORE shouldContinue check so ALL paths (refuse/escalate/success) record traces
      if (prediction && deps.selfModel.calibrate) {
        try {
          // ECP v2 (DE2): Extract engineCertainty map from oracle verdicts for calibration
          const engineCertaintyMap: Record<string, number> = {};
          for (const [name, v] of Object.entries(verification.verdicts)) {
            if (v.engineCertainty != null) {
              engineCertaintyMap[name] = v.engineCertainty;
            }
          }
          const predictionError = deps.selfModel.calibrate(
            prediction,
            trace,
            Object.keys(engineCertaintyMap).length > 0 ? engineCertaintyMap : undefined,
          );
          if (predictionError) {
            trace.predictionError = predictionError;
          }
        } catch (calibErr) {
          deps.bus?.emit('selfmodel:calibration_error', {
            taskId: input.id,
            error: calibErr instanceof Error ? calibErr.message : String(calibErr),
          });
        }
      }

      // ── STU Phase D: Understanding calibration (A7) ──
      if (understanding.understandingDepth >= 1) {
        try {
          const { calibrateUnderstanding, computeEnrichedSignature } = await import('./understanding-calibrator.ts');
          const calibration = calibrateUnderstanding(understanding, trace);
          deps.bus?.emit('understanding:calibration', {
            taskId: input.id,
            entityAccuracy: calibration.entityAccuracy,
            categoryMatch: calibration.categoryMatch,
          });
          // Enriched signature: create per-intent learning bucket when ≥10 observations
          if (deps.selfModel?.getTaskTypeParams && taskTypeSignature) {
            const enrichedSig = computeEnrichedSignature(
              taskTypeSignature,
              understanding,
              (sig) => deps.selfModel.getTaskTypeParams?.(sig)?.observationCount ?? 0,
            );
            if (enrichedSig !== taskTypeSignature) {
              trace.taskTypeSignature = enrichedSig;
            }
          }
        } catch {
          // Understanding calibration failure — non-critical
        }
      }

      // FP: Record outcome for ForwardPredictor calibration (A7)
      if (deps.forwardPredictor && forwardPrediction) {
        try {
          const fpOutcome = mapTraceToFPOutcome(forwardPrediction.predictionId, trace);
          if (fpOutcome) {
            const brierScore = await deps.forwardPredictor.recordOutcome(fpOutcome);
            deps.bus?.emit('prediction:calibration', { taskId: input.id, brierScore });
            // C4: Miscalibration alert when Brier exceeds threshold
            if (brierScore > 1.0) {
              deps.bus?.emit('prediction:miscalibrated', { taskId: input.id, brierScore, threshold: 1.0 });
            }

            // Tier 3 edge weight feedback: extract edge observations from causal chain
            if (forwardPrediction.causalRiskFiles.length > 0) {
              const brokeTarget = fpOutcome.actualTestResult !== 'pass';
              const edgeObs = forwardPrediction.causalRiskFiles.flatMap((risk) =>
                risk.causalChain.map((link) => ({
                  edgeType: link.edgeType,
                  brokeTarget,
                })),
              );
              if (edgeObs.length > 0) {
                deps.forwardPredictor.updateEdgeWeights(edgeObs);
              }
            }
          }
        } catch {
          /* FP calibration failure — non-critical */
        }
      }

      // K2: Record provider trust outcome for Wilson LB selection
      if (deps.providerTrustStore && routing.model) {
        try {
          deps.providerTrustStore.recordOutcome(routing.model, trace.outcome === 'success');
        } catch {
          /* Trust recording failure — non-critical */
        }
      }

      // PH6: Compress transcript into trace for storage (Step 43)
      if (isAgenticResult && lastAgentResult?.transcript?.length) {
        try {
          const transcriptJson = JSON.stringify(lastAgentResult.transcript);
          trace.transcriptGzip = Bun.gzipSync(Buffer.from(transcriptJson));
          trace.transcriptTurns = lastAgentResult.transcript.length;
        } catch {
          // Best-effort — don't fail the trace record
        }
      }
      // ── STU Phase D: Record understanding snapshot for A7 calibration ──
      trace.understandingDepth = understanding.understandingDepth;
      trace.understandingIntent = understanding.semanticIntent
        ? JSON.stringify(understanding.semanticIntent)
        : undefined;
      trace.resolvedEntities =
        understanding.resolvedEntities.length > 0 ? JSON.stringify(understanding.resolvedEntities) : undefined;
      trace.understandingVerified =
        understanding.verifiedClaims.length > 0
          ? understanding.verifiedClaims.every((c) => c.type === 'known')
            ? 1
            : 0
          : undefined;
      trace.understandingPrimaryAction = understanding.semanticIntent?.primaryAction;

      await deps.traceCollector.record(trace);
      deps.bus?.emit('trace:record', { trace });

      // shouldContinue: confidence decision requires retry (escalate / re-verify failure / refuse)
      if (shouldContinue) continue;

      // ── SUCCESS → return result ──────────────────────────────────
      if (shouldCommit || trace.outcome === 'success') {
        // ── WP-2: LLM-as-Critic (semantic verification at L2+) ──────
        // A1: critic is a separate LLM call from the generator
        // Skip critic for zero-mutation tasks — nothing to review
        if (deps.criticEngine && routing.level >= 2 && workerResult.mutations.length > 0) {
          try {
            const proposal = {
              mutations: workerResult.mutations,
              approach: trace.approach,
            };
            const criticResult = await deps.criticEngine.review(proposal, input, perception, input.acceptanceCriteria);
            deps.bus?.emit('critic:verdict', {
              taskId: input.id,
              accepted: criticResult.approved,
              confidence: criticResult.confidence,
              reason: criticResult.reason,
            });
            if (!criticResult.approved) {
              const criticReason = criticResult.reason ?? 'Critic rejected proposal';
              workingMemory.recordFailedApproach(
                trace.approach,
                `critic: ${criticReason}`,
                criticResult.confidence,
                'critic',
              );
              continue; // retry within routing level
            }

            // ── EHD Phase 2: Recompute pipeline confidence WITH critic dimension ──
            if (criticResult.confidence !== undefined && routing.level > 0) {
              pipelineConf = computePipelineConfidence({
                prediction: predictionConfidence,
                metaPrediction: metaPredictionConfidence,
                verification: verificationConfidence,
                critic: criticResult.confidence,
              });
              confidenceDecision = deriveConfidenceDecision(pipelineConf.composite);

              // Update trace with critic-enriched pipeline confidence
              trace.confidenceDecision = {
                action: confidenceDecision,
                confidence: pipelineConf.composite,
                reason: pipelineConf.formula,
              };
              trace.pipelineConfidence = {
                composite: pipelineConf.composite,
                formula: pipelineConf.formula,
              };
            }
          } catch (criticError) {
            // A3: Critic failure → fail-closed at L2+ (governance must not silently degrade)
            deps.bus?.emit('critic:verdict', {
              taskId: input.id,
              accepted: false,
              confidence: 0,
              reason: `Critic engine error: ${criticError instanceof Error ? criticError.message : String(criticError)}`,
            });
            workingMemory.recordFailedApproach(
              trace.approach,
              `critic-error: ${criticError instanceof Error ? criticError.message : String(criticError)}`,
              0,
              'critic',
            );
            continue; // retry within routing level
          }
        }

        // ── WP-3: TestGenerator — generative verification at L2+ (§17.7) ────
        // A1: test generation is a separate LLM call from the generator
        // Skip test generation for zero-mutation tasks — nothing to test
        if (deps.testGenerator && routing.level >= 2 && workerResult.mutations.length > 0) {
          try {
            const testGenResult = await deps.testGenerator.generateAndRun(
              { mutations: workerResult.mutations, approach: trace.approach },
              perception,
            );
            if (testGenResult.failures.length > 0) {
              const failNames = testGenResult.failures.map((f) => f.name).join(', ');
              workingMemory.recordFailedApproach(
                trace.approach,
                `test-gen: ${testGenResult.failures.length} generated test(s) failed: ${failNames}`,
                undefined,
                'test-gen',
              );
              continue; // retry within routing level
            }
          } catch (testGenError) {
            deps.bus?.emit('testgen:error', {
              taskId: input.id,
              error: testGenError instanceof Error ? testGenError.message : String(testGenError),
            });
            // Non-blocking: structural oracles + critic already passed
          }
        }

        // ── I10: Probation workers cannot commit — shadow-only ──────
        if (deps.workerStore && routing.workerId) {
          const workerProfile = deps.workerStore.findById(routing.workerId);
          if (workerProfile?.status === 'probation') {
            // Enqueue as shadow for evaluation, do NOT commit
            if (deps.shadowRunner) {
              const job = deps.shadowRunner.enqueue(
                input.id,
                workerResult.mutations.map((m) => ({ file: m.file, content: m.content })),
              );
              deps.bus?.emit('shadow:enqueue', { job });

              // PH4.2: Shadow validation with alternative worker for comparison (20% sample)
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
                    /* fire-and-forget — A6 compliance */
                  });
              }
            }
            const probationResult: TaskResult = {
              id: input.id,
              status: 'completed',
              mutations: [],
              trace: { ...trace, outcome: 'success' as const },
              notes: ['probation-shadow-only: I10 — probation worker result not committed'],
            };
            deps.bus?.emit('task:complete', { result: probationResult });
            return probationResult;
          }
        }

        // ── Commit verified mutations to workspace ──────────────────
        let commitResult: { applied: string[]; rejected: Array<{ path: string; reason: string }> } | undefined;
        if (deps.workspace && workerResult.mutations.length > 0) {
          commitResult = commitArtifacts(
            deps.workspace,
            workerResult.mutations.map((m) => ({ path: m.file, content: m.content })),
          );
          if (commitResult.rejected.length > 0) {
            deps.bus?.emit('commit:rejected', {
              taskId: input.id,
              rejected: commitResult.rejected,
            });
          }
        }

        // ── A4: Commit verified oracle verdicts as World Graph facts ────
        if (deps.worldGraph && deps.workspace && commitResult && commitResult.applied.length > 0) {
          // Compute conservative validUntil from oracle temporal contexts
          const validUntils = Object.values(verification.verdicts)
            .filter((v) => v.temporalContext?.validUntil)
            .map((v) => v.temporalContext!.validUntil);
          const factValidUntil = validUntils.length > 0 ? Math.min(...validUntils) : undefined;
          // Derive decay model from oracle verdicts — prefer exponential if any oracle uses it
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
                // M4 fix: use minimum oracle confidence instead of hardcoded 1.0
                confidence: computeFactConfidence(verification.verdicts),
                validUntil: factValidUntil,
                decayModel: factDecayModel,
                // P0: Propagate tier reliability from oracle confidence
                tierReliability: (() => {
                  const conf = computeFactConfidence(verification.verdicts);
                  return conf >= 0.95 ? 1.0 : conf >= 0.7 ? 0.8 : 0.5;
                })(),
              });
            }
          } catch {
            // WorldGraph fact commitment is best-effort — does not block task completion
          }
        }

        // Filter mutations to only those actually committed (A6: rejected paths excluded)
        const appliedSet = commitResult
          ? new Set(commitResult.applied)
          : new Set(workerResult.mutations.map((m) => m.file));
        const appliedMutations = workerResult.mutations.filter((m) => appliedSet.has(m.file));
        const allRejected = commitResult && commitResult.applied.length === 0 && commitResult.rejected.length > 0;

        // Surface contradiction state if oracles disagreed
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
          trace,
          qualityScore,
          answer: workerResult.proposedContent,
          thinking: workerResult.thinking,
          notes: commitResult?.rejected.length
            ? [`Rejected files: ${commitResult.rejected.map((r) => `${r.path} (${r.reason})`).join(', ')}`]
            : undefined,
          contradictions,
        };
        // ── Shadow Enqueue (Phase 2.2) — A6 crash-safety ──────────
        if (deps.shadowRunner && routing.level >= 2) {
          const job = deps.shadowRunner.enqueue(
            input.id,
            workerResult.mutations.map((m) => ({ file: m.file, content: m.content })),
          );
          trace.validationDepth = 'structural';
          deps.bus?.emit('shadow:enqueue', { job });
          // Fire-and-forget: process shadow job in background
          deps.shadowRunner
            .processNext()
            .then((result) => {
              if (result) {
                deps.bus?.emit('shadow:complete', { job, result });
              }
            })
            .catch((err) => {
              deps.bus?.emit('shadow:failed', { job, error: String(err) });
            });
        }

        // ── Skill outcome: success (H4) ──────────────────────────────
        if (matchedSkill && deps.skillManager) {
          deps.skillManager.recordOutcome(matchedSkill, true);
          deps.bus?.emit('skill:outcome', { taskId: input.id, skill: matchedSkill, success: true });
        }

        // G2: Serialize remaining failed approaches to rejected_approaches table (source='task-end')
        serializeApproachesToStore(workingMemory, input, deps);

        deps.bus?.emit('task:complete', { result: successResult });
        return successResult;
      }

      // ── FAILURE → record in working memory, retry ────────────────
      workingMemory.recordFailedApproach(
        trace.approach,
        verification.reason ?? 'unknown',
        verificationConfidence,
        failedOracles[0],
      );

      // G5: Archive failed verdicts to World Graph for cross-task visibility
      if (deps.worldGraph && failedOracles.length > 0) {
        try {
          for (const oracleName of failedOracles) {
            deps.worldGraph.storeFailedVerdict({
              target: input.targetFiles?.[0] ?? input.id,
              pattern: trace.approach,
              oracleName,
              verdict: verification.reason ?? 'unknown',
              confidence: verificationConfidence,
              fileHash: undefined, // file not yet committed on failure path
              sessionId: undefined,
            });
          }
        } catch {
          // Failed verdict archival is best-effort — does not block retry
        }
      }

      // G3: Emit context:verdict_omitted for failed oracle verdicts
      // These verdicts won't be in the worker's next context unless explicitly propagated
      for (const oracleName of failedOracles) {
        deps.bus?.emit('context:verdict_omitted', {
          taskId: input.id,
          oracleName,
          reason: 'Oracle verdict available but not propagated to worker context on retry',
        });
      }

      // ── Skill outcome: failure (H4) ──────────────────────────────
      if (matchedSkill && deps.skillManager) {
        deps.skillManager.recordOutcome(matchedSkill, false);
        deps.bus?.emit('skill:outcome', { taskId: input.id, skill: matchedSkill, success: false });
        matchedSkill = null; // don't record again on retry
      }
    }

    // ── RETRY EXHAUSTED → escalate routing level ─────────────────
    const nextLevel = (routing.level + 1) as RoutingLevel;
    // Domain-aware cap: conversational tasks stop at L1 (no L2+ escalation)
    const effectiveMaxLevel = understanding.taskDomain === 'conversational' ? MAX_CONVERSATIONAL_LEVEL : MAX_ROUTING_LEVEL;
    if (nextLevel > effectiveMaxLevel) break;

    deps.bus?.emit('task:escalate', {
      taskId: input.id,
      fromLevel: routing.level,
      toLevel: nextLevel,
      reason: `Exhausted ${input.budget.maxRetries} retries at L${routing.level}`,
    });

    routing = await deps.riskRouter.assessInitialLevel({
      ...input,
      // Force minimum routing level to next level
      constraints: [...(input.constraints ?? []), `MIN_ROUTING_LEVEL:${nextLevel}`],
    });
  }

  // ── ALL LEVELS EXHAUSTED → escalate to human ───────────────────
  const escalationTrace: ExecutionTrace = {
    id: `trace-${input.id}-escalation`,
    taskId: input.id,
    workerId: routing.workerId ?? routing.model ?? 'unknown',
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
    // P1: Serialize working memory failed approaches for cross-task learning
    failedApproaches: workingMemory.getSnapshot().failedApproaches.map(fa => ({
      approach: fa.approach,
      oracleVerdict: fa.oracleVerdict,
      verdictConfidence: fa.verdictConfidence,
      failureOracle: fa.failureOracle,
    })),
  };

  // G2: Serialize remaining failed approaches to rejected_approaches table (source='task-end')
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
  return escalationResult;
}

/** G2: Serialize all remaining failed approaches from working memory to the rejected_approaches store.
 *  Called at task completion (both success and escalation). Best-effort — does not block. */
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
      // Best-effort — continue with remaining entries
    }
  }
}

/**
 * Compute fact confidence from oracle verdicts — use minimum of passing oracle confidences.
 * M4 fix: WG facts must not be stored at 1.0 when oracles produced lower confidence scores.
 * Minimum is the most conservative choice — WG fact confidence = weakest verification link.
 */
function computeFactConfidence(allVerdicts: Record<string, import('../core/types.ts').OracleVerdict>): number {
  const passingConfidences = Object.values(allVerdicts)
    .filter((v) => v.verified)
    .map((v) => v.confidence);
  if (passingConfidences.length === 0) return 0;
  return Math.min(...passingConfidences);
}
