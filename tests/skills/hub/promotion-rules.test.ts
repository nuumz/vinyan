/**
 * Promotion-rule tests — every branch of `decidePromotion`.
 *
 * A3 proof-of-determinism: same inputs → same decision, no LLM in the
 * decision path.
 */
import { describe, expect, test } from 'bun:test';
import { decidePromotion, HUB_IMPORT_RULE_ID, type PromotionInputs } from '../../../src/skills/hub/promotion-rules.ts';

function baseInputs(overrides: Partial<PromotionInputs> = {}): PromotionInputs {
  return {
    staticScan: { injectionFound: false, bypassFound: false, suspicious: [] },
    gateVerdict: { decision: 'verified', aggregateConfidence: 0.9 },
    critic: { approved: true, confidence: 0.9, notes: '' },
    signatureVerified: false,
    origin: 'hub',
    declaredTier: 'probabilistic',
    ...overrides,
  };
}

describe('decidePromotion', () => {
  test('injection detection rejects with static-scan reason', () => {
    const d = decidePromotion(
      baseInputs({
        staticScan: {
          injectionFound: true,
          bypassFound: false,
          suspicious: ['role-override'],
        },
      }),
    );
    expect(d.kind).toBe('reject');
    expect(d.reason).toBe('static-scan');
    expect(d.ruleId).toBe(HUB_IMPORT_RULE_ID);
  });

  test('bypass detection rejects with static-scan reason', () => {
    const d = decidePromotion(
      baseInputs({
        staticScan: { injectionFound: false, bypassFound: true, suspicious: ['sudo'] },
      }),
    );
    expect(d.kind).toBe('reject');
    expect(d.reason).toBe('static-scan');
  });

  test('gate falsified rejects with gate-falsified reason', () => {
    const d = decidePromotion(baseInputs({ gateVerdict: { decision: 'falsified', aggregateConfidence: 0.1 } }));
    expect(d.kind).toBe('reject');
    expect(d.reason).toBe('gate-falsified');
  });

  test('critic rejection rejects with critic-rejected reason', () => {
    const d = decidePromotion(baseInputs({ critic: { approved: false, confidence: 0.8, notes: 'nope' } }));
    expect(d.kind).toBe('reject');
    expect(d.reason).toBe('critic-rejected');
  });

  test('gate unknown → quarantine-continue', () => {
    const d = decidePromotion(baseInputs({ gateVerdict: { decision: 'unknown', aggregateConfidence: 0 } }));
    expect(d.kind).toBe('quarantine-continue');
    expect(d.reason).toBe('gate-unknown');
  });

  test('gate contradictory → quarantine-continue', () => {
    const d = decidePromotion(baseInputs({ gateVerdict: { decision: 'contradictory', aggregateConfidence: 0.5 } }));
    expect(d.kind).toBe('quarantine-continue');
    expect(d.reason).toBe('gate-contradictory');
  });

  test('gate uncertain → reject (conservative)', () => {
    const d = decidePromotion(baseInputs({ gateVerdict: { decision: 'uncertain', aggregateConfidence: 0.3 } }));
    expect(d.kind).toBe('reject');
    expect(d.reason).toBe('gate-uncertain');
  });

  test('aggregate confidence below floor rejects', () => {
    const d = decidePromotion(baseInputs({ gateVerdict: { decision: 'verified', aggregateConfidence: 0.5 } }));
    expect(d.kind).toBe('reject');
    expect(d.reason).toBe('gate-low-confidence');
  });

  test('verified + unsigned promotes to probabilistic', () => {
    const d = decidePromotion(baseInputs({ signatureVerified: false, origin: 'hub' }));
    expect(d.kind).toBe('promote');
    expect(d.toTier).toBe('probabilistic');
    expect(d.reason).toBe('ok');
    expect(d.ruleId).toBe(HUB_IMPORT_RULE_ID);
  });

  test('verified + signed + hub origin promotes to heuristic', () => {
    const d = decidePromotion(baseInputs({ signatureVerified: true, origin: 'hub' }));
    expect(d.kind).toBe('promote');
    expect(d.toTier).toBe('heuristic');
  });

  test('verified + signed + non-hub origin still floors at probabilistic', () => {
    const d = decidePromotion(baseInputs({ signatureVerified: true, origin: 'mcp' }));
    expect(d.kind).toBe('promote');
    expect(d.toTier).toBe('probabilistic');
  });

  test('deterministic: identical inputs produce identical decisions', () => {
    const input = baseInputs();
    const a = decidePromotion(input);
    const b = decidePromotion(input);
    expect(a).toEqual(b);
  });
});
