/**
 * HMS Feedback — converts hallucination detection results into ClassifiedFailure
 * entries for WorkingMemory injection, closing the feedback loop.
 *
 * When retry/escalation occurs, the LLM sees exactly what was hallucinated
 * and how to fix it in the [FAILED APPROACHES] prompt section.
 *
 * A3 compliant: all conversions are deterministic.
 *
 * Source of truth: HMS Feedback Loop plan
 */
import type { ClassifiedFailure, FailureCategory } from '../orchestrator/failure-classifier.ts';
import { type ExtractedClaim, extractClaims, type GroundingResult, verifyClaims } from './claim-grounding.ts';
import type { HMSConfig } from './hms-config.ts';
import { detectOverconfidence, type OverconfidenceSignals } from './overconfidence-detector.ts';
import { computeHallucinationRisk, type HallucinationRisk } from './risk-scorer.ts';

export interface HMSFeedbackResult {
  classifiedFailures: ClassifiedFailure[];
  uncertainties: Array<{ area: string; confidence: number; action: string }>;
  risk: HallucinationRisk;
  groundingResult?: GroundingResult;
  overconfidenceSignals?: OverconfidenceSignals;
}

/** Map claim type to failure category. */
const CLAIM_TO_CATEGORY: Record<ExtractedClaim['type'], FailureCategory> = {
  file_reference: 'hallucination_file',
  import_claim: 'hallucination_import',
  fake_tool_call: 'hallucination_tool_call',
  symbol_reference: 'hallucination_symbol',
};

/** Suggested fixes per hallucination category. */
const SUGGESTED_FIXES: Record<string, string> = {
  hallucination_file: 'Use actual file paths from [PERCEPTION] context',
  hallucination_import: 'Verify import paths against dependency cone',
  hallucination_tool_call: 'Do NOT emit tool call syntax — use proposedToolCalls array',
  hallucination_symbol: 'Verify symbol exists via AST before referencing',
  overconfidence: 'Add hedging language; qualify claims with confidence levels',
};

/** Convert a refuted claim to a ClassifiedFailure. */
export function refutedClaimToFailure(claim: ExtractedClaim & { reason: string }): ClassifiedFailure {
  const category = CLAIM_TO_CATEGORY[claim.type] ?? ('unknown' as FailureCategory);
  return {
    category,
    file: claim.type === 'file_reference' || claim.type === 'import_claim' ? claim.value : undefined,
    line: claim.source_line,
    message: claim.reason,
    severity: claim.type === 'fake_tool_call' ? 'error' : 'warning',
    suggestedFix: SUGGESTED_FIXES[category],
  };
}

/** Convert overconfidence signals to feedback entries. */
export function overconfidenceToFeedback(
  signals: OverconfidenceSignals,
  threshold: number,
): { failure?: ClassifiedFailure; uncertainty?: { area: string; confidence: number; action: string } } {
  if (signals.score <= threshold) return {};

  return {
    failure: {
      category: 'overconfidence',
      message: `Overconfidence score ${(signals.score * 100).toFixed(0)}%: ${signals.certainty_markers} certainty markers, ${signals.hedging_absence ? 'no hedging' : 'some hedging'}`,
      severity: 'warning',
      suggestedFix: SUGGESTED_FIXES.overconfidence,
    },
    uncertainty: {
      area: 'Output shows RLHF overconfidence patterns',
      confidence: 1 - signals.score,
      action: "Add hedging: 'might', 'possibly', 'I think'",
    },
  };
}

/**
 * Run HMS analysis on worker output and convert to ClassifiedFailure entries.
 * Returns null when HMS is disabled or no text to analyze.
 * Pure/deterministic (A3).
 */
export function analyzeForHallucinations(
  workerOutput: { proposedContent?: string; mutations: Array<{ file: string; content: string }> },
  workspace: string,
  config: HMSConfig,
): HMSFeedbackResult | null {
  // Build combined text from proposedContent + mutation explanations
  const textParts: string[] = [];
  if (workerOutput.proposedContent) textParts.push(workerOutput.proposedContent);
  for (const m of workerOutput.mutations) {
    if (m.content) textParts.push(m.content);
  }
  const combinedText = textParts.join('\n');
  if (!combinedText.trim()) return null;

  const classifiedFailures: ClassifiedFailure[] = [];
  const uncertainties: Array<{ area: string; confidence: number; action: string }> = [];
  let groundingResult: GroundingResult | undefined;
  let overconfidenceSignals: OverconfidenceSignals | undefined;

  // Grounding analysis
  if (config.grounding.enabled) {
    const claims = extractClaims(combinedText, config.grounding.max_claims);
    groundingResult = verifyClaims(claims, workspace);

    // Convert refuted claims to ClassifiedFailure entries
    for (const refuted of groundingResult.refuted_claims) {
      classifiedFailures.push(refutedClaimToFailure(refuted));
    }

    // Add uncertainty if any claims were refuted
    if (groundingResult.refuted > 0) {
      uncertainties.push({
        area: `File references: ${groundingResult.refuted}/${groundingResult.verified + groundingResult.refuted} claims refuted`,
        confidence: groundingResult.grounding_ratio,
        action: 'Only use files from [PERCEPTION] — verified paths',
      });
    }
  }

  // Overconfidence analysis
  if (config.overconfidence.enabled) {
    overconfidenceSignals = detectOverconfidence(combinedText);
    const feedback = overconfidenceToFeedback(overconfidenceSignals, config.overconfidence.threshold);
    if (feedback.failure) classifiedFailures.push(feedback.failure);
    if (feedback.uncertainty) uncertainties.push(feedback.uncertainty);
  }

  // Compute composite risk
  const risk = computeHallucinationRisk({
    groundingResult,
    overconfidence: overconfidenceSignals,
    oraclePassRatio: 0.5, // Caller should provide actual ratio; default neutral
  });

  // Skip if nothing found
  if (classifiedFailures.length === 0 && uncertainties.length === 0) return null;

  return { classifiedFailures, uncertainties, risk, groundingResult, overconfidenceSignals };
}
