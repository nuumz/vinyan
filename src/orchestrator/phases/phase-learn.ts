/**
 * Learn Phase — Step 6 of the Orchestrator lifecycle.
 *
 * Calibrates SelfModel, understanding, ForwardPredictor, provider trust,
 * cost predictor. Compresses transcript and records understanding snapshot.
 */

import type { ExecutionTrace, RoutingDecision, SemanticTaskUnderstanding, SelfModelPrediction } from '../types.ts';
import type { OutcomePrediction } from '../forward-predictor-types.ts';
import type { WorkerLoopResult } from '../worker/agent-loop.ts';
import type { VerificationResult } from './types.ts';
import type { PhaseContext, LearnResult } from './types.ts';
import { mapTraceToFPOutcome } from './generate-helpers.ts';

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

  // ── K2: Record provider trust outcome ──
  if (deps.providerTrustStore && routing.model) {
    try {
      deps.providerTrustStore.recordOutcome(routing.model, trace.outcome === 'success');
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

  await deps.traceCollector.record(trace);
  deps.bus?.emit('trace:record', { trace });

  return { trace };
}
