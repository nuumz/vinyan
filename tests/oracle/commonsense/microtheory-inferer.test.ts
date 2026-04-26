import { describe, expect, test } from 'bun:test';
import {
  inferAction,
  inferLanguage,
  inferMicrotheory,
  inferRuleMatcher,
} from '../../../src/oracle/commonsense/microtheory-inferer.ts';
import type { ExtractedPattern } from '../../../src/orchestrator/types.ts';

function makePattern(overrides: Partial<ExtractedPattern> = {}): ExtractedPattern {
  return {
    id: 'p1',
    type: 'anti-pattern',
    description: 'test pattern',
    frequency: 30,
    confidence: 0.95,
    taskTypeSignature: 'delete::ts::large-blast',
    approach: 'rm -rf node_modules',
    sourceTraceIds: ['t1'],
    createdAt: 1,
    decayWeight: 1,
    ...overrides,
  };
}

describe('inferLanguage', () => {
  test('TypeScript single extension', () => {
    expect(inferLanguage('delete::ts::large-blast')).toBe('typescript-strict');
    expect(inferLanguage('add::tsx::small')).toBe('typescript-strict');
  });

  test('Python', () => {
    expect(inferLanguage('refactor::py::medium')).toBe('python-typed');
  });

  test('shell extensions', () => {
    expect(inferLanguage('run::sh::single')).toBe('shell-bash');
    expect(inferLanguage('run::zsh::single')).toBe('shell-zsh');
  });

  test('unknown extension → universal', () => {
    expect(inferLanguage('add::md::small')).toBe('universal');
  });

  test('multi-extension → universal (mixed file ops)', () => {
    expect(inferLanguage('refactor::ts,py::medium')).toBe('universal');
  });

  test('no extension or `none` → universal', () => {
    expect(inferLanguage('analyze::none::single')).toBe('universal');
  });

  test('malformed signature → universal', () => {
    expect(inferLanguage('garbage')).toBe('universal');
    expect(inferLanguage('')).toBe('universal');
  });
});

describe('inferAction', () => {
  test('destructive verbs', () => {
    expect(inferAction('delete::ts::large')).toBe('mutation-destructive');
    expect(inferAction('remove::py::small')).toBe('mutation-destructive');
    expect(inferAction('drop::sql::single')).toBe('mutation-destructive');
  });

  test('additive verbs', () => {
    expect(inferAction('add::ts::small')).toBe('mutation-additive');
    expect(inferAction('create::py::medium')).toBe('mutation-additive');
    expect(inferAction('write::md::small')).toBe('mutation-additive');
    expect(inferAction('fix::ts::single')).toBe('mutation-additive');
  });

  test('read-only verbs', () => {
    expect(inferAction('read::py::small')).toBe('read-only');
    expect(inferAction('analyze::ts::large')).toBe('read-only');
  });

  test('tool-invocation verbs', () => {
    expect(inferAction('run::sh::single')).toBe('tool-invocation');
    expect(inferAction('install::none::single')).toBe('tool-invocation');
  });

  test('unknown verb → universal', () => {
    expect(inferAction('frobnicate::ts::small')).toBe('universal');
  });
});

describe('inferMicrotheory — composition', () => {
  test('full 3-axis composition', () => {
    const m = inferMicrotheory(
      makePattern({ taskTypeSignature: 'delete::ts::large-blast' }),
    );
    expect(m).toEqual({
      language: 'typescript-strict',
      domain: 'universal', // M4 v1 always returns universal
      action: 'mutation-destructive',
    });
  });

  test('success-pattern with python', () => {
    const m = inferMicrotheory(
      makePattern({
        type: 'success-pattern',
        taskTypeSignature: 'refactor::py::medium',
      }),
    );
    expect(m.language).toBe('python-typed');
    expect(m.action).toBe('mutation-additive');
  });
});

describe('inferRuleMatcher', () => {
  test('produces literal-substring matcher from approach', () => {
    const m = inferRuleMatcher(makePattern({ approach: 'rm -rf node_modules' }));
    expect(m).toEqual({
      kind: 'literal-substring',
      target_field: 'command',
      needle: 'rm -rf node_modules',
      case_sensitive: false,
    });
  });

  test('truncates long approach to 50 chars', () => {
    const long = 'a'.repeat(100);
    const m = inferRuleMatcher(makePattern({ approach: long }));
    expect(m).not.toBeNull();
    expect(m!.kind).toBe('literal-substring');
    if (m!.kind === 'literal-substring') {
      expect(m!.needle.length).toBe(50);
    }
  });

  test('returns null when approach is empty / too short', () => {
    expect(inferRuleMatcher(makePattern({ approach: undefined }))).toBeNull();
    expect(inferRuleMatcher(makePattern({ approach: '' }))).toBeNull();
    expect(inferRuleMatcher(makePattern({ approach: 'ab' }))).toBeNull();
  });
});
