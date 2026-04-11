/**
 * Conflict Resolver tests — verifies the 5-step deterministic contradiction
 * resolution algorithm (concept §3.2, A5 Tiered Trust).
 */
import { describe, expect, test } from 'bun:test';
import { buildVerdict } from '../../src/core/index.ts';
import type { OracleVerdict } from '../../src/core/types.ts';
import { type ResolverConfig, resolveConflicts } from '../../src/gate/conflict-resolver.ts';

// ── Helpers ─────────────────────────────────────────────────────

function makeVerdict(overrides: Partial<OracleVerdict> = {}): OracleVerdict {
  return buildVerdict({
    verified: true,
    type: 'known',
    confidence: 1.0,
    evidence: [],
    fileHashes: {},
    durationMs: 10,
    ...overrides,
  });
}

const DEFAULT_CONFIG: ResolverConfig = {
  oracleTiers: {
    ast: 'deterministic',
    type: 'deterministic',
    dep: 'heuristic',
    test: 'deterministic',
    lint: 'deterministic',
  },
  informationalOracles: new Set(['dep']),
};

// ── No conflict cases ───────────────────────────────────────────

describe('resolveConflicts — no conflict', () => {
  test('all oracles pass → allow', () => {
    const result = resolveConflicts(
      {
        ast: makeVerdict({ verified: true }),
        type: makeVerdict({ verified: true }),
      },
      DEFAULT_CONFIG,
    );
    expect(result.decision).toBe('allow');
    expect(result.reasons).toHaveLength(0);
    expect(result.resolutions).toHaveLength(0);
  });

  test('all oracles fail → block with all reasons', () => {
    const result = resolveConflicts(
      {
        ast: makeVerdict({ verified: false, reason: 'symbol not found' }),
        type: makeVerdict({ verified: false, reason: 'type error' }),
      },
      DEFAULT_CONFIG,
    );
    expect(result.decision).toBe('block');
    expect(result.reasons).toHaveLength(2);
    expect(result.reasons[0]).toContain('ast');
    expect(result.reasons[1]).toContain('type');
  });

  test('no oracle results → allow', () => {
    const result = resolveConflicts({}, DEFAULT_CONFIG);
    expect(result.decision).toBe('allow');
  });

  test('only informational oracle fails → allow', () => {
    const result = resolveConflicts(
      {
        dep: makeVerdict({ verified: false, reason: 'high blast radius' }),
      },
      DEFAULT_CONFIG,
    );
    expect(result.decision).toBe('allow');
    expect(result.reasons).toHaveLength(0);
  });
});

// ── Step 1: Domain separation ───────────────────────────────────

describe('resolveConflicts — Step 1: domain separation', () => {
  test('cross-domain conflict: structural pass + quality fail → both valid → block', () => {
    const result = resolveConflicts(
      {
        type: makeVerdict({ verified: true }),
        lint: makeVerdict({ verified: false, reason: 'lint error' }),
      },
      DEFAULT_CONFIG,
    );
    // lint (quality) failure stands because it's a different domain than type (structural)
    expect(result.decision).toBe('block');
    expect(result.reasons).toContain('Oracle "lint" rejected: lint error');
    expect(result.resolutions).toHaveLength(1);
    expect(result.resolutions[0]!.resolvedAtStep).toBe(1);
    expect(result.resolutions[0]!.winner).toBe('lint'); // cross-domain: fail stands
  });

  test('cross-domain conflict: functional fail + structural pass → both valid → block', () => {
    const result = resolveConflicts(
      {
        ast: makeVerdict({ verified: true }),
        test: makeVerdict({ verified: false, reason: 'test failed' }),
      },
      DEFAULT_CONFIG,
    );
    expect(result.decision).toBe('block');
    expect(result.resolutions[0]!.resolvedAtStep).toBe(1);
  });
});

// ── Phase 4.8: K-based SL resolution ───────────────────────────
//
// With scalar fallback (u=0, dogmatic opinions), opposing verdicts at confidence=1.0
// produce K = b1*d2 + d1*b2 = 1*1 + 0*0 = 1.0 → always escalate to Step 5.
// This is epistemically correct — tier alone cannot resolve genuine oracle disagreement.
// Resolution only succeeds at Step 2 when K ≤ 0.5 (uncertain/native opinions).

describe('resolveConflicts — Phase 4.8: SL-based resolution', () => {
  test('dogmatic opposing opinions (u=0, confidence=1.0) → K=1.0 → Step 5 regardless of tier', () => {
    const config: ResolverConfig = {
      oracleTiers: { ast: 'deterministic', type: 'heuristic' },
      informationalOracles: new Set(),
    };
    const result = resolveConflicts(
      {
        ast: makeVerdict({ verified: true }),
        type: makeVerdict({ verified: false, reason: 'heuristic type issue' }),
      },
      config,
    );
    // K=1.0 → contradictory, conservative block
    expect(result.decision).toBe('block');
    expect(result.hasContradiction).toBe(true);
    expect(result.resolutions[0]!.resolvedAtStep).toBe(5);
    expect(result.resolutions[0]!.conflictK).toBeCloseTo(1.0, 5);
  });

  test('uncertain native opinions with K ≤ 0.5 → fuse at Step 2, pass wins → allow', () => {
    // passOpinion: {b:0.6, d:0.2, u:0.2, a:0.5}
    // failOpinion: {b:0.2, d:0.5, u:0.3, a:0.5}
    // K = 0.6*0.5 + 0.2*0.2 = 0.34 ≤ 0.5 → fuse
    // projectedProbability(fused) ≈ 0.57 ≥ 0.5 → pass wins
    const config: ResolverConfig = {
      oracleTiers: { ast: 'deterministic', type: 'deterministic' },
      informationalOracles: new Set(),
    };
    const result = resolveConflicts(
      {
        ast: makeVerdict({ verified: true, opinion: { belief: 0.6, disbelief: 0.2, uncertainty: 0.2, baseRate: 0.5 } }),
        type: makeVerdict({ verified: false, reason: 'uncertain rejection', opinion: { belief: 0.2, disbelief: 0.5, uncertainty: 0.3, baseRate: 0.5 } }),
      },
      config,
    );
    expect(result.decision).toBe('allow');
    expect(result.resolutions[0]!.resolvedAtStep).toBe(2);
    expect(result.resolutions[0]!.winner).toBe('ast');
    expect(result.resolutions[0]!.conflictK).toBeCloseTo(0.34, 2);
    expect(result.resolutions[0]!.fusedProbability).toBeGreaterThan(0.5);
  });

  test('uncertain native opinions with K ≤ 0.5 → fuse at Step 2, fail wins → block', () => {
    // passOpinion: {b:0.3, d:0.2, u:0.5, a:0.5} (uncertain pass)
    // failOpinion: {b:0.2, d:0.6, u:0.2, a:0.5} (more certain fail)
    // K = 0.3*0.6 + 0.2*0.2 = 0.22 ≤ 0.5 → fuse
    // projectedProbability(fused) ≈ 0.35 < 0.5 → fail wins
    const config: ResolverConfig = {
      oracleTiers: { ast: 'deterministic', type: 'deterministic' },
      informationalOracles: new Set(),
    };
    const result = resolveConflicts(
      {
        ast: makeVerdict({ verified: true, opinion: { belief: 0.3, disbelief: 0.2, uncertainty: 0.5, baseRate: 0.5 } }),
        type: makeVerdict({ verified: false, reason: 'weighted rejection', opinion: { belief: 0.2, disbelief: 0.6, uncertainty: 0.2, baseRate: 0.5 } }),
      },
      config,
    );
    expect(result.decision).toBe('block');
    expect(result.resolutions[0]!.resolvedAtStep).toBe(2);
    expect(result.resolutions[0]!.winner).toBe('type');
    expect(result.resolutions[0]!.conflictK).toBeCloseTo(0.22, 2);
    expect(result.resolutions[0]!.fusedProbability).toBeLessThan(0.5);
  });

  test('conflictK and fusedProbability are populated on Step 2 resolution', () => {
    const result = resolveConflicts(
      {
        ast: makeVerdict({ verified: true, opinion: { belief: 0.6, disbelief: 0.2, uncertainty: 0.2, baseRate: 0.5 } }),
        type: makeVerdict({ verified: false, reason: 'rejection', opinion: { belief: 0.2, disbelief: 0.5, uncertainty: 0.3, baseRate: 0.5 } }),
      },
      { oracleTiers: { ast: 'deterministic', type: 'deterministic' }, informationalOracles: new Set() },
    );
    const res = result.resolutions[0]!;
    expect(res.conflictK).toBeDefined();
    expect(res.conflictK).toBeGreaterThan(0);
    expect(res.conflictK).toBeLessThan(0.5);
    expect(res.fusedProbability).toBeDefined();
    expect(res.fusedProbability).toBeGreaterThanOrEqual(0);
    expect(res.fusedProbability).toBeLessThanOrEqual(1);
  });

  test('conflictK is populated on Step 5 (contradictory) resolution', () => {
    const result = resolveConflicts(
      {
        ast: makeVerdict({ verified: true }),
        type: makeVerdict({ verified: false, reason: 'rejection' }),
      },
      { oracleTiers: { ast: 'deterministic', type: 'deterministic' }, informationalOracles: new Set() },
    );
    const res = result.resolutions[0]!;
    expect(res.resolvedAtStep).toBe(5);
    expect(res.conflictK).toBeDefined();
    expect(res.conflictK).toBeGreaterThan(0.5);
    expect(res.fusedProbability).toBeUndefined(); // not populated when K > 0.5
  });
});

// ── Step 5: Escalation ──────────────────────────────────────────

describe('resolveConflicts — Step 5: escalation', () => {
  test('K > 0.5 (dogmatic opposing) → contradictory escalation → block', () => {
    const result = resolveConflicts(
      {
        ast: makeVerdict({ verified: true, evidence: [] }),
        type: makeVerdict({ verified: false, reason: 'rejection', evidence: [] }),
      },
      {
        oracleTiers: { ast: 'deterministic', type: 'deterministic' },
        informationalOracles: new Set(),
      },
    );
    expect(result.decision).toBe('block');
    expect(result.hasContradiction).toBe(true);
    expect(result.resolutions[0]!.resolvedAtStep).toBe(5);
    expect(result.reasons).toContain('Unresolved oracle contradiction — escalated to contradictory state');
  });
});

// ── Multi-oracle conflicts ──────────────────────────────────────

describe('resolveConflicts — multi-oracle', () => {
  test('2 pass + 1 fail (same domain, lower tier) → allow', () => {
    const result = resolveConflicts(
      {
        ast: makeVerdict({ verified: true }),
        type: makeVerdict({ verified: true }),
        lint: makeVerdict({ verified: false, reason: 'lint issue' }),
      },
      {
        oracleTiers: { ast: 'deterministic', type: 'deterministic', lint: 'deterministic' },
        informationalOracles: new Set(),
      },
    );
    // lint is quality domain, ast/type are structural → step 1: cross-domain, lint stands
    expect(result.decision).toBe('block');
  });

  test('structural pass + structural fail (dogmatic scalar) → K=1.0 → Step 5 → block', () => {
    // Phase 4.8: tier distinction no longer resolves dogmatic opposing opinions.
    // Both get K=1.0 → Step 5, regardless of deterministic vs heuristic tier.
    const result = resolveConflicts(
      {
        ast: makeVerdict({ verified: true }),
        type: makeVerdict({ verified: false, reason: 'heuristic type check' }),
      },
      {
        oracleTiers: { ast: 'deterministic', type: 'heuristic' },
        informationalOracles: new Set(),
      },
    );
    expect(result.decision).toBe('block');
    expect(result.hasContradiction).toBe(true);
    expect(result.resolutions[0]!.resolvedAtStep).toBe(5);
  });

  test('multiple conflicts: cross-domain stands (Step 1), same-domain dogmatic → Step 5', () => {
    const result = resolveConflicts(
      {
        ast: makeVerdict({ verified: true }),
        type: makeVerdict({ verified: false, reason: 'type error' }),
        lint: makeVerdict({ verified: false, reason: 'lint error' }),
      },
      {
        oracleTiers: { ast: 'deterministic', type: 'heuristic', lint: 'deterministic' },
        informationalOracles: new Set(),
      },
    );
    // ast vs type: same domain (structural), K=1.0 → Step 5, type not overridden
    // ast vs lint: cross-domain (structural vs quality) → Step 1, lint stands
    expect(result.resolutions).toHaveLength(2);
    // Both type and lint are unresolved → both contribute block reasons
    expect(result.decision).toBe('block');
    expect(result.reasons.some((r) => r.includes('lint'))).toBe(true);
    expect(result.reasons.some((r) => r.includes('type'))).toBe(true);
    expect(result.hasContradiction).toBe(true);
  });
});
