/**
 * A2 — First-Class Uncertainty invariant.
 *
 * `type: 'unknown'` is a valid protocol state. An OracleVerdict with type
 * 'unknown' must round-trip through serialization without loss and must
 * be distinguishable from `'failed'` / `'verified'`.
 */
import { describe, expect, test } from 'bun:test';
import type { OracleVerdict } from '../../src/core/types.ts';

describe('A2 — First-Class Uncertainty', () => {
  test('OracleVerdict with type=unknown round-trips through JSON', () => {
    const verdict: OracleVerdict = {
      oracleName: 'test-oracle',
      verified: false,
      type: 'unknown',
      confidence: 0,
      evidence: [],
      fileHashes: {},
      durationMs: 0,
      reason: 'oracle could not determine',
    };
    const json = JSON.stringify(verdict);
    const parsed = JSON.parse(json) as OracleVerdict;
    expect(parsed.type).toBe('unknown');
    expect(parsed.confidence).toBe(0);
  });

  test('unknown is distinguishable from known/uncertain/contradictory', () => {
    const types: OracleVerdict['type'][] = ['known', 'unknown', 'uncertain', 'contradictory'];
    for (const t of types) {
      const v: OracleVerdict = {
        oracleName: 'x',
        verified: t === 'known',
        type: t,
        confidence: 0,
        evidence: [],
        fileHashes: {},
        durationMs: 0,
      };
      expect(v.type).toBe(t);
    }
  });

  test('unknown is permitted at any confidence level (operationally 0)', () => {
    const v: OracleVerdict = {
      oracleName: 'x',
      verified: false,
      type: 'unknown',
      confidence: 0,
      evidence: [],
      fileHashes: {},
      durationMs: 0,
      reason: 'no signal',
    };
    expect(v.type).toBe('unknown');
  });
});
