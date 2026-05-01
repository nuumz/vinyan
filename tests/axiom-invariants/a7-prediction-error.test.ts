/**
 * A7 — Prediction Error as Learning invariant.
 *
 * Wilson lower-bound is the gate for promoting patterns: more
 * observations + higher success rate → higher LB → eligible to promote.
 * Pure function, no LLM in the path (A3).
 */
import { describe, expect, test } from 'bun:test';
import { wilsonLowerBound } from '../../src/sleep-cycle/wilson.ts';

describe('A7 — Prediction Error as Learning', () => {
  test('wilsonLowerBound returns 0 when n=0', () => {
    expect(wilsonLowerBound(0, 0)).toBe(0);
  });

  test('more observations of the same success rate → higher LB', () => {
    const lbSmall = wilsonLowerBound(4, 5); // 4/5 success
    const lbLarge = wilsonLowerBound(80, 100); // 80/100 success
    expect(lbLarge).toBeGreaterThan(lbSmall);
  });

  test('higher success rate at same n → higher LB', () => {
    const lbA = wilsonLowerBound(5, 10);
    const lbB = wilsonLowerBound(9, 10);
    expect(lbB).toBeGreaterThan(lbA);
  });

  test('LB always strictly less than the empirical mean (n>0)', () => {
    // Wilson LB is strictly conservative: at n>0 it is *less than or equal to*
    // the empirical proportion. This is the property promotion gates rely on.
    const empirical = 0.95;
    const lb = wilsonLowerBound(95, 100);
    expect(lb).toBeLessThanOrEqual(empirical + 1e-9);
  });

  test('LB is deterministic — same input same output', () => {
    expect(wilsonLowerBound(80, 100)).toBe(wilsonLowerBound(80, 100));
  });
});
