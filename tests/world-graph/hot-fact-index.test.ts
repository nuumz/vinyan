import { describe, test, expect, beforeEach } from 'bun:test';
import { HotFactIndex } from '../../src/world-graph/hot-fact-index.ts';
import type { Fact } from '../../src/core/types.ts';

function makeFact(overrides: Partial<Fact> = {}): Fact {
  return {
    id: 'fact-1',
    target: 'src/main.ts::handleRequest',
    pattern: 'function-exists',
    evidence: [],
    oracleName: 'ast',
    fileHash: 'abc123',
    sourceFile: '/project/src/main.ts',
    verifiedAt: Date.now(),
    confidence: 0.95,
    ...overrides,
  };
}

describe('HotFactIndex', () => {
  let index: HotFactIndex;

  beforeEach(() => {
    index = new HotFactIndex();
  });

  describe('loadAll', () => {
    test('populates all indices', () => {
      const facts = [
        makeFact({ id: 'f1', target: 'A', sourceFile: '/a.ts' }),
        makeFact({ id: 'f2', target: 'A', sourceFile: '/a.ts' }),
        makeFact({ id: 'f3', target: 'B', sourceFile: '/b.ts' }),
      ];

      index.loadAll(facts);

      expect(index.size).toBe(3);
      expect(index.targetCount).toBe(2);
      expect(index.query('A')).toHaveLength(2);
      expect(index.query('B')).toHaveLength(1);
    });

    test('clears existing data', () => {
      index.loadAll([makeFact({ id: 'f1', target: 'old' })]);
      expect(index.size).toBe(1);

      index.loadAll([makeFact({ id: 'f2', target: 'new' })]);
      expect(index.size).toBe(1);
      expect(index.query('old')).toHaveLength(0);
      expect(index.query('new')).toHaveLength(1);
    });
  });

  describe('query', () => {
    test('returns facts for target', () => {
      const fact = makeFact({ id: 'f1', target: 'X' });
      index.upsert(fact);

      const result = index.query('X');
      expect(result).toHaveLength(1);
      expect(result[0]!.id).toBe('f1');
    });

    test('returns empty array for unknown target', () => {
      expect(index.query('nonexistent')).toEqual([]);
    });

    test('excludes expired facts (validUntil < now)', () => {
      index.upsert(makeFact({ id: 'f1', target: 'T', validUntil: Date.now() - 1000 }));
      index.upsert(makeFact({ id: 'f2', target: 'T', validUntil: Date.now() + 60_000 }));

      const result = index.query('T');
      expect(result).toHaveLength(1);
      expect(result[0]!.id).toBe('f2');
    });

    test('includes facts without validUntil', () => {
      index.upsert(makeFact({ id: 'f1', target: 'T', validUntil: undefined }));

      expect(index.query('T')).toHaveLength(1);
    });
  });

  describe('upsert', () => {
    test('adds new fact', () => {
      index.upsert(makeFact({ id: 'f1', target: 'A' }));

      expect(index.size).toBe(1);
      expect(index.query('A')).toHaveLength(1);
    });

    test('updates existing fact — same id, different target moves bucket', () => {
      index.upsert(makeFact({ id: 'f1', target: 'old-target', sourceFile: '/a.ts' }));
      index.upsert(makeFact({ id: 'f1', target: 'new-target', sourceFile: '/a.ts' }));

      expect(index.size).toBe(1);
      expect(index.query('old-target')).toHaveLength(0);
      expect(index.query('new-target')).toHaveLength(1);
      expect(index.targetCount).toBe(1);
    });
  });

  describe('invalidateByFile', () => {
    test('removes all facts for file', () => {
      index.loadAll([
        makeFact({ id: 'f1', target: 'A', sourceFile: '/src/a.ts' }),
        makeFact({ id: 'f2', target: 'B', sourceFile: '/src/a.ts' }),
        makeFact({ id: 'f3', target: 'C', sourceFile: '/src/b.ts' }),
      ]);

      index.invalidateByFile('/src/a.ts');

      expect(index.size).toBe(1);
      expect(index.query('A')).toHaveLength(0);
      expect(index.query('B')).toHaveLength(0);
      expect(index.query('C')).toHaveLength(1);
    });

    test('is no-op for unknown file', () => {
      index.upsert(makeFact({ id: 'f1' }));
      index.invalidateByFile('/nonexistent.ts');
      expect(index.size).toBe(1);
    });
  });

  describe('remove', () => {
    test('deletes single fact from all indices', () => {
      index.loadAll([
        makeFact({ id: 'f1', target: 'A', sourceFile: '/a.ts' }),
        makeFact({ id: 'f2', target: 'A', sourceFile: '/a.ts' }),
      ]);

      index.remove('f1');

      expect(index.size).toBe(1);
      expect(index.query('A')).toHaveLength(1);
      expect(index.query('A')[0]!.id).toBe('f2');
    });

    test('is no-op for unknown id', () => {
      index.upsert(makeFact({ id: 'f1' }));
      index.remove('nonexistent');
      expect(index.size).toBe(1);
    });
  });

  describe('size and targetCount', () => {
    test('track correctly through mutations', () => {
      expect(index.size).toBe(0);
      expect(index.targetCount).toBe(0);

      index.upsert(makeFact({ id: 'f1', target: 'A' }));
      index.upsert(makeFact({ id: 'f2', target: 'B' }));
      expect(index.size).toBe(2);
      expect(index.targetCount).toBe(2);

      index.remove('f1');
      expect(index.size).toBe(1);
      expect(index.targetCount).toBe(1);
    });
  });

  describe('performance', () => {
    test('query on 1000-target index completes in <100µs', () => {
      const facts = Array.from({ length: 1000 }, (_, i) =>
        makeFact({ id: `f${i}`, target: `target-${i}`, sourceFile: `/src/file-${i}.ts` }),
      );
      index.loadAll(facts);

      // Warm up
      index.query('target-500');

      const start = Bun.nanoseconds();
      const result = index.query('target-500');
      const elapsedUs = (Bun.nanoseconds() - start) / 1000;

      expect(result).toHaveLength(1);
      expect(elapsedUs).toBeLessThan(100);
    });
  });
});
