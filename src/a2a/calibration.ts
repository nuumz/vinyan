/**
 * Calibration Exchange — share calibration data between instances.
 *
 * CalibrationReport includes per-task-type Brier scores, Wilson LB, sample sizes,
 * and bias direction. Shared in every 10th heartbeat (caller responsibility).
 *
 * shouldDiscountPeer() returns true if average Brier score exceeds threshold,
 * indicating poor calibration that warrants discounting confidence.
 *
 * Source of truth: Plan Phase K2
 */
import { wilsonLowerBound } from '../sleep-cycle/wilson.ts';

export interface PerTaskTypeCalibration {
  brier_score: number;
  wilson_lb: number;
  sample_size: number;
  bias_direction: 'overconfident' | 'underconfident' | 'calibrated';
}

export interface CalibrationReport {
  instance_id: string;
  per_task_type: Record<string, PerTaskTypeCalibration>;
  overall_accuracy_ema: number;
  report_timestamp: number;
}

interface RemoteCalibrationRecord {
  peerId: string;
  report: CalibrationReport;
  receivedAt: number;
}

export interface CalibrationExchangeConfig {
  instanceId: string;
  discountThreshold?: number;
  /** Optional self-model for warm-starting from peer calibration data (PH5.9). */
  selfModel?: { warmStartFromPeer(report: CalibrationReport, weight?: number): number };
}

const DEFAULT_DISCOUNT_THRESHOLD = 0.3;

export class CalibrationExchange {
  private remoteCalibrations = new Map<string, RemoteCalibrationRecord>();
  private discountThreshold: number;

  constructor(private config: CalibrationExchangeConfig) {
    this.discountThreshold = config.discountThreshold ?? DEFAULT_DISCOUNT_THRESHOLD;
  }

  generateReport(
    perTaskType: Record<
      string,
      {
        successes: number;
        total: number;
        brierScore: number;
        biasDirection: 'overconfident' | 'underconfident' | 'calibrated';
      }
    >,
    overallAccuracyEma: number,
  ): CalibrationReport {
    const calibrated: Record<string, PerTaskTypeCalibration> = {};

    for (const [taskType, data] of Object.entries(perTaskType)) {
      calibrated[taskType] = {
        brier_score: data.brierScore,
        wilson_lb: wilsonLowerBound(data.successes, data.total),
        sample_size: data.total,
        bias_direction: data.biasDirection,
      };
    }

    return {
      instance_id: this.config.instanceId,
      per_task_type: calibrated,
      overall_accuracy_ema: overallAccuracyEma,
      report_timestamp: Date.now(),
    };
  }

  handleReport(peerId: string, report: CalibrationReport): void {
    this.remoteCalibrations.set(peerId, {
      peerId,
      report,
      receivedAt: Date.now(),
    });

    // PH5.9: Feed peer calibration into self-model as warm-start (reduced weight)
    if (this.config.selfModel && !this.shouldDiscountPeer(peerId)) {
      this.config.selfModel.warmStartFromPeer(report, 0.25);
    }
  }

  getRemoteCalibration(peerId: string): CalibrationReport | undefined {
    return this.remoteCalibrations.get(peerId)?.report;
  }

  shouldDiscountPeer(peerId: string): boolean {
    const record = this.remoteCalibrations.get(peerId);
    if (!record) return false;

    const entries = Object.values(record.report.per_task_type);
    if (entries.length === 0) return false;

    const avgBrier = entries.reduce((sum, e) => sum + e.brier_score, 0) / entries.length;
    return avgBrier > this.discountThreshold;
  }

  getAllRemoteCalibrations(): RemoteCalibrationRecord[] {
    return [...this.remoteCalibrations.values()];
  }
}
