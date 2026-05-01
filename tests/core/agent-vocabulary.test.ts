/**
 * Branded ID helpers for agent-vocabulary.
 *
 * Covers `asPersonaId` (throws), `tryAsPersonaId` (non-throwing
 * boundary helper used by trace-store deserialization), and the shape
 * predicates.
 */
import { describe, expect, test } from 'bun:test';
import {
  asPersonaId,
  isPersonaIdShape,
  isWorkerIdShape,
  type PersonaId,
  tryAsPersonaId,
} from '../../src/core/agent-vocabulary.ts';

const pid = (s: string): PersonaId => s as PersonaId;

describe('asPersonaId', () => {
  test('returns the branded value for a valid slug', () => {
    expect(asPersonaId('developer')).toBe(pid('developer'));
    expect(asPersonaId('ts-coder')).toBe(pid('ts-coder'));
    expect(asPersonaId('a')).toBe(pid('a'));
  });

  test('throws on uppercase, leading digit, special chars, or oversize', () => {
    expect(() => asPersonaId('Developer')).toThrow();
    expect(() => asPersonaId('1coder')).toThrow();
    expect(() => asPersonaId('coder_x')).toThrow();
    expect(() => asPersonaId('coder.dot')).toThrow();
    expect(() => asPersonaId('')).toThrow();
    expect(() => asPersonaId('a'.repeat(65))).toThrow();
  });
});

describe('tryAsPersonaId', () => {
  test('returns the branded value for a valid slug', () => {
    expect(tryAsPersonaId('developer')).toBe(pid('developer'));
    expect(tryAsPersonaId('ts-coder')).toBe(pid('ts-coder'));
  });

  test('returns undefined for nullish input', () => {
    expect(tryAsPersonaId(undefined)).toBeUndefined();
    expect(tryAsPersonaId(null)).toBeUndefined();
  });

  test('returns undefined for shape-invalid input (does NOT fall back to bare string)', () => {
    expect(tryAsPersonaId('INVALID UPPER')).toBeUndefined();
    expect(tryAsPersonaId('1coder')).toBeUndefined();
    expect(tryAsPersonaId('coder_x')).toBeUndefined();
    expect(tryAsPersonaId('')).toBeUndefined();
  });

  test('does not throw on any input (boundary safe)', () => {
    // Not strictly a behaviour assertion but the contract is
    // "non-throwing" — verify we can fuzz it without try/catch.
    for (const v of ['ok', 'OK', '', 'a-b', '!!!', '  spaces  ', null, undefined]) {
      tryAsPersonaId(v as string | null | undefined);
    }
  });
});

describe('shape predicates', () => {
  test('isPersonaIdShape: true for slugs, false for everything else', () => {
    expect(isPersonaIdShape('developer')).toBe(true);
    expect(isPersonaIdShape('ts-coder')).toBe(true);
    expect(isPersonaIdShape('Developer')).toBe(false);
    expect(isPersonaIdShape('1coder')).toBe(false);
    expect(isPersonaIdShape('')).toBe(false);
  });

  test('isWorkerIdShape: looser than PersonaId (allows _, :, .)', () => {
    expect(isWorkerIdShape('worker-1')).toBe(true);
    expect(isWorkerIdShape('worker_1')).toBe(true);
    expect(isWorkerIdShape('worker:1')).toBe(true);
    expect(isWorkerIdShape('worker.v2')).toBe(true);
    expect(isWorkerIdShape('Worker')).toBe(false);
  });
});
