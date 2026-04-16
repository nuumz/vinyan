/**
 * Conflict Resolver — SL Fusion routing level tests (Wave C4).
 * Verifies that L1+ gets SL fusion while L0 skips it.
 */
import { describe, expect, test } from 'bun:test';
import { buildVerdict } from '../../src/core/index.ts';
import type { OracleVerdict } from '../../src/core/types.ts';
import { type ResolverConfig, resolveConflicts } from '../../src/gate/conflict-resolver.ts';

function makeVerdict(overrides: Partial<OracleVerdict> = {}): OracleVerdict {
  return buildVerdict({
    verified: true,
    type: 'known',
    confidence: 0.8,
    evidence: [{ file: 'test.ts', line: 1, snippet: 'ok' }],
    fileHashes: {},
    durationMs: 10,
    ...overrides,
  });
}

const CONFIG: ResolverConfig = {
  oracleTiers: {
    type: 'deterministic',
    lint: 'heuristic',
    ast: 'deterministic',
  },
  informationalOracles: new Set<string>(),
};

function threePassingVerdicts(): Record<string, OracleVerdict> {
  return {
    type: makeVerdict({ verified: true, confidence: 0.9 }),
    lint: makeVerdict({ verified: true, confidence: 0.7 }),
    ast: makeVerdict({ verified: true, confidence: 0.85 }),
  };
}

describe('SL Fusion with routing level (Wave C4)', () => {
  test('routingLevel=1 + 3 verdicts → fusedOpinion is non-null', () => {
    const result = resolveConflicts(threePassingVerdicts(), CONFIG, {}, 1);
    expect(result.fusedOpinion).toBeDefined();
    expect(result.fusedOpinion).not.toBeNull();
    expect(result.fusedOpinion!.belief).toBeGreaterThan(0);
    expect(result.fusedOpinion!.uncertainty).toBeGreaterThanOrEqual(0);
  });

  test('routingLevel=0 + 3 verdicts → fusedOpinion is undefined (L0 skip)', () => {
    const result = resolveConflicts(threePassingVerdicts(), CONFIG, {}, 0);
    expect(result.fusedOpinion).toBeUndefined();
  });

  test('routingLevel=2 → fusedOpinion is non-null (regression check)', () => {
    const result = resolveConflicts(threePassingVerdicts(), CONFIG, {}, 2);
    expect(result.fusedOpinion).toBeDefined();
    expect(result.fusedOpinion).not.toBeNull();
  });

  test('routingLevel=3 → fusedOpinion is non-null', () => {
    const result = resolveConflicts(threePassingVerdicts(), CONFIG, {}, 3);
    expect(result.fusedOpinion).toBeDefined();
  });

  test('routingLevel=undefined (backward compat) → fusedOpinion is non-null', () => {
    const result = resolveConflicts(threePassingVerdicts(), CONFIG, {});
    expect(result.fusedOpinion).toBeDefined();
    expect(result.fusedOpinion).not.toBeNull();
  });

  test('L1 fusion produces belief interval', () => {
    const result = resolveConflicts(threePassingVerdicts(), CONFIG, {}, 1);
    expect(result.beliefInterval).toBeDefined();
    expect(result.beliefInterval!.belief).toBeGreaterThan(0);
    expect(result.beliefInterval!.plausibility).toBeGreaterThanOrEqual(result.beliefInterval!.belief);
  });
});
