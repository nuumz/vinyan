import { describe, expect, test } from 'bun:test';
import { generateCommitMessage } from '../../../src/orchestrator/commit-message/generator.ts';
import { SPEC_ARTIFACT_VERSION, type SpecArtifact } from '../../../src/orchestrator/spec/spec-artifact.ts';

function makeSpec(summary: string): SpecArtifact {
  return {
    version: SPEC_ARTIFACT_VERSION,
    summary,
    acceptanceCriteria: [
      { id: 'ac-1', description: 'Cost ledger writes a row per task', testable: true, oracle: 'test' },
      { id: 'ac-2', description: 'Documented in README', testable: false, oracle: 'manual' },
    ],
    apiShape: [],
    dataContracts: [],
    edgeCases: [
      { id: 'ec-1', scenario: 'Budget zero', expected: 'reject', severity: 'blocker' },
    ],
    openQuestions: [],
  };
}

describe('generateCommitMessage — spec source', () => {
  test('builds conventional message with type + scope from affected files', () => {
    const out = generateCommitMessage({
      spec: makeSpec('Add cost ledger for per-task accounting'),
      affectedFiles: ['src/economy/cost-ledger.ts', 'src/economy/budget-enforcer.ts'],
    });
    expect(out.source).toBe('spec');
    expect(out.degraded).toBe(false);
    expect(out.title.startsWith('feat(economy):')).toBe(true);
    expect(out.title).toContain('Add cost ledger for per-task accounting');
    expect(out.body).toContain('Acceptance:');
    expect(out.body).toContain('- Cost ledger writes a row per task');
    expect(out.body).toContain('Edge cases (blocker):');
    expect(out.body).toContain('Files:');
  });

  test('infers fix type when summary mentions fix/bug', () => {
    const out = generateCommitMessage({
      spec: makeSpec('Fix race condition in worker pool dispatcher'),
      affectedFiles: ['src/orchestrator/concurrent-dispatcher.ts'],
    });
    expect(out.title.startsWith('fix(orchestrator):')).toBe(true);
  });

  test('infers refactor type when summary says refactor', () => {
    const out = generateCommitMessage({
      spec: makeSpec('Refactor goal evaluator to use spec artifact'),
    });
    expect(out.title.startsWith('refactor:')).toBe(true);
  });

  test('truncates long titles to ≤72 chars', () => {
    const out = generateCommitMessage({
      spec: makeSpec(
        'Add ' + 'very '.repeat(30) + 'long summary that would exceed the title length budget',
      ),
    });
    expect(out.title.length).toBeLessThanOrEqual(72);
  });

  test('emits Co-Authored-By trailer when supplied', () => {
    const out = generateCommitMessage({
      spec: makeSpec('Add cost ledger'),
      coAuthor: 'Co-Authored-By: Vinyan <agent@vinyan.dev>',
    });
    expect(out.message).toContain('Co-Authored-By: Vinyan <agent@vinyan.dev>');
  });
});

describe('generateCommitMessage — answer source', () => {
  test('uses worker answer first line as title when no spec is supplied', () => {
    const out = generateCommitMessage({
      answer: 'feat: add ts coder profile\n\nAdds the TypeScript-specialist profile.',
      affectedFiles: ['src/orchestrator/agents/ts-coder.ts'],
    });
    expect(out.source).toBe('answer');
    expect(out.degraded).toBe(false);
    expect(out.title.startsWith('feat(orchestrator):')).toBe(true);
  });
});

describe('generateCommitMessage — fallback source', () => {
  test('emits degraded chore message when neither spec nor answer is present', () => {
    const out = generateCommitMessage({});
    expect(out.source).toBe('fallback');
    expect(out.degraded).toBe(true);
    expect(out.title.startsWith('chore:')).toBe(true);
  });

  test('still includes Files: list when affected files are supplied', () => {
    const out = generateCommitMessage({ affectedFiles: ['src/foo.ts'] });
    expect(out.body).toContain('- src/foo.ts');
  });
});

describe('generateCommitMessage — style override', () => {
  test('plain style omits Conventional Commits prefix', () => {
    const out = generateCommitMessage({
      spec: makeSpec('Add cost ledger feature'),
      style: 'plain',
    });
    expect(out.title.startsWith('feat')).toBe(false);
    expect(out.title).toContain('Add cost ledger feature');
  });
});
