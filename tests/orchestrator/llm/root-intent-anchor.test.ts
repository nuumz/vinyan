/**
 * Behavior tests for the T6 `wrapRootIntentAnchor` reminder helper.
 *
 * Pinned contracts:
 *   - returns null for empty / whitespace-only inputs
 *   - includes original goal verbatim under the cap
 *   - truncates with ellipsis past the 200-char cap
 *   - omits the "current sub-goal" line when current === root
 *   - returned content is wrapped in <vinyan-reminder> tags
 */
import { describe, expect, test } from 'bun:test';
import {
  hasReminderBlock,
  ROOT_INTENT_ANCHOR_CAP,
  wrapRootIntentAnchor,
} from '../../../src/orchestrator/llm/vinyan-reminder.ts';

describe('wrapRootIntentAnchor', () => {
  test('null / empty inputs → null (no reminder)', () => {
    expect(wrapRootIntentAnchor('')).toBeNull();
    expect(wrapRootIntentAnchor('   ')).toBeNull();
    expect(wrapRootIntentAnchor('', 'sub-goal')).toBeNull();
  });

  test('renders original goal inside vinyan-reminder envelope', () => {
    const out = wrapRootIntentAnchor('Implement the dark mode toggle');
    expect(out).not.toBeNull();
    if (!out) return;
    expect(hasReminderBlock(out)).toBe(true);
    expect(out).toContain('[ROOT-INTENT-ANCHOR] Original goal: Implement the dark mode toggle');
    expect(out).toContain('Confirm your next action serves the original goal before acting.');
  });

  test('omits "Current sub-goal" line when current === root', () => {
    const out = wrapRootIntentAnchor('Same goal', 'Same goal');
    expect(out).not.toBeNull();
    if (!out) return;
    expect(out).toContain('Original goal: Same goal');
    expect(out).not.toContain('Current sub-goal');
  });

  test('includes "Current sub-goal" line when distinct', () => {
    const out = wrapRootIntentAnchor('Implement dark mode', 'Wire toggle into Settings page');
    expect(out).not.toBeNull();
    if (!out) return;
    expect(out).toContain('Original goal: Implement dark mode');
    expect(out).toContain('Current sub-goal: Wire toggle into Settings page');
  });

  test('truncates inputs longer than ROOT_INTENT_ANCHOR_CAP with ellipsis', () => {
    const longGoal = 'x'.repeat(ROOT_INTENT_ANCHOR_CAP + 50);
    const out = wrapRootIntentAnchor(longGoal);
    expect(out).not.toBeNull();
    if (!out) return;
    expect(out).toContain('…');
    // The total per-line cap should clamp the visible goal portion to <= cap chars.
    const goalLine = out.split('\n').find((l) => l.includes('Original goal:'));
    expect(goalLine).toBeDefined();
    if (!goalLine) return;
    const renderedGoal = goalLine.replace('[ROOT-INTENT-ANCHOR] Original goal: ', '').trim();
    expect(renderedGoal.length).toBe(ROOT_INTENT_ANCHOR_CAP);
  });

  test('whitespace-only currentGoal does not produce sub-goal line', () => {
    const out = wrapRootIntentAnchor('Real goal', '   ');
    expect(out).not.toBeNull();
    if (!out) return;
    expect(out).not.toContain('Current sub-goal');
  });
});
