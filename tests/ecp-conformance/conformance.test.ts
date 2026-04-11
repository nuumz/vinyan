/**
 * ECP Conformance Test Suite tests.
 *
 * Validates that the conformance validators themselves work correctly
 * against known-good and known-bad verdicts.
 */
import { describe, expect, test } from 'bun:test';
import { validateLevel0 } from '../../packages/ecp-conformance/src/level0.ts';
import { validateLevel1, validateJsonRpcEnvelope } from '../../packages/ecp-conformance/src/level1.ts';
import { validateLevel2, validateVersionHandshake, validateVersionResponse } from '../../packages/ecp-conformance/src/level2.ts';
import { validateLevel3, validateKnowledgeOffer, validateKnowledgeAcceptance, validateKnowledgeTransfer } from '../../packages/ecp-conformance/src/level3.ts';
import { runConformanceSuite } from '../../packages/ecp-conformance/src/suite.ts';

// ── Fixtures ─────────────────────────────────────────────────────────

const LEVEL_0_VERDICT = JSON.stringify({
  verified: true,
  evidence: [{ file: 'src/main.ts', line: 10, snippet: 'function foo()' }],
  fileHashes: { 'src/main.ts': 'a'.repeat(64) },
  durationMs: 42,
});

const LEVEL_1_VERDICT = JSON.stringify({
  verified: true,
  type: 'known',
  confidence: 1.0,
  evidence: [{ file: 'src/main.ts', line: 10, snippet: 'function foo()', contentHash: 'b'.repeat(64) }],
  falsifiableBy: ['file:src/main.ts:content-change'],
  fileHashes: { 'src/main.ts': 'a'.repeat(64) },
  durationMs: 42,
});

const LEVEL_2_VERDICT = JSON.stringify({
  verified: true,
  type: 'uncertain',
  confidence: 0.8,
  evidence: [{ file: 'src/main.ts', line: 10, snippet: 'function foo()', contentHash: 'b'.repeat(64) }],
  falsifiableBy: ['file:src/main.ts:content-change', 'dependency:@auth/jwt:version-change'],
  fileHashes: { 'src/main.ts': 'a'.repeat(64) },
  durationMs: 150,
  temporalContext: {
    validFrom: 1000,
    validUntil: 60000,
    decayModel: 'linear',
  },
});

const LEVEL_3_VERDICT = JSON.stringify({
  verified: true,
  type: 'known',
  confidence: 0.9,
  evidence: [{ file: 'src/main.ts', line: 10, snippet: 'function foo()', contentHash: 'b'.repeat(64) }],
  falsifiableBy: ['file:src/main.ts:content-change'],
  fileHashes: { 'src/main.ts': 'a'.repeat(64) },
  durationMs: 80,
  sourceInstanceId: 'inst-abc-123',
  origin: 'a2a',
});

// ── Level 0 ──────────────────────────────────────────────────────────

describe('Level 0 Conformance', () => {
  test('valid verdict passes', () => {
    const result = validateLevel0(LEVEL_0_VERDICT);
    expect(result.passed).toBe(true);
    expect(result.level).toBe(0);
  });

  test('invalid JSON fails', () => {
    const result = validateLevel0('not json at all');
    expect(result.passed).toBe(false);
    expect(result.checks[0]!.name).toBe('valid-json');
    expect(result.checks[0]!.passed).toBe(false);
  });

  test('missing verified field fails', () => {
    const verdict = JSON.stringify({
      evidence: [{ file: 'f.ts', line: 1, snippet: 'x' }],
      fileHashes: { 'f.ts': 'a'.repeat(64) },
      durationMs: 10,
    });
    const result = validateLevel0(verdict);
    expect(result.passed).toBe(false);
  });

  test('missing evidence fails', () => {
    const verdict = JSON.stringify({
      verified: true,
      fileHashes: { 'f.ts': 'a'.repeat(64) },
      durationMs: 10,
    });
    const result = validateLevel0(verdict);
    expect(result.passed).toBe(false);
  });

  test('missing duration fails', () => {
    const verdict = JSON.stringify({
      verified: true,
      evidence: [{ file: 'f.ts', line: 1, snippet: 'x' }],
      fileHashes: { 'f.ts': 'a'.repeat(64) },
    });
    const result = validateLevel0(verdict);
    expect(result.passed).toBe(false);
  });

  test('non-SHA-256 file hashes flagged', () => {
    const verdict = JSON.stringify({
      verified: true,
      evidence: [{ file: 'f.ts', line: 1, snippet: 'x' }],
      fileHashes: { 'f.ts': 'not-a-hash' },
      durationMs: 10,
    });
    const result = validateLevel0(verdict);
    expect(result.passed).toBe(false);
    const hashCheck = result.checks.find((c) => c.name === 'file-hashes-sha256');
    expect(hashCheck?.passed).toBe(false);
  });

  test('accepts duration_ms as alias for durationMs', () => {
    const verdict = JSON.stringify({
      verified: true,
      evidence: [{ file: 'f.ts', line: 1, snippet: 'x' }],
      fileHashes: { 'f.ts': 'a'.repeat(64) },
      duration_ms: 42,
    });
    const result = validateLevel0(verdict);
    expect(result.passed).toBe(true);
  });

  test('empty evidence array fails', () => {
    const verdict = JSON.stringify({
      verified: false,
      evidence: [],
      fileHashes: { 'f.ts': 'a'.repeat(64) },
      durationMs: 10,
    });
    const result = validateLevel0(verdict);
    expect(result.passed).toBe(false);
    const evCheck = result.checks.find((c) => c.name === 'evidence-non-empty');
    expect(evCheck?.passed).toBe(false);
  });
});

// ── Level 1 ──────────────────────────────────────────────────────────

describe('Level 1 Conformance', () => {
  test('valid Level 1 verdict passes', () => {
    const result = validateLevel1(LEVEL_1_VERDICT);
    expect(result.passed).toBe(true);
    expect(result.level).toBe(1);
  });

  test('missing contentHash on evidence fails', () => {
    const verdict = JSON.stringify({
      verified: true,
      type: 'known',
      confidence: 1.0,
      evidence: [{ file: 'f.ts', line: 1, snippet: 'x' }], // no contentHash
      fileHashes: { 'f.ts': 'a'.repeat(64) },
      durationMs: 10,
    });
    const result = validateLevel1(verdict);
    expect(result.passed).toBe(false);
  });

  test('type=known with low confidence flagged', () => {
    const verdict = JSON.stringify({
      verified: true,
      type: 'known',
      confidence: 0.5,
      evidence: [{ file: 'f.ts', line: 1, snippet: 'x', contentHash: 'b'.repeat(64) }],
      fileHashes: { 'f.ts': 'a'.repeat(64) },
      durationMs: 10,
    });
    const result = validateLevel1(verdict);
    expect(result.passed).toBe(false);
    const confCheck = result.checks.find((c) => c.name === 'known-confidence-high');
    expect(confCheck?.passed).toBe(false);
  });

  test('type=unknown with high confidence flagged', () => {
    const verdict = JSON.stringify({
      verified: false,
      type: 'unknown',
      confidence: 0.9,
      evidence: [{ file: 'f.ts', line: 1, snippet: 'x', contentHash: 'b'.repeat(64) }],
      fileHashes: { 'f.ts': 'a'.repeat(64) },
      durationMs: 10,
    });
    const result = validateLevel1(verdict);
    expect(result.passed).toBe(false);
    const confCheck = result.checks.find((c) => c.name === 'unknown-confidence-low');
    expect(confCheck?.passed).toBe(false);
  });

  test('invalid falsifiable_by grammar flagged', () => {
    const verdict = JSON.stringify({
      verified: true,
      type: 'known',
      confidence: 1.0,
      evidence: [{ file: 'f.ts', line: 1, snippet: 'x', contentHash: 'b'.repeat(64) }],
      falsifiableBy: ['invalid-format', 'file:src/main.ts:content-change'],
      fileHashes: { 'f.ts': 'a'.repeat(64) },
      durationMs: 10,
    });
    const result = validateLevel1(verdict);
    expect(result.passed).toBe(false);
    const falsCheck = result.checks.find((c) => c.name === 'falsifiable-grammar');
    expect(falsCheck?.passed).toBe(false);
  });

  test('valid JSON-RPC envelope passes', () => {
    const envelope = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      result: { verified: true },
    });
    const checks = validateJsonRpcEnvelope(envelope);
    expect(checks.every((c) => c.passed)).toBe(true);
  });

  test('missing jsonrpc field fails envelope check', () => {
    const envelope = JSON.stringify({ id: 1, result: {} });
    const checks = validateJsonRpcEnvelope(envelope);
    expect(checks.some((c) => !c.passed)).toBe(true);
  });
});

// ── Level 2 ──────────────────────────────────────────────────────────

describe('Level 2 Conformance', () => {
  test('valid Level 2 verdict passes', () => {
    const result = validateLevel2(LEVEL_2_VERDICT);
    expect(result.passed).toBe(true);
    expect(result.level).toBe(2);
  });

  test('temporal_context with invalid order fails', () => {
    const verdict = JSON.stringify({
      verified: true,
      type: 'known',
      confidence: 1.0,
      evidence: [{ file: 'f.ts', line: 1, snippet: 'x', contentHash: 'b'.repeat(64) }],
      fileHashes: { 'f.ts': 'a'.repeat(64) },
      durationMs: 10,
      temporalContext: {
        validFrom: 5000,
        validUntil: 1000, // before validFrom
        decayModel: 'linear',
      },
    });
    const result = validateLevel2(verdict);
    expect(result.passed).toBe(false);
    const tcCheck = result.checks.find((c) => c.name === 'temporal-context-order');
    expect(tcCheck?.passed).toBe(false);
  });

  test('deliberation with empty reason fails', () => {
    const verdict = JSON.stringify({
      verified: false,
      type: 'uncertain',
      confidence: 0.4,
      evidence: [{ file: 'f.ts', line: 1, snippet: 'x', contentHash: 'b'.repeat(64) }],
      fileHashes: { 'f.ts': 'a'.repeat(64) },
      durationMs: 10,
      deliberationRequest: {
        reason: '',
        suggestedBudget: 5000,
      },
    });
    const result = validateLevel2(verdict);
    expect(result.passed).toBe(false);
  });

  test('version handshake validates', () => {
    const handshake = JSON.stringify({
      ecp_version: 1,
      supported_versions: [1],
      engine_name: 'test-oracle',
      tier: 'deterministic',
      patterns: ['type-check'],
      languages: ['typescript'],
    });
    const checks = validateVersionHandshake(handshake);
    expect(checks.every((c) => c.passed)).toBe(true);
  });

  test('version handshake: preferred not in supported fails', () => {
    const handshake = JSON.stringify({
      ecp_version: 2,
      supported_versions: [1],
      engine_name: 'test-oracle',
      tier: 'deterministic',
      patterns: ['type-check'],
      languages: ['typescript'],
    });
    const checks = validateVersionHandshake(handshake);
    const prefCheck = checks.find((c) => c.name === 'preferred-in-supported');
    expect(prefCheck?.passed).toBe(false);
  });

  test('version response validates against supported list', () => {
    const response = JSON.stringify({
      negotiated_version: 1,
      instance_id: 'inst-1',
      features: ['deliberation'],
    });
    const checks = validateVersionResponse(response, [1]);
    expect(checks.every((c) => c.passed)).toBe(true);
  });

  test('version response: negotiated not in supported fails', () => {
    const response = JSON.stringify({
      negotiated_version: 2,
      instance_id: 'inst-1',
      features: [],
    });
    const checks = validateVersionResponse(response, [1]);
    const negCheck = checks.find((c) => c.name === 'negotiated-version-supported');
    expect(negCheck?.passed).toBe(false);
  });
});

// ── Level 3 ──────────────────────────────────────────────────────────

describe('Level 3 Conformance', () => {
  test('valid Level 3 verdict passes', () => {
    const result = validateLevel3(LEVEL_3_VERDICT);
    expect(result.passed).toBe(true);
    expect(result.level).toBe(3);
  });

  test('missing sourceInstanceId fails', () => {
    const verdict = JSON.stringify({
      verified: true,
      type: 'known',
      confidence: 0.9,
      evidence: [{ file: 'f.ts', line: 1, snippet: 'x', contentHash: 'b'.repeat(64) }],
      fileHashes: { 'f.ts': 'a'.repeat(64) },
      durationMs: 10,
      // no sourceInstanceId
    });
    const result = validateLevel3(verdict);
    expect(result.passed).toBe(false);
  });

  test('remote verdict above confidence ceiling fails (I13)', () => {
    const verdict = JSON.stringify({
      verified: true,
      type: 'known',
      confidence: 0.99,
      evidence: [{ file: 'f.ts', line: 1, snippet: 'x', contentHash: 'b'.repeat(64) }],
      fileHashes: { 'f.ts': 'a'.repeat(64) },
      durationMs: 10,
      sourceInstanceId: 'inst-1',
      origin: 'a2a',
    });
    const result = validateLevel3(verdict);
    expect(result.passed).toBe(false);
    const ceilCheck = result.checks.find((c) => c.name === 'remote-confidence-ceiling');
    expect(ceilCheck?.passed).toBe(false);
  });

  test('local origin allows high confidence', () => {
    const verdict = JSON.stringify({
      verified: true,
      type: 'known',
      confidence: 1.0,
      evidence: [{ file: 'f.ts', line: 1, snippet: 'x', contentHash: 'b'.repeat(64) }],
      fileHashes: { 'f.ts': 'a'.repeat(64) },
      durationMs: 10,
      sourceInstanceId: 'inst-1',
      origin: 'local',
    });
    const result = validateLevel3(verdict);
    expect(result.passed).toBe(true);
  });

  test('signature without signerInstanceId fails', () => {
    const verdict = JSON.stringify({
      verified: true,
      type: 'known',
      confidence: 0.9,
      evidence: [{ file: 'f.ts', line: 1, snippet: 'x', contentHash: 'b'.repeat(64) }],
      fileHashes: { 'f.ts': 'a'.repeat(64) },
      durationMs: 10,
      sourceInstanceId: 'inst-1',
      signature: 'abcdef1234',
      // no signerInstanceId
    });
    const result = validateLevel3(verdict);
    expect(result.passed).toBe(false);
  });

  test('valid signed verdict passes', () => {
    const verdict = JSON.stringify({
      verified: true,
      type: 'known',
      confidence: 0.9,
      evidence: [{ file: 'f.ts', line: 1, snippet: 'x', contentHash: 'b'.repeat(64) }],
      fileHashes: { 'f.ts': 'a'.repeat(64) },
      durationMs: 10,
      sourceInstanceId: 'inst-1',
      signature: 'abcdef1234567890',
      signerInstanceId: 'inst-1',
    });
    const result = validateLevel3(verdict);
    expect(result.passed).toBe(true);
  });
});

// ── Knowledge Sharing Protocol ───────────────────────────────────────

describe('Knowledge Sharing Protocol', () => {
  test('valid knowledge offer passes', () => {
    const offer = JSON.stringify({
      cycleId: 'cycle-1',
      instanceId: 'inst-1',
      patterns: [
        { id: 'p1', type: 'success', confidence: 0.8, portability: 'universal' },
        { id: 'p2', type: 'failure', confidence: 0.6, portability: 'framework-specific' },
      ],
    });
    const checks = validateKnowledgeOffer(offer);
    expect(checks.every((c) => c.passed)).toBe(true);
  });

  test('offer with out-of-range confidence fails', () => {
    const offer = JSON.stringify({
      cycleId: 'cycle-1',
      instanceId: 'inst-1',
      patterns: [{ id: 'p1', type: 'success', confidence: 1.5, portability: 'universal' }],
    });
    const checks = validateKnowledgeOffer(offer);
    expect(checks.some((c) => !c.passed)).toBe(true);
  });

  test('valid acceptance passes', () => {
    const accept = JSON.stringify({
      acceptedPatternIds: ['p1'],
      rejectedPatternIds: ['p2'],
    });
    const checks = validateKnowledgeAcceptance(accept);
    expect(checks.every((c) => c.passed)).toBe(true);
  });

  test('valid transfer passes', () => {
    const transfer = JSON.stringify({
      cycleId: 'cycle-1',
      instanceId: 'inst-1',
      patterns: [
        { id: 'p1', type: 'success', confidence: 0.4, fingerprint: 'fp-1', portability: 'universal' },
      ],
    });
    const checks = validateKnowledgeTransfer(transfer);
    expect(checks.every((c) => c.passed)).toBe(true);
  });

  test('transfer with confidence above ceiling fails', () => {
    const transfer = JSON.stringify({
      cycleId: 'cycle-1',
      instanceId: 'inst-1',
      patterns: [
        { id: 'p1', type: 'success', confidence: 0.98, fingerprint: 'fp-1', portability: 'universal' },
      ],
    });
    const checks = validateKnowledgeTransfer(transfer);
    const ceilCheck = checks.find((c) => c.name === 'transfer-confidence-ceiling');
    expect(ceilCheck?.passed).toBe(false);
  });
});

// ── Suite Runner ─────────────────────────────────────────────────────

describe('Conformance Suite', () => {
  test('Level 0 verdict achieves Level 0 only', () => {
    const result = runConformanceSuite(LEVEL_0_VERDICT, 2);
    expect(result.achievedLevel).toBe(0);
    expect(result.levels[0]!.passed).toBe(true);
    expect(result.levels[1]!.passed).toBe(false); // Level 1 fails (no type, no contentHash)
  });

  test('Level 1 verdict achieves Level 1', () => {
    const result = runConformanceSuite(LEVEL_1_VERDICT, 1);
    expect(result.achievedLevel).toBe(1);
    expect(result.targetLevel).toBe(1);
  });

  test('Level 2 verdict achieves Level 2', () => {
    const result = runConformanceSuite(LEVEL_2_VERDICT, 2);
    expect(result.achievedLevel).toBe(2);
  });

  test('Level 3 verdict achieves Level 3', () => {
    const result = runConformanceSuite(LEVEL_3_VERDICT, 3);
    expect(result.achievedLevel).toBe(3);
    expect(result.levels.length).toBe(4);
  });

  test('Level 2 verdict stops at Level 2 when targeting Level 3', () => {
    const result = runConformanceSuite(LEVEL_2_VERDICT, 3);
    expect(result.achievedLevel).toBe(2);
    // Level 3 attempted but fails (no sourceInstanceId)
    expect(result.levels.length).toBe(4);
    expect(result.levels[3]!.passed).toBe(false);
  });

  test('invalid JSON achieves nothing', () => {
    const result = runConformanceSuite('not json', 3);
    expect(result.achievedLevel).toBe(-1);
    expect(result.levels.length).toBe(1); // Stops at Level 0
  });

  test('stops at failed level', () => {
    const badVerdict = JSON.stringify({
      verified: true,
      evidence: [],
      fileHashes: {},
      durationMs: 10,
    });
    const result = runConformanceSuite(badVerdict, 3);
    expect(result.achievedLevel).toBe(-1);
    expect(result.levels.length).toBe(1); // Only Level 0 attempted
  });
});
