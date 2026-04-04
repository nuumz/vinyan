/**
 * Tests for @vinyan/oracle-sdk TypeScript package.
 *
 * Covers: buildVerdict, HypothesisTupleSchema, OracleVerdictSchema, testOracle.
 */

import { describe, expect, it } from 'bun:test';
import {
  HypothesisTupleSchema,
  OracleVerdictSchema,
  EvidenceSchema,
  QualityScoreSchema,
  buildVerdict,
  testOracle,
  type OracleTestFixture,
} from '../../packages/oracle-sdk-ts/src/index.ts';

// ── HypothesisTupleSchema ─────────────────────────────────────────────

describe('HypothesisTupleSchema', () => {
  it('validates a minimal hypothesis', () => {
    const result = HypothesisTupleSchema.safeParse({
      target: 'src/main.ts',
      pattern: 'type-check',
      workspace: '/project',
    });
    expect(result.success).toBe(true);
    expect(result.data!.context).toBeUndefined();
  });

  it('validates with context', () => {
    const result = HypothesisTupleSchema.safeParse({
      target: 'src/main.ts',
      pattern: 'symbol-exists',
      context: { symbol: 'MyClass', kind: 'class' },
      workspace: '/project',
    });
    expect(result.success).toBe(true);
    expect(result.data!.context!.symbol).toBe('MyClass');
  });

  it('rejects missing target', () => {
    const result = HypothesisTupleSchema.safeParse({
      pattern: 'type-check',
      workspace: '/project',
    });
    expect(result.success).toBe(false);
  });

  it('rejects missing workspace', () => {
    const result = HypothesisTupleSchema.safeParse({
      target: 'f.ts',
      pattern: 'type-check',
    });
    expect(result.success).toBe(false);
  });

  it('rejects missing pattern', () => {
    const result = HypothesisTupleSchema.safeParse({
      target: 'f.ts',
      workspace: '/w',
    });
    expect(result.success).toBe(false);
  });

  it('accepts extra context fields', () => {
    const result = HypothesisTupleSchema.safeParse({
      target: 'f.ts',
      pattern: 'p',
      workspace: '/w',
      context: { nested: { deep: true }, count: 42 },
    });
    expect(result.success).toBe(true);
  });
});

// ── EvidenceSchema ────────────────────────────────────────────────────

describe('EvidenceSchema', () => {
  it('validates basic evidence', () => {
    const result = EvidenceSchema.safeParse({
      file: 'src/main.ts',
      line: 10,
      snippet: 'function foo()',
    });
    expect(result.success).toBe(true);
    expect(result.data!.contentHash).toBeUndefined();
  });

  it('validates with contentHash', () => {
    const result = EvidenceSchema.safeParse({
      file: 'f.ts',
      line: 1,
      snippet: 'x',
      contentHash: 'abc123',
    });
    expect(result.success).toBe(true);
    expect(result.data!.contentHash).toBe('abc123');
  });

  it('rejects missing file', () => {
    const result = EvidenceSchema.safeParse({ line: 1, snippet: 'x' });
    expect(result.success).toBe(false);
  });
});

// ── OracleVerdictSchema ───────────────────────────────────────────────

describe('OracleVerdictSchema', () => {
  const validVerdict = {
    verified: true,
    type: 'known' as const,
    confidence: 1.0,
    evidence: [{ file: 'f.ts', line: 1, snippet: 'ok' }],
    fileHashes: { 'f.ts': 'a'.repeat(64) },
    durationMs: 42,
  };

  it('validates a minimal verdict', () => {
    const result = OracleVerdictSchema.safeParse({
      verified: true,
      evidence: [{ file: 'f.ts', line: 1, snippet: 'ok' }],
      fileHashes: { 'f.ts': 'abc' },
      durationMs: 100,
    });
    expect(result.success).toBe(true);
    // Check defaults
    expect(result.data!.type).toBe('known');
    expect(result.data!.confidence).toBe(0.5);
  });

  it('validates all epistemic types', () => {
    const types = ['known', 'unknown', 'uncertain', 'contradictory'] as const;
    for (const type of types) {
      const result = OracleVerdictSchema.safeParse({ ...validVerdict, type });
      expect(result.success).toBe(true);
      expect(result.data!.type).toBe(type);
    }
  });

  it('rejects invalid epistemic type', () => {
    const result = OracleVerdictSchema.safeParse({
      ...validVerdict,
      type: 'maybe',
    });
    expect(result.success).toBe(false);
  });

  it('rejects confidence > 1.0', () => {
    const result = OracleVerdictSchema.safeParse({
      ...validVerdict,
      confidence: 1.5,
    });
    expect(result.success).toBe(false);
  });

  it('rejects confidence < 0', () => {
    const result = OracleVerdictSchema.safeParse({
      ...validVerdict,
      confidence: -0.1,
    });
    expect(result.success).toBe(false);
  });

  it('accepts confidence at boundaries', () => {
    for (const c of [0, 0.5, 1.0]) {
      const result = OracleVerdictSchema.safeParse({ ...validVerdict, confidence: c });
      expect(result.success).toBe(true);
    }
  });

  it('validates full verdict with all optional fields', () => {
    const result = OracleVerdictSchema.safeParse({
      ...validVerdict,
      type: 'uncertain',
      confidence: 0.7,
      falsifiableBy: ['file:f.ts:content-change'],
      reason: 'type mismatch at line 10',
      errorCode: 'TYPE_MISMATCH',
      oracleName: 'type-oracle',
      qualityScore: {
        architecturalCompliance: 0.9,
        efficiency: 0.8,
        composite: 0.85,
      },
      deliberationRequest: {
        reason: 'need deeper analysis',
        suggestedBudget: 5000,
      },
      temporalContext: {
        validFrom: 1000,
        validUntil: 60000,
        decayModel: 'linear',
      },
    });
    expect(result.success).toBe(true);
    expect(result.data!.errorCode).toBe('TYPE_MISMATCH');
    expect(result.data!.qualityScore!.composite).toBe(0.85);
    expect(result.data!.temporalContext!.decayModel).toBe('linear');
  });

  it('rejects invalid errorCode', () => {
    const result = OracleVerdictSchema.safeParse({
      ...validVerdict,
      errorCode: 'NOT_A_REAL_CODE',
    });
    expect(result.success).toBe(false);
  });

  it('rejects missing evidence array', () => {
    const result = OracleVerdictSchema.safeParse({
      verified: true,
      fileHashes: {},
      durationMs: 10,
    });
    expect(result.success).toBe(false);
  });

  it('rejects missing durationMs', () => {
    const result = OracleVerdictSchema.safeParse({
      verified: true,
      evidence: [],
      fileHashes: {},
    });
    expect(result.success).toBe(false);
  });
});

// ── buildVerdict ──────────────────────────────────────────────────────

describe('buildVerdict', () => {
  it('returns the same object (passthrough)', () => {
    const input = {
      verified: true,
      type: 'known' as const,
      confidence: 1.0,
      evidence: [],
      fileHashes: {},
      durationMs: 50,
    };
    const result = buildVerdict(input);
    expect(result.verified).toBe(true);
    expect(result.type).toBe('known');
    expect(result.confidence).toBe(1.0);
    expect(result.durationMs).toBe(50);
  });

  it('builds unknown type verdict', () => {
    const verdict = buildVerdict({
      verified: false,
      type: 'unknown',
      confidence: 0,
      evidence: [],
      fileHashes: {},
      durationMs: 10,
      reason: 'oracle cannot determine',
    });
    expect(verdict.type).toBe('unknown');
    expect(verdict.confidence).toBe(0);
    expect(verdict.reason).toBe('oracle cannot determine');
  });

  it('builds contradictory verdict', () => {
    const verdict = buildVerdict({
      verified: false,
      type: 'contradictory',
      confidence: 0.3,
      evidence: [
        { file: 'a.ts', line: 1, snippet: 'says yes' },
        { file: 'b.ts', line: 2, snippet: 'says no' },
      ],
      fileHashes: { 'a.ts': 'h1', 'b.ts': 'h2' },
      durationMs: 200,
    });
    expect(verdict.type).toBe('contradictory');
    expect(verdict.evidence).toHaveLength(2);
  });

  it('builds uncertain verdict with quality score', () => {
    const verdict = buildVerdict({
      verified: true,
      type: 'uncertain',
      confidence: 0.6,
      evidence: [{ file: 'f.ts', line: 5, snippet: 'maybe ok' }],
      fileHashes: { 'f.ts': 'hash' },
      durationMs: 300,
      qualityScore: {
        architecturalCompliance: 0.8,
        efficiency: 0.7,
        composite: 0.75,
        dimensionsAvailable: 2,
        phase: 'phase0',
      },
    });
    expect(verdict.qualityScore!.composite).toBe(0.75);
  });
});

// ── testOracle ────────────────────────────────────────────────────────

describe('testOracle', () => {
  it('runs multiple fixtures sequentially', async () => {
    // testOracle iterates fixtures; verify it returns results array
    const fixtures: OracleTestFixture[] = [
      {
        name: 'fixture-1',
        hypothesis: { target: 'f.ts', pattern: 'type-check', workspace: '/tmp' },
        expect: { verified: true },
        timeoutMs: 5_000,
      },
      {
        name: 'fixture-2',
        hypothesis: { target: 'g.ts', pattern: 'symbol-exists', workspace: '/tmp' },
        expect: { verified: false },
        timeoutMs: 5_000,
      },
    ];

    // echo produces non-JSON → both should fail validation
    const results = await testOracle('echo invalid', fixtures);
    expect(results).toHaveLength(2);
    expect(results[0]!.name).toBe('fixture-1');
    expect(results[1]!.name).toBe('fixture-2');
    // Both fail because output is not valid JSON or not valid verdict
    for (const r of results) {
      expect(r.passed).toBe(false);
    }
  });

  it('handles non-existent command gracefully', async () => {
    const fixtures: OracleTestFixture[] = [
      {
        name: 'bad command',
        hypothesis: { target: 'f.ts', pattern: 'type-check', workspace: '/tmp' },
        expect: { verified: true },
        timeoutMs: 5_000,
      },
    ];

    const results = await testOracle('/nonexistent/oracle/binary', fixtures);
    expect(results).toHaveLength(1);
    expect(results[0]!.passed).toBe(false);
  });

  it('returns correct OracleTestResult shape', async () => {
    const fixtures: OracleTestFixture[] = [
      {
        name: 'shape test',
        hypothesis: { target: 'f.ts', pattern: 'type-check', workspace: '/tmp' },
        expect: { verified: true },
        timeoutMs: 5_000,
      },
    ];

    const results = await testOracle('echo hello', fixtures);
    expect(results).toHaveLength(1);
    const r = results[0]!;
    expect(typeof r.name).toBe('string');
    expect(typeof r.passed).toBe('boolean');
    expect(typeof r.durationMs).toBe('number');
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
  });
});
