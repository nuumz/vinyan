/**
 * Tests for K1.4 ECP verdict validation middleware.
 */
import { describe, expect, test } from 'bun:test';
import { normalizeECPMessage, validateECPVerdict } from '../../src/a2a/ecp-validation.ts';

describe('validateECPVerdict', () => {
  test('valid message passes', () => {
    const result = validateECPVerdict({
      ecp_version: '1.0',
      confidence: 0.85,
    });
    expect(result.valid).toBe(true);
    expect(result.data?.ecp_version).toBe('1.0');
    expect(result.data?.confidence).toBe(0.85);
  });

  test('valid message with optional fields', () => {
    const result = validateECPVerdict({
      ecp_version: '2.0-draft',
      confidence: 0.9,
      evidence_chain: ['hash1', 'hash2'],
      falsifiable_by: ['test:unit'],
    });
    expect(result.valid).toBe(true);
    expect(result.data?.evidence_chain).toEqual(['hash1', 'hash2']);
  });

  test('missing ecp_version → invalid', () => {
    const result = validateECPVerdict({ confidence: 0.5 });
    expect(result.valid).toBe(false);
    expect(result.error).toBeDefined();
  });

  test('invalid confidence (> 1) → invalid', () => {
    const result = validateECPVerdict({
      ecp_version: '1.0',
      confidence: 1.5,
    });
    expect(result.valid).toBe(false);
  });

  test('unknown ecp_version → invalid', () => {
    const result = validateECPVerdict({
      ecp_version: '3.0',
      confidence: 0.5,
    });
    expect(result.valid).toBe(false);
  });
});

describe('normalizeECPMessage', () => {
  test('missing ecp_version → defaults to 1.0', () => {
    const result = normalizeECPMessage({ confidence: 0.7 });
    expect(result.ecp_version).toBe('1.0');
    expect(result.confidence).toBe(0.7);
  });

  test('missing confidence → defaults to 0.0', () => {
    const result = normalizeECPMessage({ ecp_version: '2.0-draft' });
    expect(result.confidence).toBe(0.0);
    expect(result.ecp_version).toBe('2.0-draft');
  });

  test('both present → preserved', () => {
    const result = normalizeECPMessage({ ecp_version: '1.0', confidence: 0.9 });
    expect(result.ecp_version).toBe('1.0');
    expect(result.confidence).toBe(0.9);
  });

  test('extra fields preserved', () => {
    const result = normalizeECPMessage({ verified: true, type: 'pass' });
    expect(result.verified).toBe(true);
    expect(result.type).toBe('pass');
    expect(result.ecp_version).toBe('1.0');
  });

  test('llm-self-report confidence clamped to 0.5 (A5)', () => {
    const result = normalizeECPMessage({
      ecp_version: '1.0',
      confidence: 0.95,
      confidence_source: 'llm-self-report',
    });
    expect(result.confidence).toBe(0.5);
    expect(result.confidence_source).toBe('llm-self-report');
  });

  test('non-llm confidence_source not clamped', () => {
    const result = normalizeECPMessage({
      ecp_version: '1.0',
      confidence: 0.95,
      confidence_source: 'deterministic',
    });
    expect(result.confidence).toBe(0.95);
  });

  test('llm-self-report confidence below cap preserved', () => {
    const result = normalizeECPMessage({
      ecp_version: '1.0',
      confidence: 0.3,
      confidence_source: 'llm-self-report',
    });
    expect(result.confidence).toBe(0.3);
  });
});
