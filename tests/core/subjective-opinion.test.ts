import { describe, expect, test } from 'bun:test';
import {
  dogmatic,
  fromScalar,
  isValid,
  isVacuous,
  projectedProbability,
  resolveOpinion,
  SubjectiveOpinionSchema,
  vacuous,
} from '../../src/core/subjective-opinion.ts';

describe('fromScalar', () => {
  test('maps 0.8 to dogmatic opinion with default baseRate', () => {
    const o = fromScalar(0.8);
    expect(o.belief).toBe(0.8);
    expect(o.disbelief).toBeCloseTo(0.2);
    expect(o.uncertainty).toBe(0);
    expect(o.baseRate).toBe(0.5);
  });

  test('maps 0.0 to full disbelief', () => {
    const o = fromScalar(0.0);
    expect(o.belief).toBe(0);
    expect(o.disbelief).toBe(1);
    expect(o.uncertainty).toBe(0);
  });

  test('maps 1.0 to full belief', () => {
    const o = fromScalar(1.0);
    expect(o.belief).toBe(1);
    expect(o.disbelief).toBe(0);
    expect(o.uncertainty).toBe(0);
  });

  test('respects custom baseRate', () => {
    const o = fromScalar(0.6, 0.3);
    expect(o.baseRate).toBe(0.3);
  });

  test('b + d + u = 1.0', () => {
    const o = fromScalar(0.7);
    expect(o.belief + o.disbelief + o.uncertainty).toBeCloseTo(1.0);
  });
});

describe('projectedProbability', () => {
  test('P = b + a*u for mixed opinion', () => {
    const o = { belief: 0.6, disbelief: 0.2, uncertainty: 0.2, baseRate: 0.5 };
    // P = 0.6 + 0.5 * 0.2 = 0.7
    expect(projectedProbability(o)).toBeCloseTo(0.7);
  });

  test('P = b when u = 0 (dogmatic)', () => {
    const o = fromScalar(0.9);
    expect(projectedProbability(o)).toBeCloseTo(0.9);
  });

  test('P = baseRate when u = 1 (vacuous)', () => {
    const o = vacuous(0.4);
    // P = 0 + 0.4 * 1 = 0.4
    expect(projectedProbability(o)).toBeCloseTo(0.4);
  });
});

describe('vacuous', () => {
  test('returns maximum uncertainty opinion', () => {
    const o = vacuous();
    expect(o.belief).toBe(0);
    expect(o.disbelief).toBe(0);
    expect(o.uncertainty).toBe(1);
    expect(o.baseRate).toBe(0.5);
  });

  test('isVacuous returns true', () => {
    expect(isVacuous(vacuous())).toBe(true);
  });

  test('respects custom baseRate', () => {
    const o = vacuous(0.7);
    expect(o.baseRate).toBe(0.7);
  });
});

describe('dogmatic', () => {
  test('returns zero uncertainty opinion', () => {
    const o = dogmatic(0.9);
    expect(o.belief).toBe(0.9);
    expect(o.disbelief).toBeCloseTo(0.1);
    expect(o.uncertainty).toBe(0);
    expect(o.baseRate).toBe(0.5);
  });

  test('isVacuous returns false for dogmatic opinion', () => {
    expect(isVacuous(dogmatic(0.9))).toBe(false);
  });
});

describe('isVacuous', () => {
  test('returns true for vacuous opinion (u=1 > default threshold 0.95)', () => {
    expect(isVacuous(vacuous())).toBe(true);
  });

  test('returns false for dogmatic opinion (u=0)', () => {
    expect(isVacuous(dogmatic(0.8))).toBe(false);
  });

  test('returns false for opinion with u=0.9 (below default threshold 0.95)', () => {
    const o = { belief: 0.05, disbelief: 0.05, uncertainty: 0.9, baseRate: 0.5 };
    expect(isVacuous(o)).toBe(false);
  });

  test('respects custom threshold', () => {
    const o = { belief: 0.05, disbelief: 0.05, uncertainty: 0.9, baseRate: 0.5 };
    expect(isVacuous(o, 0.85)).toBe(true);
  });
});

describe('isValid', () => {
  test('returns true for valid opinion (b+d+u=1)', () => {
    expect(isValid(fromScalar(0.7))).toBe(true);
  });

  test('returns true for vacuous opinion', () => {
    expect(isValid(vacuous())).toBe(true);
  });

  test('returns false when b+d+u != 1', () => {
    const o = { belief: 0.5, disbelief: 0.5, uncertainty: 0.5, baseRate: 0.5 };
    expect(isValid(o)).toBe(false);
  });

  test('returns false when component out of [0,1]', () => {
    const o = { belief: -0.1, disbelief: 0.6, uncertainty: 0.5, baseRate: 0.5 };
    expect(isValid(o)).toBe(false);
  });

  test('accepts tiny floating-point error (< 1e-9)', () => {
    const belief = 0.1 + 0.2; // floating-point: ~0.30000000000000004
    const disbelief = 1 - belief;
    const o = { belief, disbelief, uncertainty: 0, baseRate: 0.5 };
    // 0.30000000000000004 + 0.6999999999999999 + 0 ≈ 1.0 within tolerance
    expect(isValid(o)).toBe(true);
  });
});

describe('SubjectiveOpinionSchema', () => {
  test('parses valid opinion', () => {
    const result = SubjectiveOpinionSchema.safeParse({ belief: 0.5, disbelief: 0.3, uncertainty: 0.2, baseRate: 0.5 });
    expect(result.success).toBe(true);
  });

  test('rejects when b+d+u != 1', () => {
    const result = SubjectiveOpinionSchema.safeParse({ belief: 0.5, disbelief: 0.5, uncertainty: 0.5, baseRate: 0.5 });
    expect(result.success).toBe(false);
  });
});

describe('resolveOpinion', () => {
  test('returns provided opinion when valid', () => {
    const opinion = { belief: 0.6, disbelief: 0.2, uncertainty: 0.2, baseRate: 0.5 };
    const result = resolveOpinion({ confidence: 0.9, opinion });
    expect(result).toEqual(opinion);
  });

  test('falls back to fromScalar when no opinion provided', () => {
    const result = resolveOpinion({ confidence: 0.75 });
    // resolveOpinion defaults to defaultUncertainty=0.3
    expect(result).toEqual(fromScalar(0.75, 0.5, 0.3));
  });

  test('falls back to fromScalar when opinion is invalid', () => {
    const invalidOpinion = { belief: 0.5, disbelief: 0.5, uncertainty: 0.5, baseRate: 0.5 };
    const result = resolveOpinion({ confidence: 0.8, opinion: invalidOpinion });
    expect(result).toEqual(fromScalar(0.8, 0.5, 0.3));
  });

  test('respects custom baseRate for fallback', () => {
    const result = resolveOpinion({ confidence: 0.6 }, 0.3);
    expect(result.baseRate).toBe(0.3);
  });
});
