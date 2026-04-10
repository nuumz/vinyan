/**
 * Tests for tool-failure-classifier — deterministic error triage.
 */
import { describe, expect, test } from 'bun:test';
import { classifyToolFailure } from '../../src/orchestrator/tool-failure-classifier.ts';

describe('classifyToolFailure', () => {
  // ── not_found ──
  test('app not found → not_found, recoverable', () => {
    const result = classifyToolFailure(1, "Unable to find application named 'outlook'\n");
    expect(result.type).toBe('not_found');
    expect(result.recoverable).toBe(true);
    expect(result.retryable).toBe(false);
  });

  test('command not found → not_found, recoverable', () => {
    const result = classifyToolFailure(127, 'sh: google-chrome: command not found\n');
    expect(result.type).toBe('not_found');
    expect(result.recoverable).toBe(true);
  });

  test('no such file → not_found', () => {
    const result = classifyToolFailure(1, 'No such file or directory: /path/to/app');
    expect(result.type).toBe('not_found');
    expect(result.recoverable).toBe(true);
  });

  // ── permission ──
  test('permission denied → permission, recoverable', () => {
    const result = classifyToolFailure(1, 'Permission denied');
    expect(result.type).toBe('permission');
    expect(result.recoverable).toBe(true);
  });

  test('EACCES → permission', () => {
    const result = classifyToolFailure(1, 'Error: EACCES: permission denied');
    expect(result.type).toBe('permission');
  });

  // ── timeout ──
  test('timed out → timeout, retryable but not recoverable', () => {
    const result = classifyToolFailure(1, 'shell_exec timed out after 30s');
    expect(result.type).toBe('timeout');
    expect(result.recoverable).toBe(false);
    expect(result.retryable).toBe(true);
  });

  // ── network ──
  test('connection refused → network, retryable', () => {
    const result = classifyToolFailure(1, 'Error: connect ECONNREFUSED 127.0.0.1:3000');
    expect(result.type).toBe('network');
    expect(result.retryable).toBe(true);
  });

  // ── syntax ──
  test('syntax error → syntax, recoverable', () => {
    const result = classifyToolFailure(1, 'syntax error near unexpected token');
    expect(result.type).toBe('syntax');
    expect(result.recoverable).toBe(true);
  });

  test('invalid option → syntax', () => {
    const result = classifyToolFailure(1, 'invalid option -- z');
    expect(result.type).toBe('syntax');
  });

  // ── resource ──
  test('resource busy → resource, retryable', () => {
    const result = classifyToolFailure(1, 'Error: EBUSY: resource busy');
    expect(result.type).toBe('resource');
    expect(result.retryable).toBe(true);
    expect(result.recoverable).toBe(false);
  });

  // ── unknown ──
  test('unrecognized error → unknown', () => {
    const result = classifyToolFailure(42, 'Something weird happened');
    expect(result.type).toBe('unknown');
    expect(result.recoverable).toBe(false);
    expect(result.retryable).toBe(false);
  });

  test('preserves original error and exit code', () => {
    const result = classifyToolFailure(127, 'command not found');
    expect(result.originalError).toBe('command not found');
    expect(result.exitCode).toBe(127);
  });
});
