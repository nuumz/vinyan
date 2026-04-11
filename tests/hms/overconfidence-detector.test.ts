import { describe, expect, test } from 'bun:test';
import { detectOverconfidence } from '../../src/hms/overconfidence-detector.ts';

describe('detectOverconfidence', () => {
  test('low score for hedged text', () => {
    const text =
      'I think this might work. Perhaps we could try this approach, but I am not sure if it will solve the issue. It seems like the function could be related to authentication, though I am uncertain about the exact behavior.';
    const signals = detectOverconfidence(text);
    expect(signals.score).toBeLessThan(0.3);
    expect(signals.hedging_absence).toBe(false);
  });

  test('high score for overconfident text', () => {
    const text =
      'This will definitely work. It is absolutely the correct approach and will always produce the right result. There is guaranteed no issue with this implementation. Without question, this is 100% correct in all cases.';
    const signals = detectOverconfidence(text);
    expect(signals.score).toBeGreaterThan(0.5);
    expect(signals.certainty_markers).toBeGreaterThan(0);
  });

  test('hedging_absence true for short assertive text', () => {
    // Short text (< 50 words) should NOT trigger hedging_absence
    const short = 'The function returns a number.';
    expect(detectOverconfidence(short).hedging_absence).toBe(false);
  });

  test('hedging_absence true for long text without hedging', () => {
    const long = Array(60).fill('This code is correct and works.').join(' ');
    expect(detectOverconfidence(long).hedging_absence).toBe(true);
  });

  test('detects universal claims', () => {
    const text =
      'This always works. It never fails. In all cases and every time, there are no exceptions to this behavior in all situations.';
    const signals = detectOverconfidence(text);
    expect(signals.universal_claims).toBeGreaterThan(2);
  });

  test('neutral score for balanced text', () => {
    const text =
      'Based on the code, this function likely handles authentication. It might return null when the token is invalid, but I need to verify this. The implementation seems to follow the standard pattern used elsewhere in the codebase.';
    const signals = detectOverconfidence(text);
    expect(signals.score).toBeLessThan(0.4);
  });

  test('score clamped to [0, 1]', () => {
    const extreme =
      'Definitely absolutely certainly always never guaranteed 100% without question in all cases every time no exceptions.';
    const signals = detectOverconfidence(extreme);
    expect(signals.score).toBeLessThanOrEqual(1.0);
    expect(signals.score).toBeGreaterThanOrEqual(0);
  });
});
