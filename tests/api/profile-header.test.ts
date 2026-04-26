/**
 * HTTP API profile intake — W1 PR #1 consumer wiring.
 *
 * Tests the `resolveRequestProfile` helper exported from `src/api/server.ts`.
 * We invoke it directly rather than spinning up the full Bun.serve stack —
 * faster, and it sidesteps the need to wire SessionManager / orchestrator
 * fixtures just to test a header/body parser.
 */

import { describe, expect, test } from 'bun:test';
import { resolveRequestProfile } from '../../src/api/server.ts';

function makeRequest(init: { headers?: Record<string, string> } = {}): Request {
  return new Request('http://localhost/api/v1/tasks', {
    method: 'POST',
    headers: init.headers,
  });
}

describe('resolveRequestProfile', () => {
  test('defaults to "default" when header + body + fallback all absent', () => {
    const req = makeRequest();
    const result = resolveRequestProfile(req, {});
    expect(result).toEqual({ profile: 'default' });
  });

  test('uses server-level fallback when header + body both absent', () => {
    const req = makeRequest();
    const result = resolveRequestProfile(req, {}, 'server-default');
    expect(result).toEqual({ profile: 'server-default' });
  });

  test('accepts valid X-Vinyan-Profile header', () => {
    const req = makeRequest({ headers: { 'X-Vinyan-Profile': 'work' } });
    const result = resolveRequestProfile(req, {});
    expect(result).toEqual({ profile: 'work' });
  });

  test('header is case-insensitive (fetch Headers normalize)', () => {
    const req = makeRequest({ headers: { 'x-vinyan-profile': 'work' } });
    const result = resolveRequestProfile(req, {});
    expect(result).toEqual({ profile: 'work' });
  });

  test('body.profile wins over header when both are present', () => {
    const req = makeRequest({ headers: { 'X-Vinyan-Profile': 'header-profile' } });
    const result = resolveRequestProfile(req, { profile: 'body-profile' });
    expect(result).toEqual({ profile: 'body-profile' });
  });

  test('invalid header → 400-appropriate error', () => {
    const req = makeRequest({ headers: { 'X-Vinyan-Profile': 'WORK' } });
    const result = resolveRequestProfile(req, {});
    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error).toMatch(/Invalid profile name/);
    }
  });

  test('invalid header with path traversal rejected', () => {
    const req = makeRequest({ headers: { 'X-Vinyan-Profile': '../etc' } });
    const result = resolveRequestProfile(req, {});
    expect('error' in result).toBe(true);
  });

  test('invalid body.profile → error (even if header is valid)', () => {
    const req = makeRequest({ headers: { 'X-Vinyan-Profile': 'work' } });
    const result = resolveRequestProfile(req, { profile: 'WORK' });
    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error).toMatch(/Invalid profile name in body/);
    }
  });

  test('body.profile non-string rejected', () => {
    const req = makeRequest();
    const result = resolveRequestProfile(req, { profile: 123 as unknown as string });
    expect('error' in result).toBe(true);
  });

  test('empty header falls through to body / default', () => {
    const req = makeRequest({ headers: { 'X-Vinyan-Profile': '' } });
    const result = resolveRequestProfile(req, {}, 'fallback');
    // Empty string isn't a valid profile — but it's also not "present";
    // fall back to the server default.
    expect(result).toEqual({ profile: 'fallback' });
  });

  test("accepts literal 'default' in header", () => {
    const req = makeRequest({ headers: { 'X-Vinyan-Profile': 'default' } });
    const result = resolveRequestProfile(req, {});
    expect(result).toEqual({ profile: 'default' });
  });

  test("accepts literal 'default' in body", () => {
    const req = makeRequest();
    const result = resolveRequestProfile(req, { profile: 'default' });
    expect(result).toEqual({ profile: 'default' });
  });
});
