/**
 * Auth Middleware Tests — I15 enforcement
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createAuthMiddleware, requiresAuth } from '../../src/security/auth.ts';

const TEST_DIR = join(tmpdir(), `vinyan-auth-test-${Date.now()}`);
const TOKEN_PATH = join(TEST_DIR, 'api-token');
const TEST_TOKEN = 'a'.repeat(64);

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
  writeFileSync(TOKEN_PATH, TEST_TOKEN + '\n');
});

afterEach(() => {
  try {
    unlinkSync(TOKEN_PATH);
  } catch {}
});

describe('createAuthMiddleware', () => {
  test('valid token authenticates', () => {
    const auth = createAuthMiddleware(TOKEN_PATH);
    const req = new Request('http://localhost/api/v1/tasks', {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });

    const ctx = auth.authenticate(req);
    expect(ctx.authenticated).toBe(true);
    expect(ctx.source).toBe('bearer');
    expect(ctx.apiKey).toBe(TEST_TOKEN);
  });

  test('invalid token rejects', () => {
    const auth = createAuthMiddleware(TOKEN_PATH);
    const req = new Request('http://localhost/api/v1/tasks', {
      headers: { Authorization: 'Bearer wrong-token' },
    });

    const ctx = auth.authenticate(req);
    expect(ctx.authenticated).toBe(false);
    expect(ctx.source).toBe('anonymous');
  });

  test('missing Authorization header returns anonymous', () => {
    const auth = createAuthMiddleware(TOKEN_PATH);
    const req = new Request('http://localhost/api/v1/tasks');

    const ctx = auth.authenticate(req);
    expect(ctx.authenticated).toBe(false);
    expect(ctx.source).toBe('anonymous');
  });

  test('malformed Authorization header returns anonymous', () => {
    const auth = createAuthMiddleware(TOKEN_PATH);
    const req = new Request('http://localhost/api/v1/tasks', {
      headers: { Authorization: 'Basic abc123' },
    });

    const ctx = auth.authenticate(req);
    expect(ctx.authenticated).toBe(false);
  });

  test('auto-generates token if file does not exist', () => {
    const newTokenPath = join(TEST_DIR, 'new-token');
    const auth = createAuthMiddleware(newTokenPath);

    expect(existsSync(newTokenPath)).toBe(true);
    const token = auth.getToken();
    expect(token.length).toBe(64); // 32 bytes = 64 hex chars

    // Generated token works
    const req = new Request('http://localhost/api/v1/tasks', {
      headers: { Authorization: `Bearer ${token}` },
    });
    const ctx = auth.authenticate(req);
    expect(ctx.authenticated).toBe(true);

    try {
      unlinkSync(newTokenPath);
    } catch {}
  });
});

describe('requiresAuth (I15)', () => {
  test('health endpoint does not require auth', () => {
    expect(requiresAuth('GET', '/api/v1/health')).toBe(false);
  });

  test('metrics endpoint does not require auth', () => {
    expect(requiresAuth('GET', '/api/v1/metrics')).toBe(false);
  });

  test('read-only query endpoints do not require auth', () => {
    expect(requiresAuth('GET', '/api/v1/facts')).toBe(false);
    expect(requiresAuth('GET', '/api/v1/workers')).toBe(false);
    expect(requiresAuth('GET', '/api/v1/rules')).toBe(false);
  });

  test('POST /tasks requires auth (mutation)', () => {
    expect(requiresAuth('POST', '/api/v1/tasks')).toBe(true);
  });

  test('POST /sessions requires auth (mutation)', () => {
    expect(requiresAuth('POST', '/api/v1/sessions')).toBe(true);
  });

  test('DELETE requires auth', () => {
    expect(requiresAuth('DELETE', '/api/v1/tasks/123')).toBe(true);
  });

  test('GET /tasks/:id requires auth (task data)', () => {
    expect(requiresAuth('GET', '/api/v1/tasks/123')).toBe(true);
  });
});
