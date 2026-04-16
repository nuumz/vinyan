import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { verifyContentHashes, applyContentHashVerification } from '../../src/gate/content-hash-verifier.ts';
import type { OracleVerdict } from '../../src/core/types.ts';

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function makeVerdict(overrides?: Partial<OracleVerdict>): OracleVerdict {
  return {
    verified: true,
    type: 'known',
    confidence: 0.9,
    evidence: [],
    fileHashes: {},
    ...overrides,
  } as OracleVerdict;
}

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'vinyan-hash-test-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('verifyContentHashes', () => {
  test('all hashes match → passed: true', () => {
    const content = 'const x = 1;\n';
    writeFileSync(join(tempDir, 'foo.ts'), content);

    const oracleResults = {
      type: makeVerdict({ fileHashes: { 'foo.ts': sha256(content) } }),
    };

    const result = verifyContentHashes(oracleResults, tempDir);
    expect(result.passed).toBe(true);
    expect(result.mismatches.length).toBe(0);
  });

  test('hash mismatch → passed: false with mismatch detail', () => {
    writeFileSync(join(tempDir, 'foo.ts'), 'const x = 1;\n');

    const oracleResults = {
      type: makeVerdict({ fileHashes: { 'foo.ts': sha256('different content') } }),
    };

    const result = verifyContentHashes(oracleResults, tempDir);
    expect(result.passed).toBe(false);
    expect(result.mismatches.length).toBe(1);
    expect(result.mismatches[0]!.oracleName).toBe('type');
    expect(result.mismatches[0]!.file).toBe('foo.ts');
    expect(result.mismatches[0]!.expected).toBe(sha256('different content'));
    expect(result.mismatches[0]!.actual).toBe(sha256('const x = 1;\n'));
  });

  test('missing file → mismatch', () => {
    const oracleResults = {
      type: makeVerdict({ fileHashes: { 'nonexistent.ts': sha256('content') } }),
    };

    const result = verifyContentHashes(oracleResults, tempDir);
    expect(result.passed).toBe(false);
    expect(result.mismatches.length).toBe(1);
    expect(result.mismatches[0]!.file).toBe('nonexistent.ts');
  });

  test('empty fileHashes → passed: true', () => {
    const oracleResults = {
      type: makeVerdict({ fileHashes: {} }),
    };

    const result = verifyContentHashes(oracleResults, tempDir);
    expect(result.passed).toBe(true);
  });

  test('no fileHashes field → passed: true', () => {
    const oracleResults = {
      type: makeVerdict(),
    };

    const result = verifyContentHashes(oracleResults, tempDir);
    expect(result.passed).toBe(true);
  });

  test('multiple oracles, one stale hash → only that oracle flagged', () => {
    const content = 'const x = 1;\n';
    writeFileSync(join(tempDir, 'foo.ts'), content);
    writeFileSync(join(tempDir, 'bar.ts'), content);

    const oracleResults = {
      type: makeVerdict({ fileHashes: { 'foo.ts': sha256(content) } }),
      lint: makeVerdict({ fileHashes: { 'bar.ts': sha256('stale content') } }),
    };

    const result = verifyContentHashes(oracleResults, tempDir);
    expect(result.passed).toBe(false);
    expect(result.mismatches.length).toBe(1);
    expect(result.mismatches[0]!.oracleName).toBe('lint');
  });
});

describe('applyContentHashVerification', () => {
  test('mismatch marks verdict as verified: false', () => {
    const oracleResults: Record<string, OracleVerdict> = {
      type: makeVerdict({ verified: true }),
    };

    applyContentHashVerification(oracleResults, {
      passed: false,
      mismatches: [{ oracleName: 'type', file: 'foo.ts', expected: 'aaa', actual: 'bbb' }],
    });

    expect(oracleResults['type']!.verified).toBe(false);
    expect(oracleResults['type']!.reason).toContain('Content hash mismatch');
  });

  test('passed verification leaves verdicts unchanged', () => {
    const oracleResults: Record<string, OracleVerdict> = {
      type: makeVerdict({ verified: true }),
    };

    applyContentHashVerification(oracleResults, { passed: true, mismatches: [] });
    expect(oracleResults['type']!.verified).toBe(true);
  });
});
