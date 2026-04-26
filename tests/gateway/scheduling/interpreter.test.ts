/**
 * Tests for `interpretSchedule` — NL → ScheduledHypothesisTuple draft with
 * goal-alignment oracle arbitration.
 */
import { describe, expect, test } from 'bun:test';
import { deriveGoal, type InterpreterDeps, interpretSchedule } from '../../../src/gateway/scheduling/interpreter.ts';
import type { ScheduleOrigin } from '../../../src/gateway/scheduling/types.ts';

const ORIGIN: ScheduleOrigin = { platform: 'slack', chatId: 'C123' };

function mkDeps(
  oracle: InterpreterDeps['goalAlignmentOracle'] = async () => ({ confidence: 0.9, aligned: true }),
): InterpreterDeps {
  return {
    goalAlignmentOracle: oracle,
    defaultTimezone: 'UTC',
    clock: () => Date.UTC(2026, 0, 1, 0, 0, 0),
  };
}

describe('interpretSchedule — happy paths', () => {
  test('produces a tuple with cron + timezone + goal', async () => {
    const res = await interpretSchedule(
      'every weekday at 9am summarize backlog and post to Slack',
      ORIGIN,
      'default',
      mkDeps(),
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.tuple.cron).toBe('0 9 * * 1-5');
      expect(res.tuple.timezone).toBe('UTC');
      expect(res.tuple.goal).toContain('summarize backlog');
      expect(res.tuple.profile).toBe('default');
      expect(res.tuple.origin).toEqual(ORIGIN);
      expect(res.tuple.confidenceAtCreation).toBeCloseTo(0.9, 5);
      expect(res.tuple.nlOriginal).toBe('every weekday at 9am summarize backlog and post to Slack');
      expect(res.tuple.constraints).toEqual({});
      expect(res.tuple.createdByHermesUserId).toBeNull();
    }
  });

  test('extracts timezone from trailing `in Asia/Bangkok`', async () => {
    const res = await interpretSchedule(
      'every monday at 9:30 write weekly digest for the team in Asia/Bangkok',
      ORIGIN,
      'default',
      mkDeps(),
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.tuple.timezone).toBe('Asia/Bangkok');
      expect(res.tuple.cron).toBe('30 9 * * 1');
      expect(res.tuple.goal).toContain('write weekly digest');
    }
  });

  test('accepts oracle confidence at the floor (0.5)', async () => {
    const res = await interpretSchedule(
      'every hour check inbox for urgent emails',
      ORIGIN,
      'default',
      mkDeps(async () => ({ confidence: 0.5, aligned: true })),
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.tuple.confidenceAtCreation).toBe(0.5);
  });
});

describe('interpretSchedule — failures', () => {
  test('cron-parse-failed when time phrase is missing', async () => {
    const res = await interpretSchedule('please help me manage backlog', ORIGIN, 'default', mkDeps());
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('cron-parse-failed');
  });

  test('goal-alignment-failed when oracle disagrees', async () => {
    const res = await interpretSchedule(
      'every weekday at 9am post daily update to Slack',
      ORIGIN,
      'default',
      mkDeps(async () => ({ confidence: 0.2, aligned: false })),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('goal-alignment-failed');
  });

  test('too-ambiguous when the non-time remainder is too short', async () => {
    // Everything except the schedule clause will be stripped away.
    const res = await interpretSchedule('every weekday at 9am go', ORIGIN, 'default', mkDeps());
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('too-ambiguous');
  });

  test('too-ambiguous on empty input', async () => {
    const res = await interpretSchedule('   ', ORIGIN, 'default', mkDeps());
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('too-ambiguous');
  });
});

describe('deriveGoal', () => {
  test('strips leading schedule clause and trailing timezone', () => {
    expect(deriveGoal('every weekday at 9am summarize backlog in UTC')).toBe('summarize backlog');
  });

  test('strips `at HH:MM` when embedded in the middle', () => {
    expect(deriveGoal('daily at 20:00 send activity report')).toBe('send activity report');
  });

  test('returns empty string when input is pure schedule', () => {
    expect(deriveGoal('every weekday at 9am').length).toBe(0);
  });
});
