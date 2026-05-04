/**
 * Behavior tests for the T3 selection-margin debate trigger.
 *
 * Pinned contracts:
 *   - margin < threshold fires debate even on low risk score
 *   - margin >= threshold does NOT fire on its own (still needs risk signal)
 *   - manual override 'skip' wins over margin trigger
 *   - manual override 'force' fires regardless
 *   - undefined margin → legacy risk-only behavior unchanged
 */
import { describe, expect, test } from 'bun:test';
import { shouldDebate } from '../../../src/orchestrator/critic/debate-mode.ts';

describe('shouldDebate — selection margin trigger (T3)', () => {
  test('margin below default threshold (0.05) fires debate even on low risk', () => {
    expect(shouldDebate({ riskScore: 0.1, selectionMargin: 0.02 })).toBe(true);
  });

  test('margin at threshold does NOT fire (strict less-than)', () => {
    expect(shouldDebate({ riskScore: 0.1, selectionMargin: 0.05 })).toBe(false);
  });

  test('margin above threshold does NOT fire on its own', () => {
    expect(shouldDebate({ riskScore: 0.1, selectionMargin: 0.5 })).toBe(false);
  });

  test('custom marginThreshold overrides the default', () => {
    expect(shouldDebate({ riskScore: 0.1, selectionMargin: 0.08, marginThreshold: 0.1 })).toBe(true);
    expect(shouldDebate({ riskScore: 0.1, selectionMargin: 0.12, marginThreshold: 0.1 })).toBe(false);
  });

  test('high risk + tied margin still fires (risk path wins)', () => {
    expect(shouldDebate({ riskScore: 0.9, selectionMargin: 0.5 })).toBe(true);
  });

  test('manualOverride skip blocks margin trigger', () => {
    expect(shouldDebate({ riskScore: 0.1, selectionMargin: 0.01, manualOverride: 'skip' })).toBe(false);
  });

  test('manualOverride force fires regardless of margin', () => {
    expect(shouldDebate({ riskScore: 0.0, selectionMargin: 0.5, manualOverride: 'force' })).toBe(true);
  });

  test('undefined selectionMargin preserves legacy risk-only behavior', () => {
    expect(shouldDebate({ riskScore: 0.5 })).toBe(false); // below default 0.7
    expect(shouldDebate({ riskScore: 0.8 })).toBe(true); // above default 0.7
  });
});
