/**
 * GAP-H Failure Mode Detectors — Phase 5.15 observability extension.
 *
 * Detects three failure modes from the GAP-H framework:
 *   FC4  "Forgot context"     — repeated memory evictions preceding task failures
 *   FC9  "Withheld info"      — oracle verdicts not propagated to the worker
 *   FC11 "Think/do mismatch"  — sustained prediction error bias in the self-model
 *
 * Each detector listens to specific bus events and emits `observability:alert`
 * when thresholds are exceeded. All logic is deterministic (A3).
 */
import type { VinyanBus } from '../core/bus.ts';

// ── FC4: Forgot context ──────────────────────────────────────────────

interface FC4State {
  /** Recent eviction warnings indexed by taskId */
  evictions: Map<string, number>;
}

const FC4_EVICTION_THRESHOLD = 2;

// ── FC9: Withheld info ───────────────────────────────────────────────

interface FC9State {
  /** Omitted verdict counts indexed by taskId */
  omissions: Map<string, number>;
}

const FC9_OMISSION_THRESHOLD = 3;

// ── FC11: Think/do mismatch ──────────────────────────────────────────

interface FC11State {
  /** Recent bias directions (ring buffer, max windowSize entries) */
  recentBiases: Array<'over' | 'under'>;
}

const FC11_WINDOW_SIZE = 20;
const FC11_BIAS_THRESHOLD = 0.7;

// ── Detector ─────────────────────────────────────────────────────────

export class GapHDetector {
  private fc4: FC4State = { evictions: new Map() };
  private fc9: FC9State = { omissions: new Map() };
  private fc11: FC11State = { recentBiases: [] };

  constructor(private bus: VinyanBus) {}

  /** Start listening. Returns cleanup function. */
  attach(): () => void {
    const unsubs: Array<() => void> = [];

    // FC4: Track memory eviction warnings
    unsubs.push(
      this.bus.on('memory:eviction_warning', (payload) => {
        const count = (this.fc4.evictions.get(payload.taskId) ?? 0) + 1;
        this.fc4.evictions.set(payload.taskId, count);
      }),
    );

    // FC4: Check for task failure after eviction warnings
    unsubs.push(
      this.bus.on('task:complete', (payload) => {
        if (payload.result.status === 'failed') {
          const evictionCount = this.fc4.evictions.get(payload.result.id) ?? 0;
          if (evictionCount >= FC4_EVICTION_THRESHOLD) {
            this.bus.emit('observability:alert', {
              detector: 'FC4',
              severity: 'warning',
              message: `Task ${payload.result.id} failed after ${evictionCount} memory eviction warnings — possible context loss`,
              metadata: { taskId: payload.result.id, evictionCount },
            });
          }
        }
        // Clean up eviction tracking for completed tasks
        this.fc4.evictions.delete(payload.result.id);
      }),
    );

    // FC9: Track omitted oracle verdicts
    unsubs.push(
      this.bus.on('context:verdict_omitted', (payload) => {
        const count = (this.fc9.omissions.get(payload.taskId) ?? 0) + 1;
        this.fc9.omissions.set(payload.taskId, count);

        if (count >= FC9_OMISSION_THRESHOLD) {
          this.bus.emit('observability:alert', {
            detector: 'FC9',
            severity: 'critical',
            message: `Task ${payload.taskId} has ${count} omitted oracle verdicts — worker may lack critical context`,
            metadata: {
              taskId: payload.taskId,
              omittedCount: count,
              lastOmitted: payload.oracleName,
              reason: payload.reason,
            },
          });
        }
      }),
    );

    // FC11: Track prediction error bias
    unsubs.push(
      this.bus.on('selfmodel:systematic_miscalibration', (payload) => {
        this.fc11.recentBiases.push(payload.biasDirection);
        // Keep ring buffer within window size
        if (this.fc11.recentBiases.length > FC11_WINDOW_SIZE) {
          this.fc11.recentBiases.shift();
        }

        // Check for sustained bias only when we have enough samples
        if (this.fc11.recentBiases.length >= FC11_WINDOW_SIZE) {
          const overCount = this.fc11.recentBiases.filter((d) => d === 'over').length;
          const underCount = this.fc11.recentBiases.length - overCount;
          const maxCount = Math.max(overCount, underCount);
          const biasRatio = maxCount / this.fc11.recentBiases.length;

          if (biasRatio >= FC11_BIAS_THRESHOLD) {
            const dominantDirection = overCount > underCount ? 'over' : 'under';
            this.bus.emit('observability:alert', {
              detector: 'FC11',
              severity: 'warning',
              message: `Self-model shows sustained ${dominantDirection}-prediction bias: ${(biasRatio * 100).toFixed(0)}% of last ${FC11_WINDOW_SIZE} predictions`,
              metadata: {
                biasDirection: dominantDirection,
                biasRatio,
                windowSize: FC11_WINDOW_SIZE,
                overCount,
                underCount,
              },
            });
          }
        }
      }),
    );

    return () => unsubs.forEach((fn) => fn());
  }

  /** Get current detector state for debugging */
  getState(): {
    fc4: { evictions: Record<string, number> };
    fc9: { omissions: Record<string, number> };
    fc11: { recentBiases: Array<'over' | 'under'>; windowSize: number };
  } {
    return {
      fc4: { evictions: Object.fromEntries(this.fc4.evictions) },
      fc9: { omissions: Object.fromEntries(this.fc9.omissions) },
      fc11: { recentBiases: [...this.fc11.recentBiases], windowSize: FC11_WINDOW_SIZE },
    };
  }
}
