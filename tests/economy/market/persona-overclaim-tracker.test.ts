/**
 * Phase-12 PersonaOverclaimTracker — persona-keyed overclaim ledger.
 *
 * Covers:
 *   - cold-start: < MIN_OBSERVATIONS_FOR_PENALTY → penalty 1.0
 *   - past cold-start: ratio drives penalty linearly down to 1 - MAX_PENALTY_DEPTH
 *   - cap at MAX_PENALTY_DEPTH (50% overclaim doesn't go below 0.5x)
 *   - personas isolated from each other
 *   - reset wipes all state
 */
import { describe, expect, test } from 'bun:test';
import {
  MAX_PENALTY_DEPTH,
  MIN_OBSERVATIONS_FOR_PENALTY,
  PersonaOverclaimTracker,
} from '../../../src/economy/market/persona-overclaim-tracker.ts';

describe('PersonaOverclaimTracker — record/snapshot', () => {
  test('unknown persona reports null record / 0 ratio / 1.0 penalty', () => {
    const t = new PersonaOverclaimTracker();
    expect(t.getRecord('developer')).toBeNull();
    expect(t.getOverclaimRatio('developer')).toBe(0);
    expect(t.getPenaltyMultiplier('developer')).toBe(1);
  });

  test('recordObservation/recordOverclaim accumulate independently', () => {
    const t = new PersonaOverclaimTracker();
    for (let i = 0; i < 5; i++) t.recordObservation('developer');
    t.recordOverclaim('developer');
    t.recordOverclaim('developer');
    const r = t.getRecord('developer');
    expect(r).toEqual({ observations: 5, overclaims: 2 });
  });

  test('personas are isolated', () => {
    const t = new PersonaOverclaimTracker();
    t.recordObservation('developer');
    t.recordOverclaim('developer');
    t.recordObservation('reviewer');
    expect(t.getRecord('developer')).toEqual({ observations: 1, overclaims: 1 });
    expect(t.getRecord('reviewer')).toEqual({ observations: 1, overclaims: 0 });
  });

  test('reset wipes all state', () => {
    const t = new PersonaOverclaimTracker();
    t.recordObservation('developer');
    t.recordOverclaim('developer');
    t.reset();
    expect(t.getRecord('developer')).toBeNull();
  });
});

describe('PersonaOverclaimTracker — getOverclaimRatio', () => {
  test('observations=0 → 0', () => {
    const t = new PersonaOverclaimTracker();
    t.recordOverclaim('developer'); // bizarre but possible: overclaim before any observation
    expect(t.getOverclaimRatio('developer')).toBe(0);
  });

  test('clean record: observations only → ratio 0', () => {
    const t = new PersonaOverclaimTracker();
    for (let i = 0; i < 20; i++) t.recordObservation('developer');
    expect(t.getOverclaimRatio('developer')).toBe(0);
  });

  test('25% overclaim ratio', () => {
    const t = new PersonaOverclaimTracker();
    for (let i = 0; i < 20; i++) t.recordObservation('developer');
    for (let i = 0; i < 5; i++) t.recordOverclaim('developer');
    expect(t.getOverclaimRatio('developer')).toBe(0.25);
  });

  test('ratio capped at 1.0 even with absurd overclaim count', () => {
    const t = new PersonaOverclaimTracker();
    t.recordObservation('developer');
    for (let i = 0; i < 100; i++) t.recordOverclaim('developer');
    expect(t.getOverclaimRatio('developer')).toBe(1);
  });
});

describe('PersonaOverclaimTracker — getPenaltyMultiplier', () => {
  test('cold-start (< MIN_OBSERVATIONS_FOR_PENALTY) → 1.0 even with overclaims', () => {
    expect(MIN_OBSERVATIONS_FOR_PENALTY).toBe(10);
    const t = new PersonaOverclaimTracker();
    for (let i = 0; i < MIN_OBSERVATIONS_FOR_PENALTY - 1; i++) t.recordObservation('developer');
    for (let i = 0; i < MIN_OBSERVATIONS_FOR_PENALTY - 1; i++) t.recordOverclaim('developer');
    // 9 observations, 9 overclaims = 100% ratio — but cold-start, no penalty
    expect(t.getPenaltyMultiplier('developer')).toBe(1);
  });

  test('past cold-start, 0% overclaim → 1.0 (no penalty)', () => {
    const t = new PersonaOverclaimTracker();
    for (let i = 0; i < 20; i++) t.recordObservation('developer');
    expect(t.getPenaltyMultiplier('developer')).toBe(1);
  });

  test('past cold-start, 25% overclaim → 0.75', () => {
    const t = new PersonaOverclaimTracker();
    for (let i = 0; i < 20; i++) t.recordObservation('developer');
    for (let i = 0; i < 5; i++) t.recordOverclaim('developer');
    expect(t.getPenaltyMultiplier('developer')).toBe(0.75);
  });

  test('past cold-start, 50% overclaim → 0.5 (floor)', () => {
    const t = new PersonaOverclaimTracker();
    for (let i = 0; i < 20; i++) t.recordObservation('developer');
    for (let i = 0; i < 10; i++) t.recordOverclaim('developer');
    expect(t.getPenaltyMultiplier('developer')).toBe(0.5);
  });

  test('past cold-start, 100% overclaim → still floors at 1 - MAX_PENALTY_DEPTH', () => {
    expect(MAX_PENALTY_DEPTH).toBe(0.5);
    const t = new PersonaOverclaimTracker();
    for (let i = 0; i < 20; i++) {
      t.recordObservation('developer');
      t.recordOverclaim('developer');
    }
    expect(t.getPenaltyMultiplier('developer')).toBe(1 - MAX_PENALTY_DEPTH);
  });
});
