/**
 * Tests for W3 H3 cron-parser — NL → CRON + `nextFireAt` evaluator.
 *
 * Patterns covered (MVP):
 *   - "every weekday at 9am"
 *   - "every monday at 9:30"
 *   - "daily at 20:00"
 *   - "every hour"
 *   - "every 30 minutes"
 *   - "at 14:00 on weekends"
 *
 * Plus: timezone extraction (`in Asia/Bangkok`), invalid-timezone reject,
 * unsupported-pattern reject, and `nextFireAt` correctness across a
 * TZ boundary.
 */
import { describe, expect, test } from 'bun:test';
import { nextFireAt, parseCron } from '../../../src/gateway/scheduling/cron-parser.ts';

describe('parseCron — supported MVP patterns', () => {
  test('every weekday at 9am → 0 9 * * 1-5', () => {
    const res = parseCron('every weekday at 9am', { defaultTimezone: 'UTC' });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.cron).toBe('0 9 * * 1-5');
      expect(res.timezone).toBe('UTC');
      expect(res.matchedPattern).toBe('weekday');
    }
  });

  test('every monday at 9:30 → 30 9 * * 1', () => {
    const res = parseCron('every monday at 9:30', { defaultTimezone: 'UTC' });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.cron).toBe('30 9 * * 1');
  });

  test('daily at 20:00 → 0 20 * * *', () => {
    const res = parseCron('daily at 20:00', { defaultTimezone: 'UTC' });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.cron).toBe('0 20 * * *');
  });

  test('every hour → 0 * * * *', () => {
    const res = parseCron('every hour', { defaultTimezone: 'UTC' });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.cron).toBe('0 * * * *');
  });

  test('every 30 minutes → */30 * * * *', () => {
    const res = parseCron('every 30 minutes', { defaultTimezone: 'UTC' });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.cron).toBe('*/30 * * * *');
  });

  test('at 14:00 on weekends → 0 14 * * 6,0', () => {
    const res = parseCron('at 14:00 on weekends', { defaultTimezone: 'UTC' });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.cron).toBe('0 14 * * 6,0');
  });
});

describe('parseCron — timezone handling', () => {
  test('trailing `in Asia/Bangkok` overrides default timezone', () => {
    const res = parseCron('daily at 9am in Asia/Bangkok', { defaultTimezone: 'UTC' });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.cron).toBe('0 9 * * *');
      expect(res.timezone).toBe('Asia/Bangkok');
    }
  });

  test('lowercase IANA is normalized', () => {
    const res = parseCron('daily at 9am in asia/bangkok', { defaultTimezone: 'UTC' });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.timezone).toBe('Asia/Bangkok');
  });

  test('invalid IANA → invalid-timezone failure', () => {
    const res = parseCron('daily at 9am in Narnia/Cair_Paravel', { defaultTimezone: 'UTC' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('invalid-timezone');
  });
});

describe('parseCron — failure paths', () => {
  test('unparseable input fails with no-pattern-match', () => {
    const res = parseCron('hello world', { defaultTimezone: 'UTC' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('no-pattern-match');
  });

  test('empty string fails cleanly', () => {
    const res = parseCron('   ', { defaultTimezone: 'UTC' });
    expect(res.ok).toBe(false);
  });

  test('"at teatime" triggers ambiguous-time', () => {
    const res = parseCron('every day at teatime', { defaultTimezone: 'UTC' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('ambiguous-time');
  });
});

describe('nextFireAt', () => {
  test('returns the next minute matching a "daily at 9am" schedule in UTC', () => {
    // from: 2026-01-01T08:00:00Z — next is 09:00Z the same day.
    const from = Date.UTC(2026, 0, 1, 8, 0, 0);
    const expected = Date.UTC(2026, 0, 1, 9, 0, 0);
    expect(nextFireAt('0 9 * * *', 'UTC', from)).toBe(expected);
  });

  test('honours Asia/Bangkok (+07:00) for "daily at 9am"', () => {
    // 2026-01-01T00:00:00Z = 2026-01-01T07:00:00+07:00. Next 9am BKK is
    // 2026-01-01T02:00:00Z (= 09:00+07).
    const from = Date.UTC(2026, 0, 1, 0, 0, 0);
    const expected = Date.UTC(2026, 0, 1, 2, 0, 0);
    expect(nextFireAt('0 9 * * *', 'Asia/Bangkok', from)).toBe(expected);
  });

  test('"every monday at 9:30" skips forward to the correct Monday', () => {
    // 2026-01-05 is a Monday in UTC.
    const friday = Date.UTC(2026, 0, 2, 12, 0, 0); // Fri 2026-01-02 12:00Z
    const expected = Date.UTC(2026, 0, 5, 9, 30, 0);
    expect(nextFireAt('30 9 * * 1', 'UTC', friday)).toBe(expected);
  });

  test('survives a DST spring-forward boundary in America/New_York', () => {
    // 2026-03-08 02:00 → 03:00 local. "daily at 03:00" should still fire
    // once per day; the evaluator must not infinite-loop.
    const from = Date.UTC(2026, 2, 7, 10, 0, 0); // Sat 2026-03-07 10:00Z
    const result = nextFireAt('0 3 * * *', 'America/New_York', from);
    // Any valid future time > `from` proves the evaluator returned cleanly.
    expect(result).toBeGreaterThan(from);
    // Sanity: the returned instant is within the next ~36 hours (one or two
    // fires forward, depending on DST interaction).
    expect(result - from).toBeLessThan(36 * 3600 * 1000);
  });
});
