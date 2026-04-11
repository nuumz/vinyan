import { describe, expect, test } from 'bun:test';
import { attenuateConfidence, computeHallucinationRisk } from '../../src/hms/risk-scorer.ts';

describe('computeHallucinationRisk', () => {
  test('zero risk when everything is clean', () => {
    const risk = computeHallucinationRisk({
      groundingResult: {
        claims: [],
        verified: 5,
        refuted: 0,
        unverifiable: 0,
        grounding_ratio: 1.0,
        refuted_claims: [],
      },
      overconfidence: {
        certainty_markers: 0,
        hedging_absence: false,
        universal_claims: 0,
        false_precision: 0,
        score: 0,
      },
      oraclePassRatio: 1.0,
      criticConfidence: 0.9,
    });
    expect(risk.score).toBeLessThan(0.1);
  });

  test('high risk when many claims refuted', () => {
    const risk = computeHallucinationRisk({
      groundingResult: {
        claims: [],
        verified: 0,
        refuted: 5,
        unverifiable: 0,
        grounding_ratio: 0.0,
        refuted_claims: [],
      },
      oraclePassRatio: 0.5,
    });
    expect(risk.score).toBeGreaterThan(0.3);
    expect(risk.primary_signal).toBe('grounding');
  });

  test('overconfidence contributes to risk', () => {
    const withOverconf = computeHallucinationRisk({
      overconfidence: {
        certainty_markers: 10,
        hedging_absence: true,
        universal_claims: 5,
        false_precision: 3,
        score: 0.8,
      },
      oraclePassRatio: 1.0,
    });
    const withoutOverconf = computeHallucinationRisk({
      overconfidence: {
        certainty_markers: 0,
        hedging_absence: false,
        universal_claims: 0,
        false_precision: 0,
        score: 0,
      },
      oraclePassRatio: 1.0,
    });
    expect(withOverconf.score).toBeGreaterThan(withoutOverconf.score);
  });

  test('structural risk from oracle failures', () => {
    const risk = computeHallucinationRisk({ oraclePassRatio: 0.2 });
    expect(risk.signals.structural).toBeCloseTo(0.8, 3);
  });

  test('cross-validation lowers risk when consistent', () => {
    const consistent = computeHallucinationRisk({
      oraclePassRatio: 0.5,
      crossValidation: { consistency: 0.95, probes_sent: 10 },
    });
    const inconsistent = computeHallucinationRisk({
      oraclePassRatio: 0.5,
      crossValidation: { consistency: 0.2, probes_sent: 10 },
    });
    expect(consistent.score).toBeLessThan(inconsistent.score);
  });

  test('score is always in [0, 1]', () => {
    const risk = computeHallucinationRisk({
      groundingResult: {
        claims: [],
        verified: 0,
        refuted: 100,
        unverifiable: 0,
        grounding_ratio: 0,
        refuted_claims: [],
      },
      overconfidence: {
        certainty_markers: 50,
        hedging_absence: true,
        universal_claims: 50,
        false_precision: 50,
        score: 1.0,
      },
      oraclePassRatio: 0,
      criticConfidence: 0,
      crossValidation: { consistency: 0, probes_sent: 50 },
    });
    expect(risk.score).toBeLessThanOrEqual(1.0);
    expect(risk.score).toBeGreaterThanOrEqual(0);
  });
});

describe('attenuateConfidence', () => {
  test('no attenuation at zero risk', () => {
    const risk = { score: 0, primary_signal: 'none', signals: {} };
    expect(attenuateConfidence(0.9, risk)).toBeCloseTo(0.9, 5);
  });

  test('50% attenuation at max risk', () => {
    const risk = { score: 1.0, primary_signal: 'grounding', signals: {} };
    expect(attenuateConfidence(0.9, risk)).toBeCloseTo(0.45, 5);
  });

  test('proportional attenuation', () => {
    const risk = { score: 0.5, primary_signal: 'grounding', signals: {} };
    expect(attenuateConfidence(1.0, risk)).toBeCloseTo(0.75, 5);
  });
});
