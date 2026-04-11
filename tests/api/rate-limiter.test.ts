/**
 * Rate Limiter Tests
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import { classifyEndpoint, RateLimiter } from '../../src/api/rate-limiter.ts';

describe('RateLimiter', () => {
  let limiter: RateLimiter;

  beforeEach(() => {
    limiter = new RateLimiter({
      defaultBucketSize: 5,
      defaultRefillRate: 1,
      endpointOverrides: {
        task_submit: { bucketSize: 2, refillRate: 1 },
      },
    });
  });

  test('allows requests within bucket', () => {
    for (let i = 0; i < 5; i++) {
      const result = limiter.check('key1');
      expect(result.allowed).toBe(true);
    }
  });

  test('blocks when bucket exhausted', () => {
    for (let i = 0; i < 5; i++) {
      limiter.check('key1');
    }
    const result = limiter.check('key1');
    expect(result.allowed).toBe(false);
    expect(result.retryAfterSeconds).toBeGreaterThan(0);
  });

  test('uses per-category limits', () => {
    // task_submit has bucketSize=2
    expect(limiter.check('key1', 'task_submit').allowed).toBe(true);
    expect(limiter.check('key1', 'task_submit').allowed).toBe(true);
    expect(limiter.check('key1', 'task_submit').allowed).toBe(false);
  });

  test('separate keys have independent buckets', () => {
    // Exhaust key1
    for (let i = 0; i < 5; i++) limiter.check('key1');
    expect(limiter.check('key1').allowed).toBe(false);

    // key2 still has tokens
    expect(limiter.check('key2').allowed).toBe(true);
  });

  test('reset clears all buckets', () => {
    for (let i = 0; i < 5; i++) limiter.check('key1');
    expect(limiter.check('key1').allowed).toBe(false);

    limiter.reset();
    expect(limiter.check('key1').allowed).toBe(true);
  });
});

describe('classifyEndpoint', () => {
  test('POST /tasks → task_submit', () => {
    expect(classifyEndpoint('POST', '/api/v1/tasks')).toBe('task_submit');
    expect(classifyEndpoint('POST', '/api/v1/tasks/async')).toBe('task_submit');
  });

  test('GET /tasks/:id → task_query', () => {
    expect(classifyEndpoint('GET', '/api/v1/tasks/abc-123')).toBe('task_query');
  });

  test('sessions → session_mgmt', () => {
    expect(classifyEndpoint('POST', '/api/v1/sessions')).toBe('session_mgmt');
    expect(classifyEndpoint('GET', '/api/v1/sessions/abc')).toBe('session_mgmt');
  });

  test('health and metrics are not rate-limited', () => {
    expect(classifyEndpoint('GET', '/api/v1/health')).toBeUndefined();
    expect(classifyEndpoint('GET', '/api/v1/metrics')).toBeUndefined();
  });
});
