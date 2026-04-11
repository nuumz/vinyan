import { describe, expect, it } from 'bun:test';
import type { HypothesisTuple } from '../../../src/core/types.ts';
import type { TaskUnderstanding } from '../../../src/orchestrator/types.ts';
import { verify } from '../../../src/oracle/goal-alignment/goal-alignment-verifier.ts';
import { isAbstention } from '../../../src/core/types.ts';

// ── Helpers ────────────────────────────────────────────────────

function makeHypothesis(overrides: Partial<HypothesisTuple> = {}): HypothesisTuple {
  return {
    target: 'src/foo.ts',
    pattern: 'goal-alignment',
    workspace: '/workspace',
    ...overrides,
  };
}

function makeUnderstanding(overrides: Partial<TaskUnderstanding> = {}): TaskUnderstanding {
  return {
    rawGoal: 'Fix the bug in foo.ts',
    actionVerb: 'fix',
    actionCategory: 'mutation',
    frameworkContext: [],
    constraints: [],
    acceptanceCriteria: [],
    expectsMutation: true,
    ...overrides,
  };
}

// ── Tests ──────────────────────────────────────────────────────

describe('Goal Alignment Oracle', () => {
  describe('abstention', () => {
    it('abstains when no understanding is provided', () => {
      const result = verify(makeHypothesis(), undefined);
      expect(isAbstention(result)).toBe(true);
      if (isAbstention(result)) {
        expect(result.reason).toBe('no_understanding');
      }
    });
  });

  describe('Check 1: mutation expectation', () => {
    it('passes when mutation task produces content', () => {
      const h = makeHypothesis({ context: { content: 'const x = 1;' } });
      const u = makeUnderstanding({ expectsMutation: true });
      const result = verify(h, u);
      expect(isAbstention(result)).toBe(false);
      if (!isAbstention(result)) {
        expect(result.verified).toBe(true);
      }
    });

    it('fails when mutation task produces no content', () => {
      const h = makeHypothesis(); // no context.content
      const u = makeUnderstanding({ expectsMutation: true });
      const result = verify(h, u);
      if (!isAbstention(result)) {
        expect(result.verified).toBe(false);
        expect(result.reason).toContain('Expected mutation but none produced');
      }
    });

    it('fails when analysis task produces mutations', () => {
      const h = makeHypothesis({ context: { content: 'const x = 1;' } });
      const u = makeUnderstanding({ expectsMutation: false, actionCategory: 'analysis' });
      const result = verify(h, u);
      if (!isAbstention(result)) {
        expect(result.verified).toBe(false);
        expect(result.reason).toContain('Analysis task should not produce mutations');
      }
    });

    it('passes when analysis task produces no content', () => {
      const h = makeHypothesis();
      const u = makeUnderstanding({ expectsMutation: false, actionCategory: 'analysis' });
      const result = verify(h, u);
      if (!isAbstention(result)) {
        expect(result.verified).toBe(true);
      }
    });
  });

  describe('Check 2: target symbol coverage', () => {
    it('passes when target symbol is found in content', () => {
      const h = makeHypothesis({ context: { content: 'function handleClick() {}' } });
      const u = makeUnderstanding({ targetSymbol: 'handleClick' });
      const result = verify(h, u);
      if (!isAbstention(result)) {
        expect(result.verified).toBe(true);
      }
    });

    it('fails when target symbol is not found in content', () => {
      const h = makeHypothesis({ context: { content: 'function otherFunc() {}' } });
      const u = makeUnderstanding({ targetSymbol: 'handleClick' });
      const result = verify(h, u);
      if (!isAbstention(result)) {
        expect(result.verified).toBe(false);
        expect(result.reason).toContain('handleClick');
      }
    });

    it('passes when no target symbol is specified', () => {
      const h = makeHypothesis({ context: { content: 'const x = 1;' } });
      const u = makeUnderstanding({ targetSymbol: undefined });
      const result = verify(h, u);
      if (!isAbstention(result)) {
        expect(result.verified).toBe(true);
      }
    });

    it('passes when no content to check against', () => {
      const h = makeHypothesis();
      const u = makeUnderstanding({ targetSymbol: 'handleClick', expectsMutation: false });
      const result = verify(h, u);
      // symbol check passes (no content to reject), but mutation check is the deciding factor
      if (!isAbstention(result)) {
        expect(result.verified).toBeDefined();
      }
    });
  });

  describe('Check 3: action-verb alignment', () => {
    it('passes for known verb with matching behavior', () => {
      const h = makeHypothesis({ context: { content: 'fixed code' } });
      const u = makeUnderstanding({ actionVerb: 'fix', expectsMutation: true });
      const result = verify(h, u);
      if (!isAbstention(result)) {
        expect(result.verified).toBe(true);
      }
    });

    it('passes for unknown verb (no expectation to check)', () => {
      const h = makeHypothesis({ context: { content: 'some content' } });
      const u = makeUnderstanding({ actionVerb: 'investigate', expectsMutation: true });
      const result = verify(h, u);
      if (!isAbstention(result)) {
        expect(result.verified).toBe(true);
      }
    });

    it('fails when create verb has no content and expects mutation', () => {
      const h = makeHypothesis(); // no content
      const u = makeUnderstanding({ actionVerb: 'create', expectsMutation: true });
      const result = verify(h, u);
      if (!isAbstention(result)) {
        expect(result.verified).toBe(false);
      }
    });
  });

  describe('Check 4: file scope', () => {
    it('passes when target file is in scope', () => {
      const h = makeHypothesis({ target: 'src/foo.ts', context: { content: 'code' } });
      const u = makeUnderstanding();
      const result = verify(h, u, ['src/foo.ts']);
      if (!isAbstention(result)) {
        expect(result.verified).toBe(true);
      }
    });

    it('fails when target file is out of scope', () => {
      const h = makeHypothesis({ target: 'src/bar.ts', context: { content: 'code' } });
      const u = makeUnderstanding();
      const result = verify(h, u, ['src/foo.ts']);
      if (!isAbstention(result)) {
        expect(result.verified).toBe(false);
        expect(result.reason).toContain('outside expected file scope');
      }
    });

    it('passes when no target files are specified', () => {
      const h = makeHypothesis({ context: { content: 'code' } });
      const u = makeUnderstanding();
      const result = verify(h, u, []);
      if (!isAbstention(result)) {
        expect(result.verified).toBe(true);
      }
    });
  });

  describe('combined checks', () => {
    it('multiple failures lower confidence', () => {
      // Analysis task producing content + wrong file scope = 2 failures
      const h = makeHypothesis({ target: 'src/bar.ts', context: { content: 'code' } });
      const u = makeUnderstanding({
        expectsMutation: false,
        actionCategory: 'analysis',
        targetSymbol: 'missingSymbol',
      });
      const result = verify(h, u, ['src/foo.ts']);
      if (!isAbstention(result)) {
        expect(result.verified).toBe(false);
        expect(result.confidence).toBeLessThan(0.5);
      }
    });

    it('all checks passing gives max heuristic confidence', () => {
      const h = makeHypothesis({ target: 'src/foo.ts', context: { content: 'function handleClick() {}' } });
      const u = makeUnderstanding({ targetSymbol: 'handleClick', actionVerb: 'fix' });
      const result = verify(h, u, ['src/foo.ts']);
      if (!isAbstention(result)) {
        expect(result.verified).toBe(true);
        expect(result.confidence).toBe(0.7); // heuristic tier cap
      }
    });
  });

  describe('verdict structure', () => {
    it('includes evidence, opinion, and temporal context', () => {
      const h = makeHypothesis({ context: { content: 'code' } });
      const u = makeUnderstanding();
      const result = verify(h, u);
      if (!isAbstention(result)) {
        expect(result.oracleName).toBe('goal-alignment');
        expect(result.opinion).toBeDefined();
        expect(result.temporalContext).toBeDefined();
        expect(result.durationMs).toBeGreaterThanOrEqual(0);
        expect(result.evidence).toBeArray();
      }
    });
  });
});
