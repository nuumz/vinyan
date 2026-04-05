import { describe, expect, it } from 'bun:test';
import { classifyFailure, classifyAllFailures, type ClassifiedFailure } from '../../src/orchestrator/failure-classifier.ts';
import type { OracleVerdict } from '../../src/core/types.ts';

// ── Helpers ────────────────────────────────────────────────────

function makeVerdict(overrides: Partial<OracleVerdict> = {}): OracleVerdict {
  return {
    verified: false,
    type: 'known',
    confidence: 0.5,
    evidence: [],
    fileHashes: {},
    durationMs: 10,
    ...overrides,
  };
}

// ── Tests ──────────────────────────────────────────────────────

describe('Failure Classifier', () => {
  describe('classifyFailure', () => {
    it('returns empty array for verified verdicts', () => {
      const result = classifyFailure(makeVerdict({ verified: true }), 'type');
      expect(result).toEqual([]);
    });

    it('classifies type oracle failures', () => {
      const result = classifyFailure(
        makeVerdict({ reason: 'src/foo.ts(42,5): error TS2339: Property \'bar\' does not exist on type \'Foo\'' }),
        'type',
      );
      expect(result).toHaveLength(1);
      expect(result[0]!.category).toBe('type_error');
      expect(result[0]!.file).toBe('src/foo.ts');
      expect(result[0]!.line).toBe(42);
      expect(result[0]!.severity).toBe('error');
      expect(result[0]!.message).toContain('TS2339');
    });

    it('classifies type oracle with unparseable reason', () => {
      const result = classifyFailure(
        makeVerdict({ reason: 'Type checking failed' }),
        'type',
      );
      expect(result).toHaveLength(1);
      expect(result[0]!.category).toBe('type_error');
      expect(result[0]!.message).toBe('Type checking failed');
    });

    it('classifies lint oracle failures', () => {
      const result = classifyFailure(
        makeVerdict({ reason: 'src/foo.ts:15:3 — no-unused-vars' }),
        'lint',
      );
      expect(result).toHaveLength(1);
      expect(result[0]!.category).toBe('lint_violation');
      expect(result[0]!.file).toBe('src/foo.ts');
      expect(result[0]!.line).toBe(15);
      expect(result[0]!.severity).toBe('warning');
    });

    it('classifies test oracle failures', () => {
      const result = classifyFailure(
        makeVerdict({ reason: 'Test suite failed: 2 of 5 tests did not pass' }),
        'test',
      );
      expect(result).toHaveLength(1);
      expect(result[0]!.category).toBe('test_failure');
      expect(result[0]!.severity).toBe('error');
      expect(result[0]!.suggestedFix).toBeDefined();
    });

    it('classifies AST oracle failures with evidence', () => {
      const result = classifyFailure(
        makeVerdict({
          reason: 'Symbol not found',
          evidence: [{ file: 'src/bar.ts', line: 10, snippet: 'missing symbol' }],
        }),
        'ast',
      );
      expect(result).toHaveLength(1);
      expect(result[0]!.category).toBe('ast_error');
      expect(result[0]!.file).toBe('src/bar.ts');
      expect(result[0]!.line).toBe(10);
    });

    it('classifies goal-alignment failures', () => {
      const result = classifyFailure(
        makeVerdict({ reason: 'Expected mutation but none produced; Target symbol \'foo\' not present in output' }),
        'goal-alignment',
      );
      expect(result).toHaveLength(2);
      expect(result[0]!.category).toBe('goal_misalignment');
      expect(result[1]!.category).toBe('goal_misalignment');
      expect(result[0]!.severity).toBe('warning');
    });

    it('classifies unknown oracle failures', () => {
      const result = classifyFailure(
        makeVerdict({ reason: 'Something went wrong' }),
        'custom-oracle',
      );
      expect(result).toHaveLength(1);
      expect(result[0]!.category).toBe('unknown');
    });
  });

  describe('classifyAllFailures', () => {
    it('aggregates failures from multiple oracles', () => {
      const verdicts: Record<string, OracleVerdict> = {
        type: makeVerdict({ reason: 'Type error occurred' }),
        lint: makeVerdict({ verified: true }), // should be skipped
        test: makeVerdict({ reason: 'Tests failed' }),
      };
      const result = classifyAllFailures(verdicts);
      expect(result).toHaveLength(2); // type + test (lint is verified, skipped)
      const categories = result.map((f) => f.category);
      expect(categories).toContain('type_error');
      expect(categories).toContain('test_failure');
    });

    it('returns empty array when all verdicts pass', () => {
      const verdicts: Record<string, OracleVerdict> = {
        type: makeVerdict({ verified: true }),
        lint: makeVerdict({ verified: true }),
      };
      const result = classifyAllFailures(verdicts);
      expect(result).toEqual([]);
    });
  });

  describe('file:line extraction', () => {
    it('extracts from tsc-style output', () => {
      const result = classifyFailure(
        makeVerdict({ reason: 'src/utils/helper.ts(100,12): error TS2304: Cannot find name \'xyz\'' }),
        'type',
      );
      expect(result[0]!.file).toBe('src/utils/helper.ts');
      expect(result[0]!.line).toBe(100);
    });

    it('extracts from eslint-style output', () => {
      const result = classifyFailure(
        makeVerdict({ reason: 'src/index.ts:25:1 — unused-import' }),
        'lint',
      );
      expect(result[0]!.file).toBe('src/index.ts');
      expect(result[0]!.line).toBe(25);
    });
  });
});
