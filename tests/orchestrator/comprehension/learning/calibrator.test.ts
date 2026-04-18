/**
 * Tests for ComprehensionCalibrator — EMA + Wilson CI + data-gate.
 */

import { describe, expect, test } from 'bun:test';
import type { ComprehensionRecordRow, ComprehensionOutcome } from '../../../../src/db/comprehension-store.ts';
import {
  ComprehensionCalibrator,
  DATA_GATE_MIN,
  wilson95,
} from '../../../../src/orchestrator/comprehension/learning/calibrator.ts';

function row(outcome: ComprehensionOutcome, at: number): ComprehensionRecordRow {
  return {
    input_hash: `h-${at}`,
    task_id: 't',
    session_id: 's',
    engine_id: 'rule-comprehender',
    engine_type: 'rule',
    tier: 'deterministic',
    type: 'comprehension',
    confidence: 1,
    verdict_pass: 1,
    verdict_reason: null,
    envelope_json: '{}',
    created_at: at,
    outcome,
    outcome_evidence: null,
    outcome_at: at + 100,
  };
}

function loaderWith(records: ComprehensionRecordRow[]) {
  return {
    recentByEngine: (_engineId: string, limit?: number) =>
      records.slice(0, limit ?? records.length),
  };
}

describe('wilson95', () => {
  test('returns null for zero samples', () => {
    expect(wilson95(0, 0)).toBeNull();
  });

  test('0-positives, 100-total → lower near 0, upper around 0.037', () => {
    const ci = wilson95(0, 100)!;
    expect(ci.lower).toBeGreaterThanOrEqual(0);
    expect(ci.upper).toBeGreaterThan(0);
    expect(ci.upper).toBeLessThan(0.05);
  });

  test('50/100 → interval around 0.5', () => {
    const ci = wilson95(50, 100)!;
    expect(ci.lower).toBeGreaterThan(0.39);
    expect(ci.upper).toBeLessThan(0.61);
  });
});

describe('ComprehensionCalibrator', () => {
  test('returns insufficient when sample is below DATA_GATE_MIN', () => {
    const small: ComprehensionRecordRow[] = [];
    for (let i = 0; i < DATA_GATE_MIN - 1; i++) {
      small.push(row('confirmed', i));
    }
    const calib = new ComprehensionCalibrator(loaderWith(small));
    const acc = calib.getEngineAccuracy('rule-comprehender');
    expect(acc.insufficient).toBe(true);
    expect(acc.ema).toBeNull();
    expect(acc.sampleSize).toBe(DATA_GATE_MIN - 1);
  });

  test('returns ema + rawAccuracy when at/above DATA_GATE_MIN', () => {
    const all: ComprehensionRecordRow[] = [];
    for (let i = 0; i < DATA_GATE_MIN; i++) {
      all.push(row('confirmed', i));
    }
    const calib = new ComprehensionCalibrator(loaderWith(all));
    const acc = calib.getEngineAccuracy('rule-comprehender');
    expect(acc.insufficient).toBe(false);
    expect(acc.rawAccuracy).toBe(1);
    expect(acc.ema).toBeGreaterThan(0.99);
  });

  test('empty history yields zero samples + insufficient', () => {
    const calib = new ComprehensionCalibrator(loaderWith([]));
    const acc = calib.getEngineAccuracy('rule-comprehender');
    expect(acc.sampleSize).toBe(0);
    expect(acc.insufficient).toBe(true);
    expect(acc.rawAccuracy).toBeNull();
    expect(acc.wilson95).toBeNull();
  });

  test('corrected + abandoned both count as incorrect', () => {
    const data: ComprehensionRecordRow[] = [];
    for (let i = 0; i < 10; i++) data.push(row('confirmed', i));
    for (let i = 0; i < 6; i++) data.push(row('corrected', 100 + i));
    for (let i = 0; i < 4; i++) data.push(row('abandoned', 200 + i));
    const calib = new ComprehensionCalibrator(loaderWith(data));
    const acc = calib.getEngineAccuracy('rule-comprehender');
    // 10 correct / 20 total
    expect(acc.rawAccuracy).toBe(0.5);
  });

  test('EMA weighs recent samples more (loader returns newest first)', () => {
    // Recent 10 all corrected, older 10 all confirmed. With fold-reverse
    // (oldest first, newest last) the EMA finishes near 0 (bad).
    const data: ComprehensionRecordRow[] = [];
    for (let i = 0; i < 10; i++) data.push(row('corrected', 1000 - i)); // newest
    for (let i = 0; i < 10; i++) data.push(row('confirmed', 100 - i));  // oldest
    const calib = new ComprehensionCalibrator(loaderWith(data), { alpha: 0.3 });
    const acc = calib.getEngineAccuracy('rule-comprehender');
    expect(acc.rawAccuracy).toBe(0.5);
    // EMA trends toward recent (all corrected) → should be lower than raw.
    expect(acc.ema).not.toBeNull();
    expect(acc.ema!).toBeLessThan(acc.rawAccuracy!);
  });

  test('confidenceCeiling returns {kind:"unknown", reason:"engine-not-seen"} when empty', () => {
    const calib = new ComprehensionCalibrator(loaderWith([]));
    const r = calib.confidenceCeiling('nonexistent-engine');
    expect(r.kind).toBe('unknown');
    if (r.kind === 'unknown') expect(r.reason).toBe('engine-not-seen');
  });

  test('confidenceCeiling returns {kind:"unknown", reason:"insufficient-data"} below gate', () => {
    const calib = new ComprehensionCalibrator(loaderWith([row('confirmed', 0)]));
    const r = calib.confidenceCeiling('rule-comprehender');
    expect(r.kind).toBe('unknown');
    if (r.kind === 'unknown') expect(r.reason).toBe('insufficient-data');
  });

  test('confidenceCeiling returns {kind:"known", value: ema} when data sufficient', () => {
    const data: ComprehensionRecordRow[] = [];
    for (let i = 0; i < DATA_GATE_MIN; i++) data.push(row('confirmed', i));
    const calib = new ComprehensionCalibrator(loaderWith(data));
    const r = calib.confidenceCeiling('rule-comprehender');
    expect(r.kind).toBe('known');
    if (r.kind === 'known') {
      expect(r.value).toBeGreaterThan(0.99);
      expect(r.value).toBeLessThanOrEqual(1);
    }
  });

  test('confidenceCeiling never conflates unknown with any numeric value', () => {
    // The whole point of A2: downstream code must NOT silently read a
    // magic 0.5 when calibration data is absent.
    const calib = new ComprehensionCalibrator(loaderWith([]));
    const r = calib.confidenceCeiling('x');
    expect('value' in r).toBe(false);
  });

  // ── AXM#3: divergence detection ─────────────────────────────────────

  describe('detectDivergence', () => {
    test('returns null when total samples are too few', () => {
      const data: ComprehensionRecordRow[] = [];
      for (let i = 0; i < 5; i++) data.push(row('confirmed', i));
      const calib = new ComprehensionCalibrator(loaderWith(data));
      expect(calib.detectDivergence('rule-comprehender')).toBeNull();
    });

    test('reports no divergence when recent and historical windows agree', () => {
      const data: ComprehensionRecordRow[] = [];
      // 20 confirmed older, 10 confirmed recent
      for (let i = 0; i < 30; i++) data.push(row('confirmed', 1000 - i));
      const calib = new ComprehensionCalibrator(loaderWith(data));
      const sig = calib.detectDivergence('rule-comprehender');
      expect(sig).not.toBeNull();
      expect(sig!.diverged).toBe(false);
      expect(Math.abs(sig!.delta)).toBeLessThan(0.05);
    });

    test('detects divergence when recent accuracy drops below historical by threshold', () => {
      const data: ComprehensionRecordRow[] = [];
      // Newest first order: 10 corrected recent + 25 confirmed historical.
      for (let i = 0; i < 10; i++) data.push(row('corrected', 2000 - i)); // recent
      for (let i = 0; i < 25; i++) data.push(row('confirmed', 1000 - i)); // historical
      const calib = new ComprehensionCalibrator(loaderWith(data));
      const sig = calib.detectDivergence('rule-comprehender');
      expect(sig).not.toBeNull();
      expect(sig!.diverged).toBe(true);
      expect(sig!.recentAccuracy).toBe(0);
      expect(sig!.historicalAccuracy).toBe(1);
      expect(sig!.delta).toBe(-1);
    });

    test('honors custom threshold (lower = more sensitive)', () => {
      const data: ComprehensionRecordRow[] = [];
      // 30% drop recent (7/10) vs historical (1.0 from 25 confirmed).
      for (let i = 0; i < 7; i++) data.push(row('confirmed', 2000 - i));
      for (let i = 0; i < 3; i++) data.push(row('corrected', 1900 - i));
      for (let i = 0; i < 25; i++) data.push(row('confirmed', 1000 - i));
      const calib = new ComprehensionCalibrator(loaderWith(data));
      const lenient = calib.detectDivergence('rule-comprehender', { deltaThreshold: 0.5 });
      expect(lenient!.diverged).toBe(false); // 30% drop < 50% threshold
      const strict = calib.detectDivergence('rule-comprehender', { deltaThreshold: 0.2 });
      expect(strict!.diverged).toBe(true); // 30% drop > 20% threshold
    });

    test('ignores pending records', () => {
      const data: ComprehensionRecordRow[] = [];
      for (let i = 0; i < 40; i++) data.push(row('confirmed', 1000 - i));
      // recentByEngine (used by calibrator) already filters these upstream,
      // so the loader we inject respects the same contract.
      const calib = new ComprehensionCalibrator(loaderWith(data));
      const sig = calib.detectDivergence('rule-comprehender');
      expect(sig).not.toBeNull();
      expect(sig!.recentSamples + sig!.historicalSamples).toBe(40);
    });
  });

  test('computedAt is monotonic w.r.t. the injected clock', () => {
    const clock = { t: 10_000 };
    const calib = new ComprehensionCalibrator(loaderWith([]), {
      now: () => {
        clock.t += 5;
        return clock.t;
      },
    });
    const a = calib.getEngineAccuracy('x').computedAt;
    const b = calib.getEngineAccuracy('x').computedAt;
    expect(b).toBeGreaterThan(a);
  });
});
