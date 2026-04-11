import { describe, expect, test } from 'bun:test';
import {
  extractFilePaths,
  parseFalsifiableCondition,
  parseFalsifiableConditions,
} from '../../src/oracle/falsifiable-parser.ts';
import { WorldGraph } from '../../src/world-graph/world-graph.ts';

describe('falsifiable-parser', () => {
  describe('parseFalsifiableCondition', () => {
    test('file:path:content-change → valid', () => {
      const result = parseFalsifiableCondition('file:src/auth/login.ts:content-change');
      expect(result.valid).toBe(true);
      expect(result.condition).toEqual({
        scope: 'file',
        target: 'src/auth/login.ts',
        event: 'content-change',
      });
      expect(result.raw).toBe('file:src/auth/login.ts:content-change');
    });

    test('dependency:@auth/jwt:version-change → valid', () => {
      const result = parseFalsifiableCondition('dependency:@auth/jwt:version-change');
      expect(result.valid).toBe(true);
      expect(result.condition).toEqual({
        scope: 'dependency',
        target: '@auth/jwt',
        event: 'version-change',
      });
    });

    test('env:NODE_ENV:content-change → valid', () => {
      const result = parseFalsifiableCondition('env:NODE_ENV:content-change');
      expect(result.valid).toBe(true);
      expect(result.condition!.scope).toBe('env');
    });

    test('config:tsconfig.json:content-change → valid', () => {
      const result = parseFalsifiableCondition('config:tsconfig.json:content-change');
      expect(result.valid).toBe(true);
      expect(result.condition!.scope).toBe('config');
    });

    test('time:daily:expiry → valid', () => {
      const result = parseFalsifiableCondition('time:daily:expiry');
      expect(result.valid).toBe(true);
      expect(result.condition!.scope).toBe('time');
      expect(result.condition!.event).toBe('expiry');
    });

    test('file:path:deletion → valid', () => {
      const result = parseFalsifiableCondition('file:src/old.ts:deletion');
      expect(result.valid).toBe(true);
      expect(result.condition!.event).toBe('deletion');
    });

    test('no colons → invalid', () => {
      const result = parseFalsifiableCondition('invalid-string');
      expect(result.valid).toBe(false);
      expect(result.condition).toBeNull();
      expect(result.raw).toBe('invalid-string');
    });

    test('single colon → invalid (no event)', () => {
      const result = parseFalsifiableCondition('file:src/foo.ts');
      expect(result.valid).toBe(false);
    });

    test('unknown scope → invalid', () => {
      const result = parseFalsifiableCondition('unknown:foo:content-change');
      expect(result.valid).toBe(false);
    });

    test('unknown event → invalid', () => {
      const result = parseFalsifiableCondition('file:src/foo.ts:unknown-event');
      expect(result.valid).toBe(false);
    });

    test('empty target → invalid', () => {
      const result = parseFalsifiableCondition('file::content-change');
      expect(result.valid).toBe(false);
    });
  });

  describe('parseFalsifiableConditions (batch)', () => {
    test('mixed valid and invalid', () => {
      const results = parseFalsifiableConditions([
        'file:a.ts:content-change',
        'bad-format',
        'dependency:pkg:version-change',
      ]);
      expect(results).toHaveLength(3);
      expect(results[0]!.valid).toBe(true);
      expect(results[1]!.valid).toBe(false);
      expect(results[2]!.valid).toBe(true);
    });
  });

  describe('extractFilePaths', () => {
    test('extracts only file-scope targets', () => {
      const parsed = parseFalsifiableConditions([
        'file:src/a.ts:content-change',
        'file:src/b.ts:deletion',
        'dependency:@auth/jwt:version-change',
        'env:NODE_ENV:content-change',
      ]);
      const paths = extractFilePaths(parsed);
      expect(paths).toEqual(['src/a.ts', 'src/b.ts']);
    });

    test('deduplicates file paths', () => {
      const parsed = parseFalsifiableConditions(['file:src/a.ts:content-change', 'file:src/a.ts:deletion']);
      const paths = extractFilePaths(parsed);
      expect(paths).toEqual(['src/a.ts']);
    });
  });

  describe('integration: falsifiable_by invalidation in WorldGraph', () => {
    test('file change invalidates fact via falsifiable_conditions', () => {
      const wg = new WorldGraph(':memory:');
      try {
        // Store a fact about a.ts with falsifiable_by referencing b.ts
        const fact = wg.storeFact({
          target: 'src/a.ts',
          pattern: 'type-check',
          evidence: [{ file: 'src/a.ts', line: 1, snippet: 'ok' }],
          oracleName: 'type',
          fileHash: 'hash-a',
          sourceFile: 'src/a.ts',
          verifiedAt: Date.now(),
          confidence: 1.0,
        });

        // Register falsifiable condition: if b.ts changes, this fact is invalid
        wg.storeFalsifiableConditions(fact.id, ['file:src/b.ts:content-change']);

        // Fact exists before b.ts changes
        expect(wg.queryFacts('src/a.ts')).toHaveLength(1);

        // Update b.ts hash — triggers falsifiable_by invalidation
        wg.updateFileHash('src/b.ts', 'new-hash-b');

        // Fact should be invalidated
        expect(wg.queryFacts('src/a.ts')).toHaveLength(0);
      } finally {
        wg.close();
      }
    });

    test('non-matching file change does not invalidate', () => {
      const wg = new WorldGraph(':memory:');
      try {
        const fact = wg.storeFact({
          target: 'src/a.ts',
          pattern: 'type-check',
          evidence: [{ file: 'src/a.ts', line: 1, snippet: 'ok' }],
          oracleName: 'type',
          fileHash: 'hash-a',
          sourceFile: 'src/a.ts',
          verifiedAt: Date.now(),
          confidence: 1.0,
        });
        wg.storeFalsifiableConditions(fact.id, ['file:src/b.ts:content-change']);

        // Change c.ts (not b.ts) — should not invalidate
        wg.updateFileHash('src/c.ts', 'hash-c');

        expect(wg.queryFacts('src/a.ts')).toHaveLength(1);
      } finally {
        wg.close();
      }
    });
  });
});
