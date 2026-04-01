export { analyzeSessionDir, analyzeSessionFile, formatMetrics, type SessionMetrics } from './analyzer.ts';
export {
  computeAggregateConfidence,
  type ConfidenceThresholds,
  DEFAULT_THRESHOLDS,
  deriveEpistemicDecision,
  type EpistemicGateDecision,
  generateResolutionHints,
  THRESHOLDS,
  TIER_WEIGHTS,
  toClassicDecision,
  type UncertaintyResolutionHint,
} from './epistemic-decision.ts';
export { type GateDecision, type GateRequest, type GateVerdict, runGate } from './gate.ts';
export { logDecision, readSessionLog, type SessionLogEntry } from './logger.ts';
