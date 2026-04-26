/**
 * Keychain credential loader tests — G2+ A6 credential isolation.
 *
 * These tests verify the populate-from-keychain semantics without depending on
 * an actual keychain on the test runner: behaviour for the env-precedence path
 * and the no-keychain (Windows / unsupported) path is fully testable. Live
 * keychain reads are out of scope for unit tests — they require `security`
 * (macOS) or `secret-tool` (Linux) to be installed and seeded with secrets,
 * which CI containers typically lack.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { detectBackend, populateProviderKeysFromKeychain } from '../../src/security/keychain.ts';

const TEST_KEY = 'VINYAN_TEST_FAKE_API_KEY';

const originalEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  originalEnv[TEST_KEY] = process.env[TEST_KEY];
  delete process.env[TEST_KEY];
});

afterEach(() => {
  if (originalEnv[TEST_KEY] === undefined) delete process.env[TEST_KEY];
  else process.env[TEST_KEY] = originalEnv[TEST_KEY];
});

describe('detectBackend', () => {
  test('returns one of the supported platforms', () => {
    const backend = detectBackend();
    expect(['darwin', 'linux', 'unsupported']).toContain(backend);
  });
});

describe('populateProviderKeysFromKeychain', () => {
  test('skips env vars that are already set (env precedence)', () => {
    process.env[TEST_KEY] = 'sk-already-set';
    const result = populateProviderKeysFromKeychain('vinyan-test-service-does-not-exist', [TEST_KEY]);
    expect(result.populated).toEqual([]);
    expect(result.skipped).toEqual([TEST_KEY]);
    // Pre-existing value must not be overwritten.
    expect(process.env[TEST_KEY]).toBe('sk-already-set');
  });

  test('returns skipped when the keychain has no entry for the service/account pair', () => {
    // Use a service name guaranteed not to exist in any reasonable keychain.
    const result = populateProviderKeysFromKeychain('vinyan-test-service-does-not-exist', [TEST_KEY]);
    expect(result.skipped).toContain(TEST_KEY);
    expect(result.populated).not.toContain(TEST_KEY);
    expect(process.env[TEST_KEY]).toBeUndefined();
  });

  test('reports the detected backend', () => {
    const result = populateProviderKeysFromKeychain('vinyan-test-service-does-not-exist', [TEST_KEY]);
    expect(['darwin', 'linux', 'unsupported']).toContain(result.backend);
  });

  test('idempotent — second call sees env populated by first and skips', () => {
    process.env[TEST_KEY] = 'sk-set-once';
    const first = populateProviderKeysFromKeychain('vinyan-test-service-does-not-exist', [TEST_KEY]);
    const second = populateProviderKeysFromKeychain('vinyan-test-service-does-not-exist', [TEST_KEY]);
    expect(first.skipped).toContain(TEST_KEY);
    expect(second.skipped).toContain(TEST_KEY);
    expect(process.env[TEST_KEY]).toBe('sk-set-once');
  });

  test('default env-key list contains the four supported providers', () => {
    // No assertion on actual loads — just confirm the function accepts the
    // default arg list and returns a structured result.
    const result = populateProviderKeysFromKeychain();
    const total = result.populated.length + result.skipped.length;
    expect(total).toBe(4);
  });
});
