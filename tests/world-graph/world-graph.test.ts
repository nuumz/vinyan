import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Evidence } from '../../src/core/types.ts';
import { WorldGraph } from '../../src/world-graph/world-graph.ts';

describe('WorldGraph', () => {
  let wg: WorldGraph;
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'vinyan-test-'));
    wg = new WorldGraph(); // in-memory DB
  });

  afterEach(() => {
    wg.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  test('storeFact and queryFacts round-trip', () => {
    const evidence: Evidence[] = [{ file: 'src/foo.ts', line: 10, snippet: 'function foo() {}' }];

    const stored = wg.storeFact({
      target: 'src/foo.ts',
      pattern: 'symbol-exists',
      evidence,
      oracleName: 'ast-oracle',
      fileHash: 'abc123',
      sourceFile: 'src/foo.ts',
      verifiedAt: Date.now(),
      sessionId: 'sess-1',
      confidence: 1.0,
    });

    expect(stored.id).toBeTruthy();

    const facts = wg.queryFacts('src/foo.ts');
    expect(facts).toHaveLength(1);
    expect(facts[0]!.target).toBe('src/foo.ts');
    expect(facts[0]!.pattern).toBe('symbol-exists');
    expect(facts[0]!.evidence).toEqual(evidence);
    expect(facts[0]!.oracleName).toBe('ast-oracle');
    expect(facts[0]!.confidence).toBe(1.0);
  });

  test('storeFact deduplicates by content hash', () => {
    const evidence: Evidence[] = [{ file: 'src/foo.ts', line: 10, snippet: 'function foo() {}' }];
    const base = {
      target: 'src/foo.ts',
      pattern: 'symbol-exists',
      evidence,
      oracleName: 'ast-oracle',
      fileHash: 'abc123',
      sourceFile: 'src/foo.ts',
      verifiedAt: Date.now(),
      confidence: 1.0,
    };

    wg.storeFact(base);
    wg.storeFact(base); // same content → same ID → upsert

    const facts = wg.queryFacts('src/foo.ts');
    expect(facts).toHaveLength(1);
  });

  test('queryFacts returns empty for unknown target', () => {
    const facts = wg.queryFacts('nonexistent.ts');
    expect(facts).toHaveLength(0);
  });

  test('computeFileHash returns SHA-256 of file contents', () => {
    const filePath = join(tempDir, 'test.ts');
    writeFileSync(filePath, 'const x = 1;');

    const hash = wg.computeFileHash(filePath);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);

    // Same content → same hash
    const hash2 = wg.computeFileHash(filePath);
    expect(hash2).toBe(hash);
  });

  test('updateFileHash and getFileHash', () => {
    wg.updateFileHash('src/foo.ts', 'hash-v1');
    expect(wg.getFileHash('src/foo.ts')).toBe('hash-v1');

    wg.updateFileHash('src/foo.ts', 'hash-v2');
    expect(wg.getFileHash('src/foo.ts')).toBe('hash-v2');
  });

  test('invalidation: updating file hash deletes facts with old hash', () => {
    // Store a fact with hash "hash-v1"
    wg.updateFileHash('src/foo.ts', 'hash-v1');
    wg.storeFact({
      target: 'src/foo.ts',
      pattern: 'symbol-exists',
      evidence: [{ file: 'src/foo.ts', line: 1, snippet: 'x' }],
      oracleName: 'ast-oracle',
      fileHash: 'hash-v1',
      sourceFile: 'src/foo.ts',
      verifiedAt: Date.now(),
      confidence: 1.0,
    });

    expect(wg.queryFacts('src/foo.ts')).toHaveLength(1);

    // File changes → new hash → old facts invalidated
    wg.updateFileHash('src/foo.ts', 'hash-v2');
    expect(wg.queryFacts('src/foo.ts')).toHaveLength(0);
  });

  test('invalidateByFile computes hash from actual file', () => {
    const filePath = join(tempDir, 'test.ts');
    writeFileSync(filePath, 'const x = 1;');

    const hash = wg.computeFileHash(filePath);
    wg.updateFileHash(filePath, hash);
    wg.storeFact({
      target: filePath,
      pattern: 'symbol-exists',
      evidence: [{ file: filePath, line: 1, snippet: 'const x = 1;' }],
      oracleName: 'ast-oracle',
      fileHash: hash,
      sourceFile: filePath,
      verifiedAt: Date.now(),
      confidence: 1.0,
    });

    expect(wg.queryFacts(filePath)).toHaveLength(1);

    // Modify file → invalidateByFile → facts cleared
    writeFileSync(filePath, 'const x = 2; // changed');
    wg.invalidateByFile(filePath);

    expect(wg.queryFacts(filePath)).toHaveLength(0);
  });

  test('cross-file cascade: evidence file change invalidates fact', () => {
    // Fact about fileA has evidence from fileB
    wg.updateFileHash('src/fileA.ts', 'hashA-v1');
    wg.updateFileHash('src/fileB.ts', 'hashB-v1');

    wg.storeFact({
      target: 'src/fileA.ts',
      pattern: 'import-exists',
      evidence: [
        { file: 'src/fileA.ts', line: 1, snippet: "import { b } from './fileB'" },
        { file: 'src/fileB.ts', line: 5, snippet: 'export function b() {}' },
      ],
      oracleName: 'ast-oracle',
      fileHash: 'hashA-v1',
      sourceFile: 'src/fileA.ts',
      verifiedAt: Date.now(),
      confidence: 1.0,
    });

    expect(wg.queryFacts('src/fileA.ts')).toHaveLength(1);

    // fileB changes → fact about fileA should be invalidated via junction table
    wg.updateFileHash('src/fileB.ts', 'hashB-v2');
    expect(wg.queryFacts('src/fileA.ts')).toHaveLength(0);
  });

  test('cross-file cascade: sourceFile change handled by original trigger', () => {
    wg.updateFileHash('src/fileA.ts', 'hashA-v1');

    wg.storeFact({
      target: 'src/fileA.ts',
      pattern: 'symbol-exists',
      evidence: [{ file: 'src/fileA.ts', line: 1, snippet: 'x' }],
      oracleName: 'ast-oracle',
      fileHash: 'hashA-v1',
      sourceFile: 'src/fileA.ts',
      verifiedAt: Date.now(),
      confidence: 1.0,
    });

    expect(wg.queryFacts('src/fileA.ts')).toHaveLength(1);

    // sourceFile itself changes — original trigger handles this
    wg.updateFileHash('src/fileA.ts', 'hashA-v2');
    expect(wg.queryFacts('src/fileA.ts')).toHaveLength(0);
  });

  test('invalidation is scoped to single file — same hash, different files', () => {
    const sharedHash = 'shared-hash-value';
    wg.updateFileHash('/abs/path/fileA.ts', sharedHash);
    wg.updateFileHash('/abs/path/fileB.ts', sharedHash);

    wg.storeFact({
      target: 'fileA.ts',
      pattern: 'symbol-exists',
      evidence: [{ file: 'fileA.ts', line: 1, snippet: 'x' }],
      oracleName: 'ast-oracle',
      fileHash: sharedHash,
      sourceFile: '/abs/path/fileA.ts',
      verifiedAt: Date.now(),
      confidence: 1.0,
    });

    wg.storeFact({
      target: 'fileB.ts',
      pattern: 'symbol-exists',
      evidence: [{ file: 'fileB.ts', line: 1, snippet: 'x' }],
      oracleName: 'ast-oracle',
      fileHash: sharedHash,
      sourceFile: '/abs/path/fileB.ts',
      verifiedAt: Date.now(),
      confidence: 1.0,
    });

    expect(wg.queryFacts('fileA.ts')).toHaveLength(1);
    expect(wg.queryFacts('fileB.ts')).toHaveLength(1);

    // Modify fileA → new hash
    wg.updateFileHash('/abs/path/fileA.ts', 'new-hash-for-A');

    // fileA facts deleted (sourceFile matches), fileB facts remain
    expect(wg.queryFacts('fileA.ts')).toHaveLength(0);
    expect(wg.queryFacts('fileB.ts')).toHaveLength(1);
  });
});
