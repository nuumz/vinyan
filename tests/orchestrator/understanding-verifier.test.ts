/**
 * Tests for STU Phase C: Understanding Verifier.
 * Verifies claims against filesystem, WorldGraph, and structural evidence.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { WorldGraph } from '../../src/world-graph/world-graph.ts';
import { verifyUnderstandingClaims } from '../../src/orchestrator/understanding-verifier.ts';
import type { SemanticTaskUnderstanding } from '../../src/orchestrator/types.ts';

// ── Helpers ─────────────────────────────────────────────────────────────

let tempDir: string;
let worldGraph: WorldGraph;

beforeAll(() => {
  tempDir = join(import.meta.dir, '.tmp-verifier-test');
  mkdirSync(join(tempDir, 'src/auth'), { recursive: true });
  mkdirSync(join(tempDir, 'src/payment'), { recursive: true });
  writeFileSync(join(tempDir, 'src/auth/service.ts'), 'export class AuthService {}');
  writeFileSync(join(tempDir, 'src/payment/gateway.ts'), 'export class PaymentGateway {}');

  worldGraph = new WorldGraph(':memory:');
});

afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function makeUnderstanding(overrides: Partial<SemanticTaskUnderstanding> = {}): SemanticTaskUnderstanding {
  return {
    rawGoal: 'fix the auth service bug',
    actionVerb: 'fix',
    actionCategory: 'mutation',
    frameworkContext: [],
    constraints: [],
    acceptanceCriteria: [],
    expectsMutation: true,
    resolvedEntities: [],
    understandingDepth: 1,
    verifiedClaims: [],
    understandingFingerprint: 'test-fp',
    ...overrides,
  };
}

// ── Entity file existence ───────────────────────────────────────────────

describe('entity file existence verification', () => {
  test('existing file → type "known", confidence 0.99, tierReliability 1.0', () => {
    const understanding = makeUnderstanding({
      resolvedEntities: [{
        reference: 'auth service',
        resolvedPaths: ['src/auth/service.ts'],
        resolution: 'fuzzy-path',
        confidence: 0.8,
        confidenceSource: 'evidence-derived',
      }],
    });

    const claims = verifyUnderstandingClaims(understanding, worldGraph, tempDir);
    const fileClaim = claims.find((c) => c.claim.includes('src/auth/service.ts'));
    expect(fileClaim).toBeDefined();
    expect(fileClaim!.type).toBe('known');
    expect(fileClaim!.confidence).toBe(0.99);
    expect(fileClaim!.tierReliability).toBe(1.0);
    expect(fileClaim!.verifiedBy).toBe('fs');
    expect(fileClaim!.confidenceSource).toBe('evidence-derived');
  });

  test('non-existent file → type "contradictory", confidence 0.01', () => {
    const understanding = makeUnderstanding({
      resolvedEntities: [{
        reference: 'missing file',
        resolvedPaths: ['src/missing/file.ts'],
        resolution: 'fuzzy-path',
        confidence: 0.7,
        confidenceSource: 'evidence-derived',
      }],
    });

    const claims = verifyUnderstandingClaims(understanding, worldGraph, tempDir);
    const fileClaim = claims.find((c) => c.claim.includes('src/missing/file.ts'));
    expect(fileClaim).toBeDefined();
    expect(fileClaim!.type).toBe('contradictory');
    expect(fileClaim!.confidence).toBe(0.01);
    expect(fileClaim!.falsifiableBy).toContain('file-deleted');
  });

  test('multiple entities, mixed existence → correct per-entity claims', () => {
    const understanding = makeUnderstanding({
      resolvedEntities: [
        {
          reference: 'auth service',
          resolvedPaths: ['src/auth/service.ts'],
          resolution: 'exact',
          confidence: 1.0,
          confidenceSource: 'evidence-derived',
        },
        {
          reference: 'missing thing',
          resolvedPaths: ['src/nope.ts'],
          resolution: 'fuzzy-path',
          confidence: 0.6,
          confidenceSource: 'evidence-derived',
        },
      ],
    });

    const claims = verifyUnderstandingClaims(understanding, worldGraph, tempDir);
    const knownClaims = claims.filter((c) => c.type === 'known');
    const contradictoryClaims = claims.filter((c) => c.type === 'contradictory');
    expect(knownClaims.length).toBeGreaterThanOrEqual(1);
    expect(contradictoryClaims.length).toBeGreaterThanOrEqual(1);
  });

  test('empty resolvedEntities → no file claims', () => {
    const understanding = makeUnderstanding({ resolvedEntities: [] });
    const claims = verifyUnderstandingClaims(understanding, worldGraph, tempDir);
    const fileClaims = claims.filter((c) => c.verifiedBy === 'fs');
    expect(fileClaims).toHaveLength(0);
  });
});

// ── Symbol verification via WorldGraph ──────────────────────────────────

describe('symbol verification via WorldGraph', () => {
  test('symbol found in WorldGraph → type "known"', () => {
    const wg = new WorldGraph(':memory:');
    wg.storeFact({
      target: 'AuthService.validate',
      pattern: 'symbol-exists',
      evidence: [{ file: 'src/auth/service.ts', line: 10, snippet: 'validate()' }],
      oracleName: 'ast-oracle',
      fileHash: 'abc123',
      sourceFile: 'src/auth/service.ts',
      verifiedAt: Date.now(),
      confidence: 0.95,
    });

    const understanding = makeUnderstanding({ targetSymbol: 'AuthService.validate' });
    const claims = verifyUnderstandingClaims(understanding, wg, tempDir);
    const symbolClaim = claims.find((c) => c.claim.includes('AuthService.validate'));

    expect(symbolClaim).toBeDefined();
    expect(symbolClaim!.type).toBe('known');
    expect(symbolClaim!.confidence).toBeGreaterThan(0);
    expect(symbolClaim!.verifiedBy).toBe('ast-oracle');
    expect(symbolClaim!.tierReliability).toBe(0.95);
  });

  test('symbol not found → type "unknown", confidence 0.3', () => {
    const wg = new WorldGraph(':memory:');
    const understanding = makeUnderstanding({ targetSymbol: 'NonExistentClass.method' });
    const claims = verifyUnderstandingClaims(understanding, wg, tempDir);
    const symbolClaim = claims.find((c) => c.claim.includes('NonExistentClass.method'));

    expect(symbolClaim).toBeDefined();
    expect(symbolClaim!.type).toBe('unknown');
    expect(symbolClaim!.confidence).toBe(0.3);
    expect(symbolClaim!.tierReliability).toBe(0.5);
  });

  test('no targetSymbol → no symbol claims generated', () => {
    const understanding = makeUnderstanding({ targetSymbol: undefined });
    const claims = verifyUnderstandingClaims(understanding, worldGraph, tempDir);
    const symbolClaims = claims.filter((c) => c.claim.includes('Symbol'));
    expect(symbolClaims).toHaveLength(0);
  });
});

// ── Scope-entity contradiction ──────────────────────────────────────────

describe('scope-entity contradiction', () => {
  test('scope mentions "auth", entities have auth paths → no contradiction', () => {
    const understanding = makeUnderstanding({
      resolvedEntities: [{
        reference: 'auth service',
        resolvedPaths: ['src/auth/service.ts'],
        resolution: 'exact',
        confidence: 1.0,
        confidenceSource: 'evidence-derived',
      }],
      semanticIntent: {
        primaryAction: 'bug-fix',
        secondaryActions: [],
        scope: 'Authentication service timeout',
        implicitConstraints: [],
        ambiguities: [],
        confidenceSource: 'llm-self-report',
        tierReliability: 0.4,
      },
    });

    const claims = verifyUnderstandingClaims(understanding, worldGraph, tempDir);
    const contradictions = claims.filter((c) => c.type === 'contradictory' && c.claim.includes('scope'));
    expect(contradictions).toHaveLength(0);
  });

  test('scope mentions "payment", no payment entities → contradiction', () => {
    const understanding = makeUnderstanding({
      resolvedEntities: [{
        reference: 'auth service',
        resolvedPaths: ['src/auth/service.ts'],
        resolution: 'exact',
        confidence: 1.0,
        confidenceSource: 'evidence-derived',
      }],
      semanticIntent: {
        primaryAction: 'refactor',
        secondaryActions: [],
        scope: 'Payment gateway integration',
        implicitConstraints: [],
        ambiguities: [],
        confidenceSource: 'llm-self-report',
        tierReliability: 0.4,
      },
    });

    const claims = verifyUnderstandingClaims(understanding, worldGraph, tempDir);
    const contradictions = claims.filter((c) => c.type === 'contradictory' && c.claim.includes('payment'));
    expect(contradictions.length).toBeGreaterThanOrEqual(1);
    expect(contradictions[0]!.confidence).toBe(0.7);
    expect(contradictions[0]!.tierReliability).toBe(0.8);
    expect(contradictions[0]!.confidenceSource).toBe('evidence-derived');
  });

  test('no semanticIntent → no scope claims', () => {
    const understanding = makeUnderstanding({
      resolvedEntities: [{
        reference: 'auth service',
        resolvedPaths: ['src/auth/service.ts'],
        resolution: 'exact',
        confidence: 1.0,
        confidenceSource: 'evidence-derived',
      }],
      semanticIntent: undefined,
    });

    const claims = verifyUnderstandingClaims(understanding, worldGraph, tempDir);
    const scopeClaims = claims.filter((c) => c.claim.includes('scope'));
    expect(scopeClaims).toHaveLength(0);
  });

  test('no entities → no scope contradiction (nothing to compare against)', () => {
    const understanding = makeUnderstanding({
      resolvedEntities: [],
      semanticIntent: {
        primaryAction: 'bug-fix',
        secondaryActions: [],
        scope: 'Authentication service',
        implicitConstraints: [],
        ambiguities: [],
        confidenceSource: 'llm-self-report',
        tierReliability: 0.4,
      },
    });

    const claims = verifyUnderstandingClaims(understanding, worldGraph, tempDir);
    const contradictions = claims.filter((c) => c.type === 'contradictory' && c.claim.includes('scope'));
    expect(contradictions).toHaveLength(0);
  });
});

// ── All claims carry correct ECP fields ─────────────────────────────────

describe('ECP compliance', () => {
  test('all claims have confidenceSource, tierReliability, falsifiableBy, evidence', () => {
    const wg = new WorldGraph(':memory:');
    wg.storeFact({
      target: 'TestSymbol',
      pattern: 'symbol-exists',
      evidence: [{ file: 'src/test.ts', line: 1, snippet: 'class TestSymbol' }],
      oracleName: 'ast-oracle',
      fileHash: 'hash1',
      sourceFile: 'src/test.ts',
      verifiedAt: Date.now(),
      confidence: 0.9,
    });

    const understanding = makeUnderstanding({
      targetSymbol: 'TestSymbol',
      resolvedEntities: [{
        reference: 'auth',
        resolvedPaths: ['src/auth/service.ts'],
        resolution: 'exact',
        confidence: 1.0,
        confidenceSource: 'evidence-derived',
      }],
      semanticIntent: {
        primaryAction: 'bug-fix',
        secondaryActions: [],
        scope: 'Payment processing layer',
        implicitConstraints: [],
        ambiguities: [],
        confidenceSource: 'llm-self-report',
        tierReliability: 0.4,
      },
    });

    const claims = verifyUnderstandingClaims(understanding, wg, tempDir);
    expect(claims.length).toBeGreaterThan(0);

    for (const claim of claims) {
      expect(claim.confidenceSource).toBeDefined();
      expect(typeof claim.tierReliability).toBe('number');
      expect(Array.isArray(claim.falsifiableBy)).toBe(true);
      expect(Array.isArray(claim.evidence)).toBe(true);
      expect(claim.evidence.length).toBeGreaterThan(0);
    }
  });
});

// ── Phase E: WorldGraph fact storage round-trip ────────────────────────

describe('Phase E: understanding facts as WorldGraph facts', () => {
  test('verified "known" claim can be stored and queried from WorldGraph', () => {
    const wg = new WorldGraph(':memory:');

    // Simulate storing a verified understanding claim as a fact
    const sourceFile = 'src/auth/service.ts';
    wg.storeFact({
      target: sourceFile,
      pattern: 'understanding-verified',
      evidence: [{ file: sourceFile, line: 0, snippet: '' }],
      oracleName: 'fs',
      sourceFile,
      fileHash: 'test-hash-123',
      verifiedAt: Date.now(),
      confidence: 0.99,
      decayModel: 'linear',
      tierReliability: 1.0,
    });

    // Query it back
    const facts = wg.queryFacts(sourceFile);
    const understandingFacts = facts.filter((f) => f.pattern === 'understanding-verified');
    expect(understandingFacts.length).toBe(1);
    expect(understandingFacts[0]!.confidence).toBeGreaterThan(0);
    expect(understandingFacts[0]!.tierReliability).toBe(1.0);
    expect(understandingFacts[0]!.oracleName).toBe('fs');
  });

  test('multiple verified claims produce separate facts', () => {
    const wg = new WorldGraph(':memory:');

    wg.storeFact({
      target: 'src/auth/service.ts',
      pattern: 'understanding-verified',
      evidence: [{ file: 'src/auth/service.ts', line: 0, snippet: '' }],
      oracleName: 'fs',
      sourceFile: 'src/auth/service.ts',
      fileHash: 'hash-1',
      verifiedAt: Date.now(),
      confidence: 0.99,
      tierReliability: 1.0,
    });
    wg.storeFact({
      target: 'src/payment/gateway.ts',
      pattern: 'understanding-verified',
      evidence: [{ file: 'src/payment/gateway.ts', line: 0, snippet: '' }],
      oracleName: 'fs',
      sourceFile: 'src/payment/gateway.ts',
      fileHash: 'hash-2',
      verifiedAt: Date.now(),
      confidence: 0.99,
      tierReliability: 1.0,
    });

    const authFacts = wg.queryFacts('src/auth/service.ts').filter((f) => f.pattern === 'understanding-verified');
    const paymentFacts = wg.queryFacts('src/payment/gateway.ts').filter((f) => f.pattern === 'understanding-verified');
    expect(authFacts.length).toBe(1);
    expect(paymentFacts.length).toBe(1);
  });
});
