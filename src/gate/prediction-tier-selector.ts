/**
 * PredictionTierSelector — Data gate for ForwardPredictor tier selection.
 *
 * Determines which prediction tier to use based on accumulated data.
 * Tier 1: Heuristic (always), Tier 2: Statistical (≥100 traces),
 * Tier 3: Causal (≥100 traces + ≥50 edges + no miscalibration).
 *
 * Axiom: A3 (deterministic governance — rule-based tier selection)
 */

export type PredictionTier = 'heuristic' | 'statistical' | 'causal';

export interface PredictionTierSelectorConfig {
  minTracesStatistical: number;
  minTracesCausal: number;
  minEdgesCausal: number;
}

export interface PredictionTierSelector {
  select(traceCount: number, edgeCount: number, miscalibrationFlag: boolean): PredictionTier;
}

export class PredictionTierSelectorImpl implements PredictionTierSelector {
  private config: PredictionTierSelectorConfig;

  constructor(config: Partial<PredictionTierSelectorConfig> = {}) {
    this.config = {
      minTracesStatistical: config.minTracesStatistical ?? 100,
      minTracesCausal: config.minTracesCausal ?? 100,
      minEdgesCausal: config.minEdgesCausal ?? 50,
    };
  }

  select(traceCount: number, edgeCount: number, miscalibrationFlag: boolean): PredictionTier {
    if (
      traceCount >= this.config.minTracesCausal &&
      edgeCount >= this.config.minEdgesCausal &&
      !miscalibrationFlag
    ) {
      return 'causal';
    }

    if (traceCount >= this.config.minTracesStatistical) {
      return 'statistical';
    }

    return 'heuristic';
  }
}
