/**
 * Behavior tests for the [COUNTERFACTUAL CONSTRAINTS] prompt section.
 *
 * The section MUST:
 *   - render nothing when no failed approach carries counterfactual constraints
 *   - render a single block when constraints are present
 *   - dedupe by category across multiple failed approaches (latest wins)
 *   - sit AFTER the [FAILED APPROACHES] block in the user-prompt ordering
 */
import { describe, expect, test } from 'bun:test';
import { createDefaultRegistry, type SectionContext } from '../../../src/orchestrator/llm/prompt-section-registry.ts';
import type { WorkingMemoryState } from '../../../src/orchestrator/types.ts';

function emptyMemory(): WorkingMemoryState {
  return {
    failedApproaches: [],
    activeHypotheses: [],
    unresolvedUncertainties: [],
    scopedFacts: [],
  };
}

function baseContext(memory: WorkingMemoryState): SectionContext {
  return {
    goal: 'sample goal',
    perception: {
      taskTarget: { file: 'a.ts', description: 'edit' },
      dependencyCone: { directImporters: [], directImportees: [], transitiveBlastRadius: 0 },
      diagnostics: { lintWarnings: [], typeErrors: [], failingTests: [] },
      verifiedFacts: [],
      runtime: { nodeVersion: 'v22', os: 'linux', availableTools: [] },
    },
    memory,
    routingLevel: 2,
  };
}

function failedApproach(constraints?: WorkingMemoryState['failedApproaches'][number]['counterfactualConstraints']) {
  return {
    approach: 'attempted X',
    oracleVerdict: 'rejected by Y',
    timestamp: 1,
    counterfactualConstraints: constraints,
  };
}

describe('counterfactual-constraints prompt section', () => {
  test('renders nothing when no constraints exist', () => {
    const reg = createDefaultRegistry();
    const out = reg.renderTarget('user', baseContext(emptyMemory()));
    expect(out).not.toContain('COUNTERFACTUAL CONSTRAINTS');
  });

  test('renders nothing when failed approaches exist but carry no counterfactual constraints', () => {
    const memory = emptyMemory();
    memory.failedApproaches.push(failedApproach());
    const reg = createDefaultRegistry();
    const out = reg.renderTarget('user', baseContext(memory));
    expect(out).not.toContain('COUNTERFACTUAL CONSTRAINTS');
  });

  test('renders a single section listing one constraint per category', () => {
    const memory = emptyMemory();
    memory.failedApproaches.push(
      failedApproach([
        {
          category: 'type_error',
          negativeDirective: 'Verify types first.',
          failureCount: 2,
          evidence: ['foo.ts:10 — TS2345'],
        },
      ]),
    );
    const reg = createDefaultRegistry();
    const out = reg.renderTarget('user', baseContext(memory));
    expect(out).toContain('COUNTERFACTUAL CONSTRAINTS');
    expect(out).toContain('type_error (×2)');
    expect(out).toContain('Verify types first.');
    expect(out).toContain('evidence: foo.ts:10 — TS2345');
  });

  test('dedupes by category across multiple failed approaches — latest constraint wins', () => {
    const memory = emptyMemory();
    memory.failedApproaches.push(
      failedApproach([
        { category: 'lint_violation', negativeDirective: 'Old directive.', failureCount: 1, evidence: ['old'] },
      ]),
    );
    memory.failedApproaches.push(
      failedApproach([
        { category: 'lint_violation', negativeDirective: 'New directive.', failureCount: 4, evidence: ['new'] },
      ]),
    );
    const reg = createDefaultRegistry();
    const out = reg.renderTarget('user', baseContext(memory));
    expect(out).toContain('lint_violation (×4)');
    expect(out).toContain('New directive.');
    expect(out).not.toContain('Old directive.');
    // Only one lint_violation line
    const matches = out.match(/lint_violation \(×\d+\)/g) ?? [];
    expect(matches.length).toBe(1);
  });

  test('renders categories in deterministic alphabetical order', () => {
    const memory = emptyMemory();
    memory.failedApproaches.push(
      failedApproach([
        { category: 'type_error', negativeDirective: 'd1.', failureCount: 1, evidence: [] },
        { category: 'ast_error', negativeDirective: 'd2.', failureCount: 1, evidence: [] },
        { category: 'lint_violation', negativeDirective: 'd3.', failureCount: 1, evidence: [] },
      ]),
    );
    const reg = createDefaultRegistry();
    const out = reg.renderTarget('user', baseContext(memory));
    const idxAst = out.indexOf('ast_error');
    const idxLint = out.indexOf('lint_violation');
    const idxType = out.indexOf('type_error');
    expect(idxAst).toBeGreaterThan(-1);
    expect(idxAst).toBeLessThan(idxLint);
    expect(idxLint).toBeLessThan(idxType);
  });

  test('section appears AFTER the [FAILED APPROACHES] section in user-prompt ordering', () => {
    const memory = emptyMemory();
    memory.failedApproaches.push(
      failedApproach([
        { category: 'test_failure', negativeDirective: 'Re-read assertions.', failureCount: 1, evidence: [] },
      ]),
    );
    const reg = createDefaultRegistry();
    const out = reg.renderTarget('user', baseContext(memory));
    const failedIdx = out.indexOf('FAILED APPROACHES');
    const counterfactualIdx = out.indexOf('COUNTERFACTUAL CONSTRAINTS');
    expect(failedIdx).toBeGreaterThan(-1);
    expect(counterfactualIdx).toBeGreaterThan(-1);
    expect(failedIdx).toBeLessThan(counterfactualIdx);
  });
});
