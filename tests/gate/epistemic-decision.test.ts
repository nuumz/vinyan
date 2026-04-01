import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_THRESHOLDS,
  deriveEpistemicDecision,
  generateResolutionHints,
  toClassicDecision,
} from '../../src/gate/epistemic-decision.ts';

describe('deriveEpistemicDecision', () => {
  test('0.90, not all-abstained → allow', () => {
    expect(deriveEpistemicDecision(0.90, false)).toBe('allow');
  });

  test('0.85 (boundary) → allow', () => {
    expect(deriveEpistemicDecision(0.85, false)).toBe('allow');
  });

  test('0.65 → allow-with-caveats', () => {
    expect(deriveEpistemicDecision(0.65, false)).toBe('allow-with-caveats');
  });

  test('0.60 (boundary) → allow-with-caveats', () => {
    expect(deriveEpistemicDecision(0.60, false)).toBe('allow-with-caveats');
  });

  test('0.45 → uncertain', () => {
    expect(deriveEpistemicDecision(0.45, false)).toBe('uncertain');
  });

  test('0.40 (boundary) → uncertain', () => {
    expect(deriveEpistemicDecision(0.40, false)).toBe('uncertain');
  });

  test('0.15, not all-abstained → block', () => {
    expect(deriveEpistemicDecision(0.15, false)).toBe('block');
  });

  test('0.0 → block', () => {
    expect(deriveEpistemicDecision(0.0, false)).toBe('block');
  });

  test('NaN, all abstained → block', () => {
    expect(deriveEpistemicDecision(Number.NaN, true)).toBe('block');
  });

  test('NaN, not all-abstained → block', () => {
    expect(deriveEpistemicDecision(Number.NaN, false)).toBe('block');
  });

  test('0.90 but all oracles abstained → block', () => {
    expect(deriveEpistemicDecision(0.90, true)).toBe('block');
  });

  test('respects custom thresholds', () => {
    const custom = { HIGH_CONFIDENCE: 0.95, ADEQUATE_CONFIDENCE: 0.75, LOW_CONFIDENCE: 0.50, UNCERTAIN: 0.30 };
    expect(deriveEpistemicDecision(0.90, false, custom)).toBe('allow-with-caveats');
    expect(deriveEpistemicDecision(0.97, false, custom)).toBe('allow');
  });
});

describe('toClassicDecision', () => {
  test("'allow' → 'allow'", () => {
    expect(toClassicDecision('allow')).toBe('allow');
  });

  test("'allow-with-caveats' → 'allow'", () => {
    expect(toClassicDecision('allow-with-caveats')).toBe('allow');
  });

  test("'uncertain' → 'block'", () => {
    expect(toClassicDecision('uncertain')).toBe('block');
  });

  test("'block' → 'block'", () => {
    expect(toClassicDecision('block')).toBe('block');
  });
});

describe('generateResolutionHints', () => {
  test('no_test_files abstention → add-tests hint', () => {
    const hints = generateResolutionHints(['no_test_files'], 0.5);
    expect(hints).toContain('add-tests');
  });

  test('no_linter_configured abstention → add-linter hint', () => {
    const hints = generateResolutionHints(['no_linter_configured'], 0.5);
    expect(hints).toContain('add-linter');
  });

  test('very low confidence (< UNCERTAIN threshold) → human-review', () => {
    const hints = generateResolutionHints([], DEFAULT_THRESHOLDS.UNCERTAIN - 0.01);
    expect(hints).toContain('human-review');
  });

  test('low confidence (between UNCERTAIN and ADEQUATE) → escalate-routing', () => {
    const hints = generateResolutionHints([], 0.35);
    expect(hints).toContain('escalate-routing');
    expect(hints).toContain('run-deeper-analysis');
  });

  test('adequate confidence → no routing hints', () => {
    const hints = generateResolutionHints([], 0.65);
    expect(hints).not.toContain('escalate-routing');
    expect(hints).not.toContain('human-review');
  });

  test('multiple abstention reasons → multiple hints', () => {
    const hints = generateResolutionHints(['no_test_files', 'no_linter_configured'], 0.1);
    expect(hints).toContain('add-tests');
    expect(hints).toContain('add-linter');
  });
});
