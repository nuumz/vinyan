/**
 * Cost Predictor — per-task-type EMA cost prediction.
 *
 * Mirrors SelfModel's adaptive alpha pattern for cost forecasting.
 * A3 compliant: deterministic, no LLM in prediction path.
 *
 * Source of truth: Economy OS plan §E2.1
 */
import type { CostLedger } from './cost-ledger.ts';

export interface CostPrediction {
  taskTypeSignature: string;
  predicted_usd: number;
  confidence: number;
  p95_usd: number;
  basis: 'cold-start' | 'ema-calibrated';
  observation_count: number;
}

interface CostTypeParams {
  avgCostUsd: number;
  observationCount: number;
  lastUpdated: number;
}

function adaptiveAlpha(observationCount: number): number {
  return Math.max(0.05, Math.min(0.3, 1 / (1 + observationCount * 0.1)));
}

function ema(current: number, observed: number, alpha: number): number {
  return alpha * observed + (1 - alpha) * current;
}

/** Cold-start heuristic: rough USD estimate per routing level. */
const COLD_START_USD: Record<number, number> = {
  0: 0,
  1: 0.003, // ~1K tokens at haiku rate
  2: 0.075, // ~5K tokens at sonnet rate
  3: 1.5, // ~20K tokens at opus rate
};

export class CostPredictor {
  private params = new Map<string, CostTypeParams>();
  private ledger: CostLedger;

  constructor(ledger: CostLedger) {
    this.ledger = ledger;
  }

  /** Predict cost for a task type at a routing level. */
  predict(taskTypeSignature: string, routingLevel: number): CostPrediction {
    const key = `${taskTypeSignature}:L${routingLevel}`;
    const existing = this.params.get(key);

    if (!existing || existing.observationCount < 5) {
      const coldStart = COLD_START_USD[routingLevel] ?? COLD_START_USD[2]!;
      return {
        taskTypeSignature,
        predicted_usd: coldStart,
        confidence: 0.1,
        p95_usd: coldStart * 3,
        basis: 'cold-start',
        observation_count: existing?.observationCount ?? 0,
      };
    }

    // Compute p95 from ledger history
    const entries = this.ledger.queryByTaskType(taskTypeSignature);
    const levelEntries = entries.filter((e) => e.routing_level === routingLevel);
    let p95 = existing.avgCostUsd * 2;
    if (levelEntries.length >= 10) {
      const sorted = levelEntries.map((e) => e.computed_usd).sort((a, b) => a - b);
      const idx = Math.min(Math.floor(sorted.length * 0.95), sorted.length - 1);
      p95 = sorted[idx] ?? p95;
    }

    // Confidence scales with observations
    const confidence = Math.min(0.95, 0.3 + existing.observationCount * 0.01);

    return {
      taskTypeSignature,
      predicted_usd: existing.avgCostUsd,
      confidence,
      p95_usd: p95,
      basis: 'ema-calibrated',
      observation_count: existing.observationCount,
    };
  }

  /** Update EMA from actual cost. Called after task completion. */
  calibrate(taskTypeSignature: string, routingLevel: number, actualUsd: number): void {
    const key = `${taskTypeSignature}:L${routingLevel}`;
    const existing = this.params.get(key) ?? {
      avgCostUsd: actualUsd,
      observationCount: 0,
      lastUpdated: Date.now(),
    };

    const alpha = adaptiveAlpha(existing.observationCount);
    existing.avgCostUsd = existing.observationCount === 0 ? actualUsd : ema(existing.avgCostUsd, actualUsd, alpha);
    existing.observationCount++;
    existing.lastUpdated = Date.now();
    this.params.set(key, existing);
  }

  /** Get observation count for a key. */
  getObservationCount(taskTypeSignature: string, routingLevel: number): number {
    const key = `${taskTypeSignature}:L${routingLevel}`;
    return this.params.get(key)?.observationCount ?? 0;
  }
}
