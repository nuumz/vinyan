/**
 * Tests for the Vinyan reminder block helper.
 *
 * Verifies the `<vinyan-reminder>` tag wrapping contract, empty-case handling,
 * and the protocol description surface area that the worker's system prompt
 * depends on.
 */
import { describe, expect, test } from 'bun:test';
import {
  wrapReminder,
  hasReminderBlock,
  REMINDER_PROTOCOL_DESCRIPTION,
} from '../../../src/orchestrator/llm/vinyan-reminder.ts';

// ── wrapReminder ─────────────────────────────────────────────────────

describe('wrapReminder', () => {
  test('returns null for null input', () => {
    expect(wrapReminder(null)).toBeNull();
  });

  test('returns null for undefined input', () => {
    expect(wrapReminder(undefined)).toBeNull();
  });

  test('returns null for empty string', () => {
    expect(wrapReminder('')).toBeNull();
  });

  test('returns null for whitespace-only input', () => {
    expect(wrapReminder('   \n\t  ')).toBeNull();
  });

  test('wraps simple content in reminder tags', () => {
    const out = wrapReminder('hello world');
    expect(out).toBe('<vinyan-reminder>\nhello world\n</vinyan-reminder>');
  });

  test('trims leading and trailing whitespace before wrapping', () => {
    const out = wrapReminder('  \n  stall detected  \n  ');
    expect(out).toBe('<vinyan-reminder>\nstall detected\n</vinyan-reminder>');
  });

  test('preserves internal newlines and multi-line structure', () => {
    const body = '[BUDGET WARNING] 90%\n[SESSION STATE]\nFiles read: a.ts, b.ts';
    const out = wrapReminder(body);
    expect(out).toContain('<vinyan-reminder>');
    expect(out).toContain('</vinyan-reminder>');
    expect(out).toContain('[BUDGET WARNING] 90%');
    expect(out).toContain('[SESSION STATE]');
    expect(out).toContain('Files read: a.ts, b.ts');
  });

  test('output is idempotent for substring matching', () => {
    // Key contract: tests that check substrings of hint content must still
    // pass after wrapping. This is what keeps existing regression tests green.
    const out = wrapReminder('[STALL WARNING] No progress for 2 turns');
    expect(out).toContain('STALL WARNING');
    expect(out).toContain('2 turns');
  });
});

// ── hasReminderBlock ─────────────────────────────────────────────────

describe('hasReminderBlock', () => {
  test('returns false for null', () => {
    expect(hasReminderBlock(null)).toBe(false);
  });

  test('returns false for undefined', () => {
    expect(hasReminderBlock(undefined)).toBe(false);
  });

  test('returns false for plain text', () => {
    expect(hasReminderBlock('just a regular tool output')).toBe(false);
  });

  test('returns true when wrapped content is present', () => {
    const wrapped = wrapReminder('hello')!;
    expect(hasReminderBlock(wrapped)).toBe(true);
  });

  test('returns true when reminder tag appears mid-string', () => {
    const mixed = 'tool output here\n\n<vinyan-reminder>\nwarning\n</vinyan-reminder>';
    expect(hasReminderBlock(mixed)).toBe(true);
  });
});

// ── REMINDER_PROTOCOL_DESCRIPTION ────────────────────────────────────

describe('REMINDER_PROTOCOL_DESCRIPTION', () => {
  test('mentions the reminder tag format', () => {
    expect(REMINDER_PROTOCOL_DESCRIPTION).toContain('<vinyan-reminder>');
  });

  test('explains the three core properties (authoritative, non-interactive, refreshable)', () => {
    expect(REMINDER_PROTOCOL_DESCRIPTION).toContain('Authoritative');
    expect(REMINDER_PROTOCOL_DESCRIPTION).toContain('Non-interactive');
    expect(REMINDER_PROTOCOL_DESCRIPTION).toContain('Refreshable');
  });

  test('enumerates all common reminder content types', () => {
    const expected = [
      '[SESSION STATE]',
      '[BUDGET WARNING',
      '[TURNS WARNING]',
      '[STALL WARNING]',
      '[FORCED PIVOT]',
      '[GUIDANCE]',
      '[DUPLICATE WARNING]',
    ];
    for (const tag of expected) {
      expect(REMINDER_PROTOCOL_DESCRIPTION).toContain(tag);
    }
  });

  test('tells the LLM not to reply to reminders', () => {
    // The protocol explicitly forbids echoing reminder text back — verify the
    // key phrase is present so the wording is stable.
    expect(REMINDER_PROTOCOL_DESCRIPTION.toLowerCase()).toContain('do not reply');
  });
});
