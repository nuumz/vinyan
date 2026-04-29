/**
 * Phase-11 SkillUsageTracker + evaluateOverclaim tests.
 *
 * Tracker:
 *   - recordView accumulates per-task viewed-skill sets
 *   - getViewed returns empty set for unknown task
 *   - clearTask removes a task's entry; reset wipes all
 *
 * evaluateOverclaim:
 *   - 0 loaded → not flagged (reason: 'no-skills')
 *   - 1 loaded → not flagged (reason: 'too-few-loaded')
 *   - >=2 loaded, ratio >= threshold → not flagged
 *   - >=2 loaded, ratio < threshold → flagged
 *   - viewed-but-not-in-loaded skill ids do NOT count toward ratio
 */
import { describe, expect, test } from 'bun:test';
import {
  evaluateOverclaim,
  OVERCLAIM_MIN_LOADED_SKILLS,
  OVERCLAIM_RATIO_THRESHOLD,
  SkillUsageTracker,
} from '../../../src/orchestrator/agents/skill-usage-tracker.ts';

describe('SkillUsageTracker', () => {
  test('recordView accumulates skills per task', () => {
    const t = new SkillUsageTracker();
    t.recordView('task-1', 'a');
    t.recordView('task-1', 'b');
    t.recordView('task-1', 'a'); // dedupe
    expect(Array.from(t.getViewed('task-1')).sort()).toEqual(['a', 'b']);
  });

  test('getViewed returns empty set for unknown task', () => {
    const t = new SkillUsageTracker();
    expect(t.getViewed('nope').size).toBe(0);
  });

  test('separate tasks do not share state', () => {
    const t = new SkillUsageTracker();
    t.recordView('task-1', 'a');
    t.recordView('task-2', 'b');
    expect(Array.from(t.getViewed('task-1'))).toEqual(['a']);
    expect(Array.from(t.getViewed('task-2'))).toEqual(['b']);
  });

  test('clearTask removes one task; reset wipes all', () => {
    const t = new SkillUsageTracker();
    t.recordView('task-1', 'a');
    t.recordView('task-2', 'b');
    t.clearTask('task-1');
    expect(t.getViewed('task-1').size).toBe(0);
    expect(t.getViewed('task-2').size).toBe(1);
    t.reset();
    expect(t.getViewed('task-2').size).toBe(0);
  });
});

describe('evaluateOverclaim', () => {
  test('0 loaded → not flagged, reason no-skills', () => {
    const e = evaluateOverclaim([], new Set());
    expect(e.flagged).toBe(false);
    expect(e.reason).toBe('no-skills');
    expect(e.declaredCount).toBe(0);
  });

  test('1 loaded → not flagged, reason too-few-loaded', () => {
    expect(OVERCLAIM_MIN_LOADED_SKILLS).toBeGreaterThan(1);
    const e = evaluateOverclaim(['a'], new Set(['a']));
    expect(e.flagged).toBe(false);
    expect(e.reason).toBe('too-few-loaded');
    expect(e.declaredCount).toBe(1);
  });

  test('>=2 loaded, full coverage → not flagged', () => {
    const e = evaluateOverclaim(['a', 'b', 'c'], new Set(['a', 'b', 'c']));
    expect(e.flagged).toBe(false);
    expect(e.reason).toBe('evaluated');
    expect(e.viewedCount).toBe(3);
    expect(e.viewedRatio).toBe(1);
  });

  test('>=2 loaded, ratio at threshold → not flagged', () => {
    // threshold 0.5 → 1 of 2 viewed is exactly 0.5, NOT below threshold
    const e = evaluateOverclaim(['a', 'b'], new Set(['a']));
    expect(e.viewedRatio).toBe(0.5);
    expect(e.flagged).toBe(OVERCLAIM_RATIO_THRESHOLD > 0.5);
  });

  test('>=2 loaded, ratio below threshold → flagged', () => {
    // 1 of 4 viewed = 0.25 < 0.5
    const e = evaluateOverclaim(['a', 'b', 'c', 'd'], new Set(['a']));
    expect(e.flagged).toBe(true);
    expect(e.declaredCount).toBe(4);
    expect(e.viewedCount).toBe(1);
    expect(e.viewedRatio).toBe(0.25);
  });

  test('zero overlap → flagged when loaded >= 2', () => {
    const e = evaluateOverclaim(['a', 'b', 'c'], new Set(['x', 'y']));
    expect(e.flagged).toBe(true);
    expect(e.viewedCount).toBe(0);
    expect(e.viewedRatio).toBe(0);
  });

  test('viewed skills outside loaded loadout do not inflate viewedCount', () => {
    // Persona loaded {a,b,c,d}; viewed {a, x, y, z}. Only `a` is in the loadout.
    const e = evaluateOverclaim(['a', 'b', 'c', 'd'], new Set(['a', 'x', 'y', 'z']));
    expect(e.viewedCount).toBe(1);
    expect(e.viewedRatio).toBe(0.25);
    expect(e.flagged).toBe(true);
  });
});
