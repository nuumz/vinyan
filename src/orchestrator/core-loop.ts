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
import { executeGeneratePhase } from './phases/phase-generate.ts';
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
    conversationHistory?: import('./types.ts').ConversationEntry[],
  ): Promise<import('./phases/types.ts').WorkerResult>;
  /** Returns agent loop deps if configured (Phase 6.3+), null otherwise. */
  getAgentLoopDeps?(): import('./worker/agent-loop.ts').AgentLoopDeps | null;
}

export interface OracleGate {
  verify(
    mutations: Array<{ file: string; content: string }>,
    workspace: string,
    verificationHint?: import('./types.ts').VerificationHint,
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
  // Phase 7 — Self-Improving Autonomy.
  /** Per-engine EMA accuracy calibrator. Optional; phase-learn updates it on every trace. */
  oracleEMACalibrator?: import('./phase7/oracle-ema-calibrator.ts').OracleEMACalibrator;
  /** Silent-regression watchdog. Optional; phase-learn feeds task outcomes into it per trace. */
  regressionMonitor?: import('./phase7/regression-monitor.ts').RegressionMonitor;
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
): Promise<
  | {
      understanding: SemanticTaskUnderstanding;
      routing: RoutingDecision;
      workingMemory: WorkingMemory;
      explorationFlag: boolean;
      intentResolution?: IntentResolution;
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
  const understanding = enrichUnderstanding(input, {
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

  // ── LLM Intent Resolution — semantic classification before pipeline ──
  // Skip for code-mutation tasks (already well-classified by regex) and tasks with explicit target files.
  const needsIntentResolution =
    deps.llmRegistry && understanding.taskDomain !== 'code-mutation' && !input.targetFiles?.length;
  let intentResolution: IntentResolution | undefined;
  if (needsIntentResolution && deps.llmRegistry) {
    try {
      const { resolveIntent } = await import('./intent-resolver.ts');
      intentResolution = await resolveIntent(input, {
        registry: deps.llmRegistry,
        availableTools: deps.toolExecutor?.getToolNames(),
        bus: deps.bus,
      });
      deps.bus?.emit('intent:resolved', {
        taskId: input.id,
        strategy: intentResolution.strategy,
        confidence: intentResolution.confidence,
        reasoning: intentResolution.reasoning,
      });
    } catch (err) {
      // Intent resolution failure is non-fatal — fall back to regex-based classification
      const reason = err instanceof Error ? err.message : String(err);
      const { fallbackStrategy } = await import('./intent-resolver.ts');
      const strategy = fallbackStrategy(
        understanding.taskDomain,
        understanding.taskIntent,
        understanding.toolRequirement,
      );
      intentResolution = {
        strategy,
        refinedGoal: input.goal,
        confidence: 0.5,
        reasoning: `Fallback: regex-based (${reason})`,
      };
      deps.bus?.emit('intent:resolved', {
        taskId: input.id,
        strategy: intentResolution.strategy,
        confidence: intentResolution.confidence,
        reasoning: intentResolution.reasoning,
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
  const workingMemory = new WorkingMemory({ bus: deps.bus, taskId: input.id, archiver });

  // Session memory: hydrate from prior turns (A7: cross-turn learning)
  if (input.sessionId && deps.sessionManager) {
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
    } catch {
      // Session memory hydration is best-effort
    }
  }

  // Cross-task learning: load prior failed approaches
  if (deps.rejectedApproachStore && input.targetFiles?.length) {
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
    } catch {
      // Cross-task loading is best-effort
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

  return { understanding, routing, workingMemory, explorationFlag, intentResolution };
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
  let answer = intent.refinedGoal;
  if (provider) {
    try {
      const response = await provider.generate({
        systemPrompt: `You are Vinyan, a friendly assistant. Respond naturally and briefly. Match the user's language.
Never reveal your underlying model name or provider — you are Vinyan.
Do NOT use JSON, code blocks, or LaTeX formatting.
Do NOT narrate your reasoning process — just respond directly to the user.`,
        userPrompt: input.goal,
        maxTokens: 1000,
        temperature: 0.3,
      });
      answer = response.content;
    } catch {
      answer = intent.refinedGoal;
    }
  }
  const trace: ExecutionTrace = {
    id: `trace-${input.id}-conversational`,
    taskId: input.id,
    workerId: 'intent-resolver',
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
      const analysis = classifyToolFailure(exitCode, toolResult.error);

      deps.bus?.emit('tool:failure_classified', {
        taskId: input.id,
        type: analysis.type,
        recoverable: analysis.recoverable,
        error: toolResult.error,
      });

      // Step 1: Deterministic app discovery (no LLM, fast)
      if (analysis.type === 'not_found' && intent.directToolCall?.tool === 'shell_exec') {
        const { discoverApp } = await import('./tools/direct-tool-resolver.ts');
        const command = (toolCall.parameters.command as string) ?? '';
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
        const command = (toolCall.parameters.command as string) ?? '';
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
    const answer =
      toolResult?.status === 'success'
        ? typeof toolResult.output === 'string'
          ? toolResult.output
          : JSON.stringify(toolResult.output)
        : (toolResult?.error ?? 'Tool execution failed');

    // Guard: if tool "succeeded" but produced no meaningful output, fall through
    // to the pipeline — the direct-tool shortcircuit didn't actually answer the user.
    if (toolResult?.status === 'success' && (!answer || !answer.trim())) {
      return null;
    }

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
 * Outer loop: escalate routing level on repeated failure (L0 → L1 → L2 → L3 → human)
 * Inner loop: retry within routing level (up to budget.maxRetries)
 */
export async function executeTask(input: TaskInput, deps: OrchestratorDeps): Promise<TaskResult> {
  const prep = await prepareExecution(input, deps);
  if ('status' in prep) return prep; // Early return (security rejection or budget block)

  // ── Strategy routing — short-circuit non-pipeline strategies ──
  const intentResolution = prep.intentResolution;
  if (intentResolution) {
    if (intentResolution.strategy === 'conversational') {
      return buildConversationalResult(input, intentResolution, deps);
    }
    // Direct-tool: use deterministic resolver to generate platform-correct command (A3)
    if (intentResolution.strategy === 'direct-tool') {
      const { classifyDirectTool, resolveCommand } = await import('./tools/direct-tool-resolver.ts');
      const classification = classifyDirectTool(input.goal);
      if (classification && classification.confidence >= 0.7) {
        const command = resolveCommand(classification, process.platform);
        if (command) {
          intentResolution.directToolCall = { tool: 'shell_exec', parameters: { command } };
        }
      }
    }
    if (intentResolution.strategy === 'direct-tool' && intentResolution.directToolCall) {
      const directResult = await executeDirectTool(input, intentResolution, deps);
      if (directResult) return directResult;
      // Fall through to pipeline if direct tool execution failed
    }
    if (intentResolution.strategy === 'agentic-workflow' && intentResolution.workflowPrompt) {
      // Rewrite goal with the LLM-generated workflow prompt for maximum downstream quality
      input = { ...input, goal: intentResolution.workflowPrompt };
    }
  }
  // 'full-pipeline' or failed resolution → existing 6-phase loop

  let { understanding, routing } = prep;
  const { workingMemory, explorationFlag } = prep;

  // Agentic-workflow requires tool access → minimum L2 (L0-L1 have 0 tool calls)
  if (intentResolution?.strategy === 'agentic-workflow' && routing.level < 2) {
    const { LEVEL_CONFIG } = await import('../gate/risk-router.ts');
    const l2 = LEVEL_CONFIG[2];
    routing = {
      ...routing,
      level: 2,
      model: routing.model ?? l2.model,
      budgetTokens: Math.max(routing.budgetTokens, l2.budgetTokens),
      latencyBudgetMs: Math.max(routing.latencyBudgetMs, l2.latencyBudgetMs),
    };
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

  let lastWorkerSelection: import('./types.ts').WorkerSelectionResult | undefined;
  const BUDGET_CAP_MULTIPLIER = 6;
  let totalTokensConsumed = 0;
  const MAX_CONVERSATIONAL_LEVEL = 1 as RoutingLevel;

  const ctx: PhaseContext = {
    input,
    deps,
    startTime,
    workingMemory,
    explorationFlag,
    conversationHistory,
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
        const timeoutResult: TaskResult = { id: input.id, status: 'failed', mutations: [], trace: timeoutTrace };
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

          deps.bus?.emit('agent:clarification_requested', {
            taskId: input.id,
            sessionId: input.sessionId,
            questions: [...verdict.questions],
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
      const { plan } = planOutcome.value;

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
      const { workerResult, isAgenticResult, lastAgentResult, dagResult, mutatingToolCalls } = generateOutcome.value;
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
        deps.bus?.emit('agent:clarification_requested', {
          taskId: input.id,
          sessionId: input.sessionId,
          questions: [...lastAgentResult.uncertainties],
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
      const { verification, passedOracles, failedOracles, verificationConfidence, qualityScore, shouldCommit, trace } =
        verifyOutcome.value;

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
              const { computePipelineConfidence, deriveConfidenceDecision } = await import('./pipeline-confidence.ts');
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
