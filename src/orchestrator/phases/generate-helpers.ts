/**
 * Helper functions shared across generate and learn phases.
 */

import type { WorkerLoopResult } from '../worker/agent-loop.ts';
import type { AgentSessionSummary, ExecutionTrace, SelfModelPrediction } from '../types.ts';
import type { OutcomePrediction, PredictionOutcome } from '../forward-predictor-types.ts';

/** Build retry context from an agentic session result (Phase 6.3). */
export function buildAgentSessionSummary(
  result: WorkerLoopResult,
  attempt: number,
  outcome: 'uncertain' | 'oracle_failed',
): AgentSessionSummary {
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
export function mapTraceToFPOutcome(
  predictionId: string,
  trace: ExecutionTrace,
): PredictionOutcome | undefined {
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
      return undefined;
    case 'escalated':
      if (trace.shadowValidation) {
        testResult = trace.shadowValidation.testsPassed ? 'pass' : 'fail';
      } else {
        return undefined;
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
 */
export function mergeForwardAndSelfModel(
  selfModelPrediction: SelfModelPrediction,
  forwardPrediction: OutcomePrediction,
): number {
  const wFp = forwardPrediction.confidence;
  const wSm = 1 - wFp;
  const smPPass = selfModelPrediction.pPass ?? 0.5;
  const fpPPass = forwardPrediction.testOutcome.pPass;
  return wFp * fpPPass + wSm * smPPass;
}
