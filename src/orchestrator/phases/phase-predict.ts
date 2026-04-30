/**
 * Predict Phase — Step 2 of the Orchestrator lifecycle.
 *
 * Runs SelfModel prediction, ForwardPredictor, prediction-based escalation,
 * reasoning policy, thinking policy compilation, and worker selection.
 */

import { applyPredictionEscalation, withLevel } from '../../gate/risk-router.ts';
import { buildPersonaBidContext } from '../agents/persona-context-builder.ts';
import { applyRoutingGovernance } from '../governance-provenance.ts';
import type { LLMProviderRegistry } from '../llm/provider-registry.ts';
import type {
  EngineSelectionResult,
  PerceptualHierarchy,
  RoutingDecision,
  RoutingLevel,
  SemanticTaskUnderstanding,
  TaskResult,
} from '../types.ts';
import type { PhaseContext, PhaseContinue, PhaseReturn, PredictResult } from './types.ts';
import { Phase } from './types.ts';

/**
 * Refresh `routing.model` to the actual provider id resolvable in the live
 * LLM registry. See the long-form rationale at the call site in
 * `executePredictPhase`. Pure function — exported so the resolution
 * contract can be unit-tested without spinning up a full PhaseContext.
 *
 * Resolution order matches `worker-pool.dispatch` so phase-predict's view
 * of the executable engine is the same one the dispatch path picks:
 *   1. routing.workerId   — fleet profile id (if set)
 *   2. routing.model      — engine id pinned by engineSelector / prior phase
 *   3. selectForRoutingLevel(level) — tier default
 *
 * Returns an updated routing when the resolved provider's id differs from
 * what's currently in `routing.model`. Returns the input routing unchanged
 * when the registry has no candidate (L0 / unwired registry / no providers
 * for this tier) — leaving the cosmetic tier label intact so error paths
 * still emit a human-readable hint about which tier was attempted.
 */
export function resolveExecutableProviderId(
  routing: RoutingDecision,
  registry: LLMProviderRegistry | undefined,
): RoutingDecision {
  if (!registry) return routing;
  const candidate =
    (routing.workerId ? registry.selectById(routing.workerId) : undefined) ??
    (routing.model ? registry.selectById(routing.model) : undefined) ??
    registry.selectForRoutingLevel(routing.level);
  if (!candidate) return routing;
  if (candidate.id === routing.model) return routing;
  return { ...routing, model: candidate.id };
}

export async function executePredictPhase(
  ctx: PhaseContext,
  routing: RoutingDecision,
  perception: PerceptualHierarchy,
  understanding: SemanticTaskUnderstanding,
): Promise<PhaseContinue<PredictResult> | PhaseReturn> {
  const { input, deps, startTime } = ctx;

  let prediction: PredictResult['prediction'];
  let predictionConfidence: number | undefined;
  let metaPredictionConfidence: number | undefined;
  let forwardPrediction: PredictResult['forwardPrediction'];

  // ── Step 2: PREDICT (L2+ only) ───────────────────────────────
  if (routing.level >= 2) {
    prediction = await deps.selfModel.predict(input, perception);
    deps.bus?.emit('selfmodel:predict', { prediction });

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
      routing = withLevel(routing, prediction.forceMinLevel as RoutingLevel);
    }
  }

  // ── EO #6: Attach reasoning policy (Self-Model calibrated budget split) ──
  if (deps.selfModel.getReasoningPolicy) {
    const { computeTaskSignature } = await import('../prediction/self-model.ts');
    const taskSig = computeTaskSignature(input);
    routing = { ...routing, reasoningPolicy: deps.selfModel.getReasoningPolicy(taskSig) };
  }

  // ── Step 2½a: COMPILE THINKING POLICY (Extensible Thinking Phase 2.1) ──
  if (deps.thinkingPolicyCompiler) {
    const { computeTaskUncertainty } = await import('../thinking/uncertainty-computer.ts');
    const { computeTaskSignature } = await import('../prediction/self-model.ts');
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

    const compiledThinking = compiledPolicy.thinking;
    const shouldKeepRouting = compiledThinking.type === 'disabled' && routing.thinkingConfig?.type !== 'disabled';
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
  let workerSelection: EngineSelectionResult | undefined;
  if (deps.workerSelector && !routing.workerId) {
    const { computeFingerprint } = await import('../task-fingerprint.ts');
    const fingerprint = computeFingerprint(input, perception, {
      traceCount: deps.traceCollector.getTraceCount?.() ?? 0,
    });
    const selection = deps.workerSelector.selectWorker(
      fingerprint,
      routing.level,
      { maxTokens: input.budget.maxTokens, timeoutMs: input.budget.maxDurationMs },
      undefined,
      input.id,
      routing.isEscalated,
    );
    workerSelection = selection;

    // A2: Fleet-level uncertainty — all workers below capability threshold
    if (selection.isUncertain) {
      // PH5.8: Try cross-instance delegation before giving up
      if (deps.instanceCoordinator?.canDelegate(input, fingerprint)) {
        const delegation = await deps.instanceCoordinator.delegate(input, fingerprint);
        if (delegation.delegated && delegation.result) {
          // I12: Re-verify delegated result locally
          if (delegation.result.mutations.length > 0 && deps.workspace) {
            const verifyMutations = delegation.result.mutations.map((m) => ({
              file: m.file,
              content: m.diff,
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
              return Phase.return(delegation.result);
            }
          } else {
            deps.bus?.emit('task:complete', { result: delegation.result });
            return Phase.return(delegation.result);
          }
        }
      }

      const uncertainTrace: import('../types.ts').ExecutionTrace = applyRoutingGovernance({
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
      }, routing);
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
      return Phase.return(uncertainResult);
    }

    if (selection.selectedWorkerId) {
      routing = { ...routing, workerId: selection.selectedWorkerId };
    }
  }

  // ── K2.2: Engine Selector — trust-weighted provider override ──
  if (deps.engineSelector) {
    // Pass the real task id (NOT a goal prefix) so auction allocation,
    // commitment-bridge lookup, volunteer-fallback, and `engine:selected`
    // events all key off `TaskInput.id`. `taskType` flows through
    // SelectOptions for cost prediction / auction scoring.
    //
    // Phase-4 wiring activation: when an agent is resolved for this task and
    // the registry can derive its skill loadout, build a PersonaBidContext so
    // every generated bid carries the persona id, loaded skill ids, declared
    // capabilities, and prompt-overhead estimate. The auction's Phase-3
    // `skillMatch` factor consumes these — without this wiring it stays
    // 1.0 and persona-aware scoring is dead.
    // `capabilityRequirements` rides on TaskUnderstanding's passthrough index
    // signature (see `TaskUnderstanding[key: string]: unknown`). When the
    // intent resolver populated it, the runtime shape matches CapabilityRequirement[];
    // when it didn't, the cast resolves to undefined and Phase-3 skillMatch
    // defaults to 1.0. Either way no LLM is in this code path — A3.
    const requirements = understanding.capabilityRequirements as
      | import('../types.ts').CapabilityRequirement[]
      | undefined;
    const personaContext = deps.agentRegistry
      ? buildPersonaBidContext(deps.agentRegistry, input.agentId, requirements)
      : null;
    const engineSelection = deps.engineSelector.select(routing.level, input.id, undefined, undefined, {
      taskType: input.taskType,
      personaContext: personaContext ?? undefined,
    });
    if (engineSelection.provider !== 'unknown') {
      routing = { ...routing, model: engineSelection.provider };
      deps.bus?.emit('engine:selected', {
        taskId: input.id,
        provider: engineSelection.provider,
        trustScore: engineSelection.trustScore,
        reason: engineSelection.selectionReason,
      });
    }
  }

  // ── Refresh `routing.model` to the executable provider id ──────────
  //
  // `LEVEL_CONFIG[level].model` in `risk-router.ts` seeds `routing.model`
  // with a tier-label hint (e.g. `'claude-haiku'` for L1) — useful as a
  // routing default but NOT a real provider id. Under an OpenRouter setup
  // (`OPENROUTER_FAST_MODEL=...`) the registered provider id is something
  // like `openrouter/fast/google/gemma-...` and the cosmetic `claude-haiku`
  // label never matches anything in the registry. Without this refresh,
  // `routing.model` flows through every downstream consumer (CLI display,
  // `core-loop`'s `modelUsed` trace, `phase-learn`'s
  // `providerTrustStore.recordOutcome`, `worker-pool`'s engine lookup) as
  // if the run used Haiku — a telemetry lie that also corrupts the trust
  // ledger because outcomes get recorded against the cosmetic label.
  routing = resolveExecutableProviderId(routing, deps.llmRegistry);

  return Phase.continue({
    prediction,
    predictionConfidence,
    metaPredictionConfidence,
    forwardPrediction,
    routing,
    workerSelection,
  });
}
