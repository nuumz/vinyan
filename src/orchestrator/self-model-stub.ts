/**
 * Self-Model Stub — returns static heuristic predictions.
 *
 * Fallback when SQLite is unavailable. See CalibratedSelfModel for the full implementation.
 * Forced metaConfidence < 0.3 per A7 (< 10 observations).
 *
 * Source of truth: spec/tdd.md §12 (Self-Model), arch D11
 */
import type { SelfModel } from './core-loop.ts';
import type { PerceptualHierarchy, SelfModelPrediction, TaskInput } from './types.ts';

export class SelfModelStub implements SelfModel {
  async predict(input: TaskInput, perception: PerceptualHierarchy): Promise<SelfModelPrediction> {
    return {
      taskId: input.id,
      timestamp: Date.now(),
      expectedTestResults: 'partial',
      expectedBlastRadius: perception.dependencyCone.transitiveBlastRadius,
      expectedDuration: Math.min(input.budget.maxDurationMs / 2, 30_000),
      expectedQualityScore: 0.5,
      uncertainAreas: perception.diagnostics.typeErrors.length > 0 ? ['type-errors-present'] : [],
      confidence: 0.5,
      metaConfidence: 0.1, // forced < 0.3: no calibration data
      basis: 'static-heuristic',
      calibrationDataPoints: 0,
    };
  }
}
