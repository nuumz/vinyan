import { describe, test, expect } from "bun:test";
import {
  computeDecay,
  createExperimentState,
  recordCycleScore,
  getActiveDecayFunction,
} from "../../src/sleep-cycle/decay-experiment.ts";

describe("PH3.5: Decay Experiment", () => {
  describe("computeDecay", () => {
    test("exponential: 0.5 at age = halfLife", () => {
      const weight = computeDecay("exponential", 50, 50);
      expect(weight).toBeCloseTo(0.5, 5);
    });

    test("power-law: 0.5 at age = halfLife", () => {
      const weight = computeDecay("power-law", 50, 50);
      expect(weight).toBeCloseTo(0.5, 5);
    });

    test("both return 1.0 at age 0", () => {
      expect(computeDecay("exponential", 0, 50)).toBe(1.0);
      expect(computeDecay("power-law", 0, 50)).toBe(1.0);
    });

    test("power-law decays slower than exponential at 2x halfLife", () => {
      const expWeight = computeDecay("exponential", 100, 50);
      const plWeight = computeDecay("power-law", 100, 50);
      // At 2x halfLife: exp = 0.25, power-law = 1/3 ≈ 0.333
      expect(plWeight).toBeGreaterThan(expWeight);
    });

    test("exponential decays faster at 3x halfLife", () => {
      const expWeight = computeDecay("exponential", 150, 50);
      const plWeight = computeDecay("power-law", 150, 50);
      // exp = 0.125, power-law = 0.25
      expect(plWeight).toBeGreaterThan(expWeight);
      expect(expWeight).toBeCloseTo(0.125, 3);
      expect(plWeight).toBeCloseTo(0.25, 3);
    });

    test("handles edge cases", () => {
      expect(computeDecay("exponential", -1, 50)).toBe(1.0);
      expect(computeDecay("power-law", -1, 50)).toBe(1.0);
      expect(computeDecay("exponential", 10, 0)).toBe(0);
      expect(computeDecay("power-law", 10, 0)).toBe(0);
    });
  });

  describe("experiment lifecycle", () => {
    test("defaults to exponential before evaluation", () => {
      const state = createExperimentState(5);
      expect(getActiveDecayFunction(state)).toBe("exponential");
      expect(state.locked).toBe(false);
    });

    test("locks winner after threshold cycles", () => {
      let state = createExperimentState(3);
      // Power-law scores higher each cycle
      state = recordCycleScore(state, 0.3, 0.5);
      expect(state.locked).toBe(false);
      state = recordCycleScore(state, 0.3, 0.6);
      expect(state.locked).toBe(false);
      state = recordCycleScore(state, 0.3, 0.4);
      expect(state.locked).toBe(true);
      expect(getActiveDecayFunction(state)).toBe("power-law");
    });

    test("exponential wins when it scores higher", () => {
      let state = createExperimentState(3);
      state = recordCycleScore(state, 0.8, 0.3);
      state = recordCycleScore(state, 0.7, 0.4);
      state = recordCycleScore(state, 0.9, 0.2);
      expect(state.locked).toBe(true);
      expect(getActiveDecayFunction(state)).toBe("exponential");
    });

    test("no updates after lock", () => {
      let state = createExperimentState(2);
      state = recordCycleScore(state, 0.3, 0.5);
      state = recordCycleScore(state, 0.3, 0.5);
      expect(state.locked).toBe(true);
      const winner = getActiveDecayFunction(state);

      // Further recordings have no effect
      state = recordCycleScore(state, 100, 0);
      expect(getActiveDecayFunction(state)).toBe(winner);
      expect(state.cyclesRun).toBe(2); // unchanged
    });

    test("tie goes to exponential (incumbent)", () => {
      let state = createExperimentState(2);
      state = recordCycleScore(state, 0.5, 0.5);
      state = recordCycleScore(state, 0.5, 0.5);
      expect(getActiveDecayFunction(state)).toBe("exponential");
    });
  });
});
