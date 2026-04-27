/**
 * Learn Phase — Step 6 of the Orchestrator lifecycle.
 *
 * Calibrates SelfModel, understanding, ForwardPredictor, provider trust,
 * cost predictor. Compresses transcript and records understanding snapshot.
 */

import type { WorkerLoopResult } from '../agent/agent-loop.ts';
import type { OutcomePrediction } from '../forward-predictor-types.ts';
import type {
  CapabilityFit,
  ExecutionTrace,
  IntentResolution,
  RoutingDecision,
  SelfModelPrediction,
  SemanticTaskUnderstanding,
} from '../types.ts';
import { mapTraceToFPOutcome } from './generate-helpers.ts';
import type { LearnResult, PhaseContext, VerificationResult } from './types.ts';

interface LearnInput {
  routing: RoutingDecision;
  understanding: SemanticTaskUnderstanding;
  prediction?: SelfModelPrediction;
  forwardPrediction?: OutcomePrediction;
  verification: VerificationResult;
  trace: ExecutionTrace;
  isAgenticResult: boolean;
  lastAgentResult: WorkerLoopResult | null;
}

type CapabilityTraceAudit = Pick<
  ExecutionTrace,
  | 'agentSelectionReason'
  | 'selectedCapabilityProfileId'
  | 'selectedCapabilityProfileSource'
  | 'selectedCapabilityProfileTrustTier'
  | 'capabilityFitScore'
  | 'unmetCapabilityIds'
>;

export function deriveCapabilityTraceAudit(intentResolution?: IntentResolution): CapabilityTraceAudit {
  if (!intentResolution) return {};

  const selectedFit = selectCapabilityFit(intentResolution);
  const audit: CapabilityTraceAudit = {};

  if (intentResolution.agentSelectionReason) {
    audit.agentSelectionReason = intentResolution.agentSelectionReason;
  }

  if (intentResolution.syntheticAgentId) {
    audit.selectedCapabilityProfileId = intentResolution.syntheticAgentId;
    audit.selectedCapabilityProfileSource = 'synthetic';
    audit.selectedCapabilityProfileTrustTier = 'probabilistic';
  }

  if (selectedFit) {
    audit.selectedCapabilityProfileId ??= selectedFit.profileId ?? selectedFit.agentId;
    if (selectedFit.profileSource) {
      audit.selectedCapabilityProfileSource ??= selectedFit.profileSource;
    }
    if (selectedFit.trustTier) {
      audit.selectedCapabilityProfileTrustTier ??= selectedFit.trustTier;
    }
    audit.capabilityFitScore = selectedFit.fitScore;
    audit.unmetCapabilityIds = selectedFit.gap.map((gap) => gap.id);
  }

  return audit;
}

function selectCapabilityFit(intentResolution: IntentResolution): CapabilityFit | undefined {
  const candidates = intentResolution.capabilityAnalysis?.candidates ?? [];
  if (candidates.length === 0) return undefined;
  return (
    candidates.find(
      (candidate) => candidate.agentId === intentResolution.agentId || candidate.profileId === intentResolution.agentId,
    ) ?? candidates[0]
  );
}

export async function executeLearnPhase(
  ctx: PhaseContext,
  li: LearnInput,
): Promise<LearnResult> {
  const { input, deps } = ctx;
  const { routing, understanding, prediction, forwardPrediction, verification, trace, isAgenticResult, lastAgentResult } = li;

  // ── SelfModel calibration ──
  if (prediction && deps.selfModel.calibrate) {
    try {
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
        // Wave A: route significant prediction errors through the error attribution bus
        if (deps.errorAttributionBus && Math.abs(predictionError.error.composite) > 0.3) {
          try {
            deps.errorAttributionBus.attributeError(predictionError, trace);
          } catch { /* attribution is best-effort */ }
        }
      }
    } catch (calibErr) {
      deps.bus?.emit('selfmodel:calibration_error', {
        taskId: input.id,
        error: calibErr instanceof Error ? calibErr.message : String(calibErr),
      });
    }
  }

  // ── Phase 7: per-engine EMA calibration + drift detection ──
  // Both are best-effort. They never block the trace from being recorded
  // and never throw — Phase 7 is observational by design (see §12).
  if (deps.oracleEMACalibrator) {
    try {
      // ExecutionTrace stores oracle verdicts as `Record<string, boolean>`.
      // The richer OracleVerdict shape with engineCertainty only lives on
      // verification.verdicts. We feed both: the boolean drives the
      // verdict→outcome agreement EMA, the engineCertainty is reserved
      // for a future "calibration error" loop (Phase 7.2) that needs the
      // continuous signal — for now we just use the boolean.
      deps.oracleEMACalibrator.recordTrace(trace.oracleVerdicts, trace.outcome === 'success');
    } catch {
      /* Best-effort — never block trace recording. */
    }
  }
  if (prediction) {
    try {
      const { detectDrift } = await import('../monitoring/drift-detector.ts');
      const driftReport = detectDrift(prediction, trace);
      if (driftReport.drift) {
        deps.bus?.emit('monitoring:drift_detected', {
          taskId: input.id,
          triggeredDimensions: driftReport.triggeredDimensions,
          maxRelDelta: driftReport.maxRelDelta,
        });
      }
    } catch {
      /* Best-effort — never block trace recording. */
    }
  }
  if (deps.regressionMonitor && trace.taskTypeSignature) {
    try {
      deps.regressionMonitor.record({
        taskTypeSignature: trace.taskTypeSignature,
        succeeded: trace.outcome === 'success',
      });
    } catch {
      /* Best-effort — never block trace recording. */
    }
  }

  // ── STU Phase D: Understanding calibration (A7) ──
  if (understanding.understandingDepth >= 1) {
    try {
      const { calibrateUnderstanding, computeEnrichedSignature } = await import('../understanding/understanding-calibrator.ts');
      const calibration = calibrateUnderstanding(understanding, trace);
      deps.bus?.emit('understanding:calibration', {
        taskId: input.id,
        entityAccuracy: calibration.entityAccuracy,
        categoryMatch: calibration.categoryMatch,
      });
      if (deps.selfModel?.getTaskTypeParams && trace.taskTypeSignature) {
        const enrichedSig = computeEnrichedSignature(
          trace.taskTypeSignature,
          understanding,
          (sig) => deps.selfModel.getTaskTypeParams?.(sig)?.observationCount ?? 0,
        );
        if (enrichedSig !== trace.taskTypeSignature) {
          trace.taskTypeSignature = enrichedSig;
        }
      }
    } catch {
      // Understanding calibration failure — non-critical
    }
  }

  // ── FP: Record outcome for ForwardPredictor calibration (A7) ──
  if (deps.forwardPredictor && forwardPrediction) {
    try {
      const fpOutcome = mapTraceToFPOutcome(forwardPrediction.predictionId, trace);
      if (fpOutcome) {
        const brierScore = await deps.forwardPredictor.recordOutcome(fpOutcome);
        deps.bus?.emit('prediction:calibration', { taskId: input.id, brierScore });
        if (brierScore > 1.0) {
          deps.bus?.emit('prediction:miscalibrated', { taskId: input.id, brierScore, threshold: 1.0 });
        }
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

  // ── K2: Record provider trust outcome (per-capability when task type available) ──
  if (deps.providerTrustStore && routing.model) {
    try {
      const capability = trace.taskTypeSignature ?? '*';
      deps.providerTrustStore.recordOutcome(routing.model, trace.outcome === 'success', capability);
    } catch {
      /* Trust recording failure — non-critical */
    }
  }

  // ── Economy L2: Calibrate cost predictor ──
  if (deps.costPredictor && trace.taskTypeSignature) {
    try {
      const costEntries = deps.costLedger?.queryByTask(input.id) ?? [];
      const latestCost = costEntries[costEntries.length - 1];
      if (latestCost) {
        deps.costPredictor.calibrate(trace.taskTypeSignature, routing.level, latestCost.computed_usd);
      }
    } catch {
      /* Cost calibration failure — non-critical */
    }
  }

  // ── PH6: Compress transcript into trace ──
  if (isAgenticResult && lastAgentResult?.transcript?.length) {
    try {
      const transcriptJson = JSON.stringify(lastAgentResult.transcript);
      trace.transcriptGzip = Bun.gzipSync(Buffer.from(transcriptJson));
      trace.transcriptTurns = lastAgentResult.transcript.length;
    } catch {
      // Best-effort
    }
  }

  // ── STU Phase D: Record understanding snapshot ──
  trace.understandingDepth = understanding.understandingDepth;
  trace.understandingIntent = understanding.semanticIntent
    ? JSON.stringify(understanding.semanticIntent)
    : undefined;
  trace.resolvedEntities =
    understanding.resolvedEntities.length > 0 ? JSON.stringify(understanding.resolvedEntities) : undefined;
  trace.understandingVerified =
    understanding.verifiedClaims.length > 0
      ? understanding.verifiedClaims.every((c) => c.type === 'known') ? 1 : 0
      : undefined;
  trace.understandingPrimaryAction = understanding.semanticIntent?.primaryAction;

  // ── Capability-First (Phase D): record capability requirements + gap
  // analysis + synthetic agent id + knowledge contexts on the trace so
  // sleep-cycle promotion can group/promote by (taskTypeSignature, agentId).
  // No LLM in this path — pure copy of resolver output (A3).
  const ir = ctx.intentResolution;
  if (ir) {
    Object.assign(trace, deriveCapabilityTraceAudit(ir));
    if (ir.capabilityRequirements && ir.capabilityRequirements.length > 0) {
      trace.capabilityRequirements = ir.capabilityRequirements;
    }
    if (ir.capabilityAnalysis) {
      trace.capabilityAnalysis = ir.capabilityAnalysis;
    }
    if (ir.syntheticAgentId) {
      trace.syntheticAgentId = ir.syntheticAgentId;
    }
    if (ir.knowledgeUsed && ir.knowledgeUsed.length > 0) {
      trace.knowledgeUsed = ir.knowledgeUsed;
    }
  }

  // ── Agent Context Layer: update persistent agent identity/memory/skills ──
  // Phase 2: key by specialist agent id (ts-coder/writer/...), NOT engine workerId.
  // Falls back to registry default, then finally to workerId for legacy callers.
  const aclAgentId = input.agentId ?? deps.agentRegistry?.defaultAgent().id ?? routing.workerId;
  if (deps.agentContextUpdater && aclAgentId) {
    try {
      deps.agentContextUpdater.updateAfterTask(aclAgentId, trace);
    } catch {
      /* Agent context update is best-effort — never blocks trace recording */
    }
  }

  await deps.traceCollector.record(trace);
  deps.bus?.emit('trace:record', { trace });

  return { trace };
}
