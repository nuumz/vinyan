/**
 * Calibration exchange tests — Phase K2.
 */
import { describe, expect, test } from 'bun:test';
import { CalibrationExchange, type CalibrationReport } from '../../src/a2a/calibration.ts';

function makeExchange(discountThreshold?: number) {
  return new CalibrationExchange({
    instanceId: 'inst-001',
    discountThreshold,
  });
}

function makeReport(overrides: Partial<CalibrationReport> = {}): CalibrationReport {
  return {
    instance_id: 'inst-002',
    per_task_type: {
      code_edit: { brier_score: 0.15, wilson_lb: 0.72, sample_size: 50, bias_direction: 'calibrated' },
      refactor: { brier_score: 0.2, wilson_lb: 0.68, sample_size: 30, bias_direction: 'underconfident' },
    },
    overall_accuracy_ema: 0.85,
    report_timestamp: Date.now(),
    ...overrides,
  };
}

describe('CalibrationExchange — generateReport', () => {
  test('computes wilson_lb for each task type', () => {
    const exchange = makeExchange();
    const report = exchange.generateReport(
      {
        code_edit: { successes: 45, total: 50, brierScore: 0.12, biasDirection: 'calibrated' },
        refactor: { successes: 20, total: 30, brierScore: 0.25, biasDirection: 'overconfident' },
      },
      0.88,
    );

    expect(report.instance_id).toBe('inst-001');
    expect(report.overall_accuracy_ema).toBe(0.88);
    expect(report.per_task_type.code_edit!.brier_score).toBe(0.12);
    expect(report.per_task_type.code_edit!.wilson_lb).toBeGreaterThan(0);
    expect(report.per_task_type.code_edit!.sample_size).toBe(50);
    expect(report.per_task_type.refactor!.bias_direction).toBe('overconfident');
  });

  test('includes all task types', () => {
    const exchange = makeExchange();
    const report = exchange.generateReport(
      {
        a: { successes: 10, total: 10, brierScore: 0.05, biasDirection: 'calibrated' },
        b: { successes: 5, total: 10, brierScore: 0.3, biasDirection: 'overconfident' },
        c: { successes: 8, total: 10, brierScore: 0.1, biasDirection: 'calibrated' },
      },
      0.9,
    );

    expect(Object.keys(report.per_task_type)).toHaveLength(3);
  });

  test('sets report_timestamp', () => {
    const exchange = makeExchange();
    const before = Date.now();
    const report = exchange.generateReport({}, 0.5);
    expect(report.report_timestamp).toBeGreaterThanOrEqual(before);
  });
});

describe('CalibrationExchange — handleReport', () => {
  test('stores remote calibration report', () => {
    const exchange = makeExchange();
    exchange.handleReport('peer-A', makeReport());

    const cal = exchange.getRemoteCalibration('peer-A');
    expect(cal).toBeDefined();
    expect(cal!.instance_id).toBe('inst-002');
  });

  test('overwrites previous report for same peer', () => {
    const exchange = makeExchange();
    exchange.handleReport('peer-A', makeReport({ overall_accuracy_ema: 0.8 }));
    exchange.handleReport('peer-A', makeReport({ overall_accuracy_ema: 0.9 }));

    expect(exchange.getRemoteCalibration('peer-A')!.overall_accuracy_ema).toBe(0.9);
  });
});

describe('CalibrationExchange — getRemoteCalibration', () => {
  test('returns stored report', () => {
    const exchange = makeExchange();
    exchange.handleReport('peer-A', makeReport());
    expect(exchange.getRemoteCalibration('peer-A')).toBeDefined();
  });

  test('returns undefined for unknown peer', () => {
    const exchange = makeExchange();
    expect(exchange.getRemoteCalibration('unknown')).toBeUndefined();
  });
});

describe('CalibrationExchange — shouldDiscountPeer', () => {
  test('returns true when avg Brier score above threshold', () => {
    const exchange = makeExchange(0.15); // low threshold
    exchange.handleReport(
      'peer-A',
      makeReport({
        per_task_type: {
          a: { brier_score: 0.4, wilson_lb: 0.5, sample_size: 20, bias_direction: 'overconfident' },
          b: { brier_score: 0.35, wilson_lb: 0.45, sample_size: 15, bias_direction: 'overconfident' },
        },
      }),
    );

    expect(exchange.shouldDiscountPeer('peer-A')).toBe(true);
  });

  test('returns false when avg Brier score below threshold', () => {
    const exchange = makeExchange(); // default 0.3
    exchange.handleReport(
      'peer-A',
      makeReport({
        per_task_type: {
          a: { brier_score: 0.1, wilson_lb: 0.8, sample_size: 50, bias_direction: 'calibrated' },
          b: { brier_score: 0.15, wilson_lb: 0.75, sample_size: 40, bias_direction: 'calibrated' },
        },
      }),
    );

    expect(exchange.shouldDiscountPeer('peer-A')).toBe(false);
  });

  test('returns false for unknown peer', () => {
    const exchange = makeExchange();
    expect(exchange.shouldDiscountPeer('unknown')).toBe(false);
  });
});

describe('CalibrationExchange — getAllRemoteCalibrations', () => {
  test('returns all stored calibrations', () => {
    const exchange = makeExchange();
    exchange.handleReport('peer-A', makeReport());
    exchange.handleReport('peer-B', makeReport({ instance_id: 'inst-003' }));

    expect(exchange.getAllRemoteCalibrations()).toHaveLength(2);
  });

  test('returns empty initially', () => {
    const exchange = makeExchange();
    expect(exchange.getAllRemoteCalibrations()).toHaveLength(0);
  });
});
