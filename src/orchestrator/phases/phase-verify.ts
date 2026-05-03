/**
 * Verify Phase — Step 5 of the Orchestrator lifecycle.
 *
 * Runs oracle verification, detects contradictions, handles deliberation
 * requests, computes quality score and pipeline confidence, and routes
 * the confidence decision (allow / re-verify / escalate / refuse).
 */

import { emitAuditEntry } from '../../core/audit-emit.ts';
import { buildComplexityContext, computeQualityScore } from '../../gate/quality-score.ts';
import { withLevel } from '../../gate/risk-router.ts';
import type { WorkerLoopResult } from '../agent/agent-loop.ts';
import type { DAGExecutionResult } from '../dag-executor.ts';
import { classifyAllFailures } from '../failure-classifier.ts';
import type { OutcomePrediction } from '../forward-predictor-types.ts';
import { buildShortCircuitProvenance } from '../governance-provenance.ts';
import { hierarchyFromInput } from '../observability/audit-hierarchy.ts';
import { deriveOracleIndependenceAudit } from '../oracle-independence.ts';
import {
  type ConfidenceDecision,
  computePipelineConfidence,
  deriveConfidenceDecision,
  PIPELINE_THRESHOLDS,
} from '../pipeline-confidence.ts';
import type {
  EngineSelectionResult,
  ExecutionTrace,
  GovernanceEvidenceReference,
  GovernanceProvenance,
  PerceptualHierarchy,
  RoutingDecision,
  RoutingLevel,
  SelfModelPrediction,
  SemanticTaskUnderstanding,
  TaskDAG,
  TaskInput,
  TaskResult,
  VerificationHint,
} from '../types.ts';
import { buildAgentSessionSummary, mergeForwardAndSelfModel } from './generate-helpers.ts';
import type {
  PhaseContext,
  PhaseContinue,
  PhaseEscalate,
  PhaseReturn,
  VerificationResult,
  VerifyResult,
  WorkerResult,
} from './types.ts';
import { Phase } from './types.ts';

interface VerifyInput {
  routing: RoutingDecision;
  perception: PerceptualHierarchy;
  understanding: SemanticTaskUnderstanding;
  plan: TaskDAG | undefined;
  workerResult: WorkerResult;
  isAgenticResult: boolean;
  lastAgentResult: WorkerLoopResult | null;
  dagResult: DAGExecutionResult | null;
  prediction?: SelfModelPrediction;
  predictionConfidence?: number;
  metaPredictionConfidence?: number;
  forwardPrediction?: OutcomePrediction;
  workerSelection?: EngineSelectionResult;
  lastWorkerSelection?: EngineSelectionResult;
  matchedSkill: import('../types.ts').CachedSkill | null;
  retry: number;
  /** R2: when generate dispatched via Room, carries the roomId for trace tagging. */
  roomId?: string;
}

function buildVerificationProvenance(
  input: TaskInput,
  routing: RoutingDecision,
  args: {
    decisionId: string;
    reason: string;
    evidence: GovernanceEvidenceReference[];
  },
): GovernanceProvenance {
  const provenance = buildShortCircuitProvenance({
    input,
    decisionId: args.decisionId,
    attributedTo: 'verificationPolicy',
    wasGeneratedBy: 'executeVerifyPhase',
    reason: args.reason,
    evidence: args.evidence,
  });
  if (routing.governanceProvenance?.escalationPath) {
    provenance.escalationPath = routing.governanceProvenance.escalationPath;
  }
  return provenance;
}

function buildOraclePairEvidence(
  passedOracles: readonly string[],
  failedOracles: readonly string[],
  verificationReason?: string,
): GovernanceEvidenceReference[] {
  return [
    {
      kind: 'oracle-verdict',
      source: 'oracle-contradiction-pair',
      summary: `passed=${passedOracles[0] ?? 'none'}; failed=${failedOracles[0] ?? 'none'}; passedCount=${passedOracles.length}; failedCount=${failedOracles.length}`,
    },
    ...(verificationReason
      ? [{ kind: 'other' as const, source: 'verification-reason', summary: verificationReason }]
      : []),
  ];
}

export async function executeVerifyPhase(
  ctx: PhaseContext,
  vi: VerifyInput,
): Promise<PhaseContinue<VerifyResult> | PhaseReturn | PhaseEscalate> {
  const { input, deps, startTime, workingMemory, explorationFlag } = ctx;
  const {
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
    retry,
    roomId,
  } = vi;
  const { matchedSkill } = vi;

  // ── Step 5: VERIFY (oracle gate) ─────────────────────────────
  // Build verification hint — per-node merge for DAG, single-node for direct
  let activeHint: VerificationHint | undefined;
  if (dagResult && plan && plan.nodes.length > 1) {
    const nodeHints = plan.nodes.map((n) => n.verificationHint).filter(Boolean) as VerificationHint[];
    if (nodeHints.length > 0) {
      const allOracleSets = nodeHints.filter((h) => h.oracles).map((h) => h.oracles!);
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

  // M3.5 — Surface self-model signals for the CommonSense Oracle activation
  // gate. Built from `prediction` when available; absent when prediction was
  // skipped (e.g., L0 reflex path), in which case commonsense (if enabled)
  // fires unconditionally per gate.ts default.
  const commonsenseSignals =
    prediction && prediction.taskTypeSignature
      ? {
          taskTypeSignature: prediction.taskTypeSignature,
          observationCount: prediction.calibrationDataPoints,
          predictionAccuracy: prediction.confidence,
        }
      : undefined;

  const verification: VerificationResult = await deps.oracleGate.verify(
    workerResult.mutations.map((m) => ({ file: m.file, content: m.content })),
    input.targetFiles?.[0] ?? '.',
    activeHint,
    routing.level,
    commonsenseSignals,
  );

  // ── Emit per-oracle verdicts ──────────────────────────────────
  const passedOracles: string[] = [];
  const failedOracles: string[] = [];
  for (const [oracleName, verdict] of Object.entries(verification.verdicts)) {
    deps.bus?.emit('oracle:verdict', { taskId: input.id, oracleName, verdict });
    emitAuditEntry({
      bus: deps.bus,
      taskId: input.id,
      ...hierarchyFromInput(input),
      actor: { type: 'oracle', id: oracleName },
      variant: {
        kind: 'verdict',
        source: 'oracle',
        pass: verdict.verified,
        ...(typeof verdict.confidence === 'number' ? { confidence: verdict.confidence } : {}),
        ...(verdict.falsifiableBy ? { falsifiableBy: verdict.falsifiableBy } : {}),
        oracleId: oracleName,
      },
    });
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

    // K1.1: Auto-escalate on contradiction
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
      return Phase.escalate(withLevel(routing, toLevel));
    }

    // L3 contradiction: nowhere to escalate — terminal failure
    deps.bus?.emit('verification:contradiction_unresolved', {
      taskId: input.id,
      passed: passedOracles,
      failed: failedOracles,
    });
    const verdictBooleans: Record<string, boolean> = {};
    for (const [name, v] of Object.entries(verification.verdicts)) {
      verdictBooleans[name] = v.verified;
    }
    const contradictionReason = `Unresolved oracle contradiction at L${routing.level}: passed=[${passedOracles}] failed=[${failedOracles}]`;
    const contradictionTrace: ExecutionTrace = {
      id: `trace-${input.id}-contradiction`,
      taskId: input.id,
      workerId: routing.workerId ?? routing.model ?? 'unknown',
      agentId: input.agentId,
      timestamp: Date.now(),
      routingLevel: routing.level,
      approach: 'contradiction-unresolved',
      oracleVerdicts: verdictBooleans,
      modelUsed: routing.model ?? 'none',
      tokensConsumed: 0,
      durationMs: Date.now() - startTime,
      outcome: 'failure',
      failureReason: contradictionReason,
      affectedFiles: input.targetFiles ?? [],
      governanceProvenance: buildVerificationProvenance(input, routing, {
        decisionId: 'contradiction-unresolved',
        reason: contradictionReason,
        evidence: buildOraclePairEvidence(passedOracles, failedOracles, verification.reason),
      }),
    };
    await deps.traceCollector.record(contradictionTrace);
    return Phase.return({
      id: input.id,
      status: 'failed',
      mutations: [],
      trace: contradictionTrace,
      contradictions: [`Unresolved at L${routing.level}: passed=[${passedOracles}] failed=[${failedOracles}]`],
    });
  }

  // ── ECP §7.3: Surface deliberation requests from oracles (A2) ──
  let deliberationBonusRetries = 0;
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
  if (deliberationRequested) {
    deliberationBonusRetries = Math.min(deliberationBonusRetries + 1, input.budget.maxRetries);
    if (routing.level < 2) {
      const fromLevel = routing.level;
      deps.bus?.emit('task:escalate', {
        taskId: input.id,
        fromLevel,
        toLevel: (routing.level + 1) as RoutingLevel,
        reason: 'deliberation_request',
      });
    }
  }

  // ── Oracle failure pattern ──
  const oracleFailurePattern = failedOracles.length > 0 ? failedOracles.sort().join('+') : undefined;

  // ── Compute QualityScore ──
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

  // ── Pipeline confidence (L1+ only) ──────────────────────────
  let verificationConfidence = verification.aggregateConfidence ?? (verification.passed ? 0.85 : 0.3);

  // ── HMS: Hallucination Mitigation (A1: separate verification component) ──
  if (deps.hmsConfig?.enabled) {
    const { analyzeForHallucinations } = await import('../../hms/hms-feedback.ts');
    const { attenuateConfidence } = await import('../../hms/risk-scorer.ts');
    const hmsResult = analyzeForHallucinations(
      { mutations: workerResult.mutations },
      deps.workspace ?? process.cwd(),
      deps.hmsConfig,
    );
    if (hmsResult) {
      verificationConfidence = attenuateConfidence(verificationConfidence, hmsResult.risk);
      deps.bus?.emit('hms:risk_scored', {
        taskId: input.id,
        risk: hmsResult.risk.score,
        primary_signal: hmsResult.risk.primary_signal,
      });

      // Wave A: HMS blocking gate — when risk exceeds the configurable threshold,
      // BLOCK verification entirely (not just attenuate). Feeds classified failures
      // into working memory so the retry sees exactly which claims were hallucinated.
      const blocking = deps.hmsConfig.blocking;
      if (blocking?.enabled && hmsResult.risk.score >= blocking.threshold) {
        verification.passed = false;
        verification.reason = `HMS blocked: hallucination risk ${hmsResult.risk.score.toFixed(2)} >= ${blocking.threshold} (signal: ${hmsResult.risk.primary_signal})`;
        if (hmsResult.classifiedFailures?.length) {
          for (const failure of hmsResult.classifiedFailures) {
            workingMemory.recordFailedApproach(
              `[HMS] ${failure.category}: ${failure.message}${failure.file ? ` (${failure.file}:${failure.line ?? 0})` : ''}`,
              `hms-${failure.category}`,
            );
          }
        }
      }
    }
  }

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

  // ── Build trace ──────────────────────────────────────────────
  const { computeTaskSignature: computeSig } = await import('../prediction/self-model.ts');
  const taskTypeSignature = computeSig(input);
  const { detectFrameworkMarkers } = await import('../task-fingerprint.ts');
  const frameworkMarkers = detectFrameworkMarkers(perception);
  // R2: when the Generate phase used a Room, tag the trace for correlation.
  if (roomId) {
    frameworkMarkers.push(`room:${roomId}`);
  }

  const zeroMutationPass = workerResult.mutations.length === 0 && verification.passed;

  // L0 + oracle rejection (terminal): only short-circuit when the caller has
  // explicitly pinned routing to L0 via `MIN_ROUTING_LEVEL:0` — escalation is
  // not allowed by user contract, so we surface an immediate `'escalated'`
  // result instead of looping. Without that pin, fall through to the normal
  // failure→retry→escalate path so the routing loop iterates L1→L2→L3 (which
  // §16.4 criterion 3 requires).
  const l0Pinned = input.constraints?.some((c) => c === 'MIN_ROUTING_LEVEL:0');
  if (routing.level === 0 && !verification.passed && l0Pinned) {
    deps.bus?.emit('task:escalate', {
      taskId: input.id,
      fromLevel: routing.level,
      toLevel: (routing.level + 1) as RoutingLevel,
      reason: verification.reason ?? 'Oracle rejection at L0',
    });
    const l0Reason = verification.reason ?? 'Oracle rejection at L0';
    const escalatedTrace: ExecutionTrace = {
      id: `trace-${input.id}-${routing.level}-escalated`,
      taskId: input.id,
      workerId: routing.workerId ?? routing.model ?? 'unknown',
      agentId: input.agentId,
      timestamp: Date.now(),
      routingLevel: routing.level,
      approach: 'oracle-rejection-l0',
      oracleVerdicts: Object.fromEntries(Object.entries(verification.verdicts).map(([k, v]) => [k, v.verified])),
      modelUsed: routing.model ?? 'none',
      tokensConsumed: workerResult.tokensConsumed,
      durationMs: Date.now() - startTime,
      outcome: 'escalated',
      failureReason: l0Reason,
      affectedFiles: [],
      governanceProvenance: buildVerificationProvenance(input, routing, {
        decisionId: 'oracle-rejection-l0-pinned',
        reason: `${l0Reason}; MIN_ROUTING_LEVEL:0 prevents automatic escalation`,
        evidence: [
          {
            kind: 'policy',
            source: 'input.constraints',
            summary: 'MIN_ROUTING_LEVEL:0 set by caller',
          },
          ...buildOraclePairEvidence(passedOracles, failedOracles, verification.reason),
        ],
      }),
    };
    return Phase.return({
      id: input.id,
      status: 'escalated',
      mutations: [],
      trace: escalatedTrace,
      escalationReason: verification.reason ?? 'Oracle rejection at L0',
    } as TaskResult);
  }

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
    agentId: input.agentId,
    timestamp: Date.now(),
    routingLevel: routing.level,
    taskTypeSignature,
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
    mergedPPass: prediction && forwardPrediction ? mergeForwardAndSelfModel(prediction, forwardPrediction) : undefined,
    oracleFailurePattern,
    exploration: explorationFlag || undefined,
    workerSelectionAudit: workerSelection,
    frameworkMarkers: frameworkMarkers.length > 0 ? frameworkMarkers : undefined,
    verificationConfidence: routing.level > 0 ? verificationConfidence : undefined,
    epistemicDecision: verification.epistemicDecision,
    oracleIndependence: deriveOracleIndependenceAudit({
      verdicts: verification.verdicts,
      aggregateConfidence: verification.aggregateConfidence,
      passed: verification.passed,
    }),
    confidenceDecision: confidenceDecision
      ? { action: confidenceDecision, confidence: pipelineConf?.composite ?? 0, reason: pipelineConf?.formula }
      : undefined,
    pipelineConfidence: pipelineConf ? { composite: pipelineConf.composite, formula: pipelineConf.formula } : undefined,
    thinkingMode: routing.thinkingConfig
      ? routing.thinkingConfig.type === 'adaptive'
        ? `adaptive:${routing.thinkingConfig.effort}`
        : routing.thinkingConfig.type === 'enabled'
          ? `enabled:${routing.thinkingConfig.budgetTokens}`
          : 'disabled'
      : undefined,
    thinkingTokensUsed: workerResult.thinkingTokensUsed,
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
    failedApproaches: workingMemory.getSnapshot().failedApproaches.map((fa) => ({
      approach: fa.approach,
      oracleVerdict: fa.oracleVerdict,
      verdictConfidence: fa.verdictConfidence,
      failureOracle: fa.failureOracle,
    })),
  };

  if (confidenceDecision === 'refuse' && pipelineConf) {
    const refuseBoundary = PIPELINE_THRESHOLDS.ESCALATE;
    trace.governanceProvenance = buildVerificationProvenance(input, routing, {
      decisionId: 'confidence-refused',
      reason: `Pipeline confidence ${pipelineConf.composite.toFixed(4)} below refuse boundary ${refuseBoundary.toFixed(2)}; ${pipelineConf.formula}`,
      evidence: [
        {
          kind: 'other',
          source: 'verification-confidence',
          summary: `verification=${verificationConfidence.toFixed(3)}`,
        },
        {
          kind: 'other',
          source: 'prediction-confidence',
          summary: `prediction=${predictionConfidence?.toFixed(3) ?? 'default'}; meta=${metaPredictionConfidence?.toFixed(3) ?? 'default'}`,
        },
        {
          kind: 'policy',
          source: 'pipeline-confidence-thresholds',
          summary: `refuse when composite < ${refuseBoundary.toFixed(2)}`,
        },
      ],
    });
  }

  // ── Confidence-driven decision routing ──────────────────────
  const shouldCommit =
    routing.level === 0 || !confidenceDecision
      ? verification.passed
      : zeroMutationPass || confidenceDecision === 'allow';

  let shouldContinue = false;
  let reVerifyPassed = false;
  if (routing.level > 0 && confidenceDecision && !shouldCommit) {
    switch (confidenceDecision) {
      case 're-verify': {
        deps.bus?.emit('pipeline:re-verify', {
          taskId: input.id,
          composite: pipelineConf?.composite,
          routing,
        });
        const reVerification = await deps.oracleGate.verify(
          workerResult.mutations.map((m) => ({ file: m.file, content: m.content })),
          input.targetFiles?.[0] ?? '.',
          activeHint,
          routing.level,
        );
        const reVerConfidence = reVerification.aggregateConfidence ?? (reVerification.passed ? 0.85 : 0.3);
        const reVerPipeline = computePipelineConfidence({
          prediction: predictionConfidence,
          metaPrediction: metaPredictionConfidence,
          verification: reVerConfidence,
        });
        const reVerDecision = deriveConfidenceDecision(reVerPipeline.composite);

        if (reVerDecision === 'allow' || reVerification.passed) {
          trace.verificationConfidence = reVerConfidence;
          trace.confidenceDecision = {
            action: reVerDecision,
            confidence: reVerPipeline.composite,
            reason: reVerPipeline.formula,
          };
          trace.pipelineConfidence = { composite: reVerPipeline.composite, formula: reVerPipeline.formula };
          trace.outcome = 'success';
          trace.failureReason = undefined;
          reVerifyPassed = true; // Signal success to coordinator
        } else {
          const classified = classifyAllFailures(verification.verdicts);
          workingMemory.recordFailedApproach(
            trace.approach,
            verification.reason ?? 'unknown',
            verificationConfidence,
            failedOracles[0],
            classified.length > 0 ? classified : undefined,
          );
          if (isAgenticResult && lastAgentResult) {
            workingMemory.addPriorAttempt(buildAgentSessionSummary(lastAgentResult, retry, 'oracle_failed'));
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
          }
          shouldContinue = true;
        }
        break;
      }
      case 'escalate': {
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
          workingMemory.addPriorAttempt(buildAgentSessionSummary(lastAgentResult, retry, 'oracle_failed'));
        }
        if (matchedSkill && deps.skillManager) {
          deps.skillManager.recordOutcome(matchedSkill, false);
          deps.bus?.emit('skill:outcome', { taskId: input.id, skill: matchedSkill, success: false });
        }
        shouldContinue = true;
        break;
      }
      case 'refuse': {
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
          workingMemory.addPriorAttempt(buildAgentSessionSummary(lastAgentResult, retry, 'oracle_failed'));
        }
        if (matchedSkill && deps.skillManager) {
          deps.skillManager.recordOutcome(matchedSkill, false);
          deps.bus?.emit('skill:outcome', { taskId: input.id, skill: matchedSkill, success: false });
        }
        shouldContinue = true;
        break;
      }
    }
  }

  return Phase.continue({
    verification,
    passedOracles,
    failedOracles,
    verificationConfidence,
    qualityScore,
    pipelineConf: pipelineConf ? { composite: pipelineConf.composite, formula: pipelineConf.formula } : undefined,
    confidenceDecision,
    shouldCommit: shouldContinue ? false : shouldCommit || reVerifyPassed,
    activeHint,
    oracleFailurePattern,
    trace,
  });
}
