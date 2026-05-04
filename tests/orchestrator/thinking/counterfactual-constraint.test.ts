import { describe, expect, test } from 'bun:test';
import type { ClassifiedFailure } from '../../../src/orchestrator/failure-classifier.ts';
import { buildCounterfactualConstraints } from '../../../src/orchestrator/thinking/counterfactual-constraint.ts';

function failure(
  overrides: Partial<ClassifiedFailure> & { category: ClassifiedFailure['category'] },
): ClassifiedFailure {
  return {
    category: overrides.category,
    message: overrides.message ?? 'something went wrong',
    severity: overrides.severity ?? 'error',
    file: overrides.file,
    line: overrides.line,
    suggestedFix: overrides.suggestedFix,
  };
}

describe('buildCounterfactualConstraints', () => {
  test('empty input → empty output (no fabricated constraints)', () => {
    expect(buildCounterfactualConstraints([])).toEqual([]);
  });

  test('single type_error → one constraint with type-specific directive', () => {
    const out = buildCounterfactualConstraints([
      failure({ category: 'type_error', file: 'foo.ts', line: 42, message: 'TS2339: Property X does not exist' }),
    ]);
    expect(out.length).toBe(1);
    expect(out[0]?.category).toBe('type_error');
    expect(out[0]?.failureCount).toBe(1);
    expect(out[0]?.negativeDirective).toContain('type compatibility');
    expect(out[0]?.evidence).toEqual(['foo.ts:42 — TS2339: Property X does not exist']);
  });

  test('multiple failures of same category collapse into one constraint with count', () => {
    const out = buildCounterfactualConstraints([
      failure({ category: 'lint_violation', message: 'no-explicit-any' }),
      failure({ category: 'lint_violation', message: 'prefer-const' }),
      failure({ category: 'lint_violation', message: 'no-unused-vars' }),
    ]);
    expect(out.length).toBe(1);
    expect(out[0]?.failureCount).toBe(3);
    expect(out[0]?.evidence.length).toBe(3);
  });

  test('evidence array bounded — additional failures past EVIDENCE_LIMIT increase count but not list size', () => {
    const failures = Array.from({ length: 8 }, (_, i) =>
      failure({ category: 'test_failure', message: `test ${i + 1} failed` }),
    );
    const out = buildCounterfactualConstraints(failures);
    expect(out[0]?.failureCount).toBe(8);
    expect(out[0]?.evidence.length).toBe(3); // EVIDENCE_LIMIT
  });

  test('different categories produce one constraint each, sorted by category', () => {
    const out = buildCounterfactualConstraints([
      failure({ category: 'test_failure', message: 't1' }),
      failure({ category: 'ast_error', message: 'a1' }),
      failure({ category: 'type_error', message: 'ty1' }),
    ]);
    expect(out.length).toBe(3);
    expect(out.map((c) => c.category)).toEqual(['ast_error', 'test_failure', 'type_error']);
  });

  test('output is byte-stable across input order permutations (A3 determinism)', () => {
    const a = [
      failure({ category: 'lint_violation', message: 'lint-a' }),
      failure({ category: 'type_error', message: 'type-a' }),
      failure({ category: 'lint_violation', message: 'lint-b' }),
    ];
    const b = [
      failure({ category: 'type_error', message: 'type-a' }),
      failure({ category: 'lint_violation', message: 'lint-a' }),
      failure({ category: 'lint_violation', message: 'lint-b' }),
    ];
    const outA = buildCounterfactualConstraints(a);
    const outB = buildCounterfactualConstraints(b);
    expect(outA.map((c) => c.category)).toEqual(outB.map((c) => c.category));
    expect(outA.map((c) => c.negativeDirective)).toEqual(outB.map((c) => c.negativeDirective));
    expect(outA.map((c) => c.failureCount)).toEqual(outB.map((c) => c.failureCount));
  });

  test('hallucination_file produces a verify-with-Read directive', () => {
    const out = buildCounterfactualConstraints([
      failure({ category: 'hallucination_file', message: 'src/missing.ts' }),
    ]);
    expect(out[0]?.negativeDirective.toLowerCase()).toContain('read');
  });

  test('unknown category falls back to a generic re-examine directive', () => {
    const out = buildCounterfactualConstraints([failure({ category: 'unknown', message: 'mystery failure' })]);
    expect(out[0]?.category).toBe('unknown');
    expect(out[0]?.negativeDirective.toLowerCase()).toContain('re-examine');
  });

  test('directives are full-stop-terminated imperatives (style contract)', () => {
    const cats: Array<ClassifiedFailure['category']> = [
      'type_error',
      'lint_violation',
      'test_failure',
      'ast_error',
      'goal_misalignment',
      'hallucination_file',
      'hallucination_import',
      'hallucination_tool_call',
      'hallucination_symbol',
      'overconfidence',
      'unknown',
    ];
    for (const cat of cats) {
      const out = buildCounterfactualConstraints([failure({ category: cat, message: 'm' })]);
      const directive = out[0]?.negativeDirective ?? '';
      expect(directive.length).toBeGreaterThan(0);
      // Every directive ends in '.' so the prompt rendering can join them safely.
      expect(directive.endsWith('.')).toBe(true);
    }
  });
});
