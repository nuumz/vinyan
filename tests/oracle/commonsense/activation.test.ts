import { beforeEach, describe, expect, test } from 'bun:test';
import {
  ActivationDebouncer,
  DEFAULT_ACTIVATION_CONFIG,
  shouldActivate,
} from '../../../src/oracle/commonsense/activation.ts';

let now = 0;
let debouncer: ActivationDebouncer;

beforeEach(() => {
  now = 1_000_000;
  debouncer = new ActivationDebouncer(() => now);
});

const baseInput = {
  taskTypeSignature: 'edit::ts::small',
  observationCount: 100,
  predictionAccuracy: 0.95,
  mutationAction: 'mutation-additive' as const,
};

describe('shouldActivate — cold-start gate', () => {
  test('always activates when observationCount < threshold', () => {
    const d = shouldActivate(
      { ...baseInput, observationCount: 0, predictionAccuracy: 0.5 },
      debouncer,
    );
    expect(d.activate).toBe(true);
    expect(d.reason).toBe('cold-start');
  });

  test('activates at threshold-1', () => {
    const d = shouldActivate(
      { ...baseInput, observationCount: DEFAULT_ACTIVATION_CONFIG.coldStartObsThreshold - 1 },
      debouncer,
    );
    expect(d.activate).toBe(true);
    expect(d.reason).toBe('cold-start');
  });

  test('does NOT activate at threshold (cold-start ends)', () => {
    const d = shouldActivate(
      { ...baseInput, observationCount: DEFAULT_ACTIVATION_CONFIG.coldStartObsThreshold },
      debouncer,
    );
    expect(d.reason).not.toBe('cold-start');
  });
});

describe('shouldActivate — risk override', () => {
  test('activates when riskScore >= 0.6', () => {
    const d = shouldActivate({ ...baseInput, riskScore: 0.6 }, debouncer);
    expect(d.activate).toBe(true);
    expect(d.reason).toBe('risk-threshold');
  });

  test('does NOT activate when riskScore < 0.6 (with no other trigger)', () => {
    const d = shouldActivate({ ...baseInput, riskScore: 0.3 }, debouncer);
    expect(d.activate).toBe(false);
  });

  test('risk override fires even with high prediction accuracy', () => {
    const d = shouldActivate(
      { ...baseInput, predictionAccuracy: 0.99, riskScore: 0.7 },
      debouncer,
    );
    expect(d.activate).toBe(true);
    expect(d.reason).toBe('risk-threshold');
  });
});

describe('shouldActivate — destructive mutation override', () => {
  test('activates on mutation-destructive regardless of other signals', () => {
    const d = shouldActivate(
      { ...baseInput, mutationAction: 'mutation-destructive', predictionAccuracy: 0.99 },
      debouncer,
    );
    expect(d.activate).toBe(true);
    expect(d.reason).toBe('destructive-mutation');
  });

  test('does NOT activate on mutation-additive (without other triggers)', () => {
    const d = shouldActivate({ ...baseInput, mutationAction: 'mutation-additive' }, debouncer);
    expect(d.activate).toBe(false);
  });
});

describe('shouldActivate — surprise gate', () => {
  test('activates when predictionError > 2σ AND dwell satisfied', () => {
    // p = 0.95 → sigma = sqrt(0.95 * 0.05) = ~0.218 → 2σ ≈ 0.436
    // First call: surprise observed but dwell not yet exceeded → not activate
    const d1 = shouldActivate(
      { ...baseInput, predictionAccuracy: 0.95, predictionError: 1.0 },
      debouncer,
    );
    expect(d1.activate).toBe(false);
    expect(d1.reason).toBe('surprise-but-dwelling');

    // Advance clock past dwellMs
    now += DEFAULT_ACTIVATION_CONFIG.minDwellMs + 1;

    // Second call: dwell exceeded → activate
    const d2 = shouldActivate(
      { ...baseInput, predictionAccuracy: 0.95, predictionError: 1.0 },
      debouncer,
    );
    expect(d2.activate).toBe(true);
    expect(d2.reason).toBe('surprise');
  });

  test('does NOT activate when error within 2σ (using EMA fallback)', () => {
    // p = 0.95: error fallback = 0.05; 2σ = 0.436. 0.05 < 0.436 → no surprise.
    const d = shouldActivate(
      { ...baseInput, predictionAccuracy: 0.95 }, // no explicit predictionError
      debouncer,
    );
    expect(d.activate).toBe(false);
    expect(d.reason).toBe('no-trigger');
  });

  test('surprise must be sustained — single-shot does not fire', () => {
    // First surprise observation
    shouldActivate(
      { ...baseInput, predictionAccuracy: 0.95, predictionError: 1.0 },
      debouncer,
    );
    // Right after: condition resolves (error drops)
    const d = shouldActivate(
      { ...baseInput, predictionAccuracy: 0.95, predictionError: 0.0 },
      debouncer,
    );
    expect(d.activate).toBe(false);
    // Surprise gate cleared because condition dropped
    now += DEFAULT_ACTIVATION_CONFIG.minDwellMs + 100;
    const d2 = shouldActivate(
      { ...baseInput, predictionAccuracy: 0.95, predictionError: 1.0 },
      debouncer,
    );
    // First time again — dwell starts over, not yet exceeded
    expect(d2.activate).toBe(false);
  });
});

describe('shouldActivate — cool-down', () => {
  test('keeps activated for coolDownMs after a firing', () => {
    // Force activation via destructive mutation
    const d1 = shouldActivate(
      { ...baseInput, mutationAction: 'mutation-destructive' },
      debouncer,
    );
    expect(d1.activate).toBe(true);

    // Right after, with no surprise / risk / destructive
    now += 1000;
    const d2 = shouldActivate({ ...baseInput }, debouncer);
    expect(d2.activate).toBe(true);
    expect(d2.reason).toBe('cool-down');

    // After cool-down expires
    now += DEFAULT_ACTIVATION_CONFIG.coolDownMs + 100;
    const d3 = shouldActivate({ ...baseInput }, debouncer);
    expect(d3.activate).toBe(false);
  });

  test('cool-down is per-key — does not leak across task signatures', () => {
    shouldActivate(
      {
        ...baseInput,
        taskTypeSignature: 'edit::ts',
        mutationAction: 'mutation-destructive',
      },
      debouncer,
    );
    // Different signature should NOT inherit the cool-down
    now += 1000;
    const d = shouldActivate(
      { ...baseInput, taskTypeSignature: 'add::py' },
      debouncer,
    );
    expect(d.activate).toBe(false);
  });
});

describe('shouldActivate — priority order', () => {
  test('cold-start beats every other trigger', () => {
    const d = shouldActivate(
      {
        ...baseInput,
        observationCount: 5,
        riskScore: 0.9,
        mutationAction: 'mutation-destructive',
      },
      debouncer,
    );
    expect(d.reason).toBe('cold-start');
  });

  test('risk beats destructive when not in cold-start', () => {
    const d = shouldActivate(
      {
        ...baseInput,
        riskScore: 0.7,
        mutationAction: 'mutation-destructive',
      },
      debouncer,
    );
    expect(d.reason).toBe('risk-threshold');
  });
});
