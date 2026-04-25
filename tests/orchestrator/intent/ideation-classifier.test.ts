import { describe, expect, test } from 'bun:test';
import { classifyIdeation } from '../../../src/orchestrator/intent/ideation-classifier.ts';

describe('classifyIdeation', () => {
  test('rejects goals shorter than the minimum length', () => {
    const result = classifyIdeation('short');
    expect(result.isIdeation).toBe(false);
    expect(result.matchedRule).toBe('too-short');
  });

  test('matches explicit ideation verbs', () => {
    const result = classifyIdeation('Brainstorm ways to reduce API latency for cold starts');
    expect(result.isIdeation).toBe(true);
    expect(result.matchedRule).toBe('ideation-verb');
  });

  test('matches Thai ideation verbs', () => {
    const result = classifyIdeation('ระดมความคิดเรื่องวิธีลดเวลา API cold start');
    expect(result.isIdeation).toBe(true);
    expect(result.matchedRule).toBe('ideation-verb');
  });

  test('matches question framing', () => {
    const result = classifyIdeation('How should we handle cache invalidation at scale?');
    expect(result.isIdeation).toBe(true);
    expect(result.matchedRule).toBe('question');
  });

  test('matches open-ended design verbs', () => {
    const result = classifyIdeation('Compare approaches for cross-region database replication');
    expect(result.isIdeation).toBe(true);
    expect(result.matchedRule).toBe('open-ended');
  });

  test('anti-trigger: concrete file paths suppress ideation detection', () => {
    const result = classifyIdeation('Design a new service in src/services/payment.ts');
    expect(result.isIdeation).toBe(false);
    expect(result.matchedRule).toBe('anti-path');
  });

  test('anti-trigger: bug-fix verbs suppress ideation detection', () => {
    const result = classifyIdeation('Fix intermittent race condition in worker pool');
    expect(result.isIdeation).toBe(false);
    expect(result.matchedRule).toBe('anti-bugfix');
  });

  test('routine imperative goals do not trigger', () => {
    const result = classifyIdeation('Add a new column user_id to the users table');
    expect(result.isIdeation).toBe(false);
    expect(result.matchedRule).toBe('none');
  });
});
