/**
 * Hallucination Mitigation System — barrel exports.
 */

export type { ExtractedClaim, GroundingResult } from './claim-grounding.ts';
export { extractClaims, verifyClaims } from './claim-grounding.ts';
export type { CrossValidationConfig, ProbeProvider } from './cross-validation-oracle.ts';
export { crossValidate } from './cross-validation-oracle.ts';
export type { HMSConfig } from './hms-config.ts';
export { HMSConfigSchema } from './hms-config.ts';
export type { HMSFeedbackResult } from './hms-feedback.ts';
export { analyzeForHallucinations, overconfidenceToFeedback, refutedClaimToFailure } from './hms-feedback.ts';
export type { OverconfidenceSignals } from './overconfidence-detector.ts';
export { detectOverconfidence } from './overconfidence-detector.ts';
export type { Probe } from './probe-templates.ts';
export { generateProbes } from './probe-templates.ts';
export type { CrossValidationResult, HallucinationRisk, HallucinationRiskInput } from './risk-scorer.ts';
export { attenuateConfidence, computeHallucinationRisk } from './risk-scorer.ts';
