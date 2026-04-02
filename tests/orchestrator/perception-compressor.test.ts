import { describe, expect, it } from 'bun:test';
import { compressPerception, estimateTokens } from '../../src/orchestrator/llm/perception-compressor.ts';
import type { PerceptualHierarchy } from '../../src/orchestrator/types.ts';

function makePerception(overrides: Partial<PerceptualHierarchy> = {}): PerceptualHierarchy {
  return {
    taskTarget: { file: 'src/main.ts', description: 'Fix bug' },
    dependencyCone: {
      directImporters: ['src/a.ts'],
      directImportees: ['src/b.ts'],
      transitiveBlastRadius: 3,
    },
    diagnostics: {
      lintWarnings: [],
      typeErrors: [],
      failingTests: [],
    },
    verifiedFacts: [],
    runtime: { nodeVersion: '20.0.0', os: 'linux', availableTools: ['bun'] },
    ...overrides,
  };
}

describe('compressPerception', () => {
  it('small perception passes through unchanged', () => {
    const p = makePerception();
    const result = compressPerception(p, 128_000);
    // Same reference — no clone needed when under budget
    expect(result).toBe(p);
  });

  it('large perception compressed to ≤ 30% context budget', () => {
    const p = makePerception({
      verifiedFacts: Array.from({ length: 100 }, (_, i) => ({
        target: `src/other-${i}.ts`,
        pattern: 'export function ' + 'x'.repeat(50),
        verified_at: i,
        hash: 'abc' + i,
      })),
      dependencyCone: {
        directImporters: Array.from({ length: 30 }, (_, i) => `src/imp-${i}.ts`),
        directImportees: ['src/b.ts'],
        transitiveBlastRadius: 50,
        transitiveImporters: Array.from({ length: 50 }, (_, i) => `src/trans-${i}.ts`),
        affectedTestFiles: Array.from({ length: 20 }, (_, i) => `tests/t-${i}.ts`),
      },
      diagnostics: {
        lintWarnings: Array.from({ length: 200 }, (_, i) => ({
          file: `src/w-${i}.ts`,
          line: i,
          message: 'Unused variable ' + 'y'.repeat(30),
        })),
        typeErrors: Array.from({ length: 20 }, (_, i) => ({
          file: `src/e-${i}.ts`,
          line: i,
          message: 'Type error ' + 'z'.repeat(30),
        })),
        failingTests: ['tests/fail.ts'],
      },
    });

    const budgetTokens = Math.floor(4000 * 0.30);
    const result = compressPerception(p, 4000);
    expect(estimateTokens(result)).toBeLessThanOrEqual(budgetTokens);
  });

  it('target file facts preserved at full fidelity', () => {
    const targetFacts = Array.from({ length: 5 }, (_, i) => ({
      target: 'src/main.ts',
      pattern: `target-fact-${i}`,
      verified_at: i,
      hash: `th${i}`,
    }));
    const otherFacts = Array.from({ length: 30 }, (_, i) => ({
      target: `src/other-${i}.ts`,
      pattern: `other-fact-${i}` + 'x'.repeat(100),
      verified_at: i,
      hash: `oh${i}`,
    }));

    const p = makePerception({ verifiedFacts: [...targetFacts, ...otherFacts] });
    const result = compressPerception(p, 2000);

    // All target facts present
    const resultTargetFacts = result.verifiedFacts.filter(f => f.target === 'src/main.ts');
    expect(resultTargetFacts).toHaveLength(5);
    for (const tf of targetFacts) {
      expect(resultTargetFacts).toContainEqual(tf);
    }
  });

  it('transitiveImporters replaced with empty array', () => {
    const p = makePerception({
      dependencyCone: {
        directImporters: ['src/a.ts'],
        directImportees: ['src/b.ts'],
        transitiveBlastRadius: 30,
        transitiveImporters: Array.from({ length: 30 }, (_, i) => `src/trans-${i}.ts`),
      },
      verifiedFacts: Array.from({ length: 50 }, (_, i) => ({
        target: `src/other-${i}.ts`,
        pattern: 'export function ' + 'x'.repeat(80),
        verified_at: i,
        hash: `h${i}`,
      })),
      diagnostics: {
        lintWarnings: [],
        typeErrors: [],
        failingTests: [],
      },
    });

    // Budget tight enough that step B is needed (warnings already empty)
    const result = compressPerception(p, 1500);
    expect(result.dependencyCone.transitiveImporters).toEqual([]);
    // Blast radius count preserved
    expect(result.dependencyCone.transitiveBlastRadius).toBe(30);
  });

  it('typeErrors preserved when lintWarnings dropped', () => {
    const errors = Array.from({ length: 5 }, (_, i) => ({
      file: 'src/main.ts',
      line: i + 1,
      message: `Type error ${i}`,
    }));
    const warnings = Array.from({ length: 100 }, (_, i) => ({
      file: `src/w-${i}.ts`,
      line: i,
      message: 'Lint warning ' + 'w'.repeat(50),
    }));

    const p = makePerception({
      diagnostics: { typeErrors: errors, lintWarnings: warnings, failingTests: [] },
    });

    const result = compressPerception(p, 3000);
    expect(result.diagnostics.typeErrors.length).toBeGreaterThan(0);
    expect(result.diagnostics.lintWarnings).toEqual([]);
  });

  it('does not mutate input', () => {
    const p = makePerception({
      dependencyCone: {
        directImporters: ['src/a.ts', 'src/b.ts'],
        directImportees: ['src/c.ts'],
        transitiveBlastRadius: 10,
        transitiveImporters: Array.from({ length: 20 }, (_, i) => `src/t-${i}.ts`),
      },
      diagnostics: {
        lintWarnings: Array.from({ length: 50 }, (_, i) => ({
          file: `src/w-${i}.ts`,
          line: i,
          message: 'warning ' + 'w'.repeat(40),
        })),
        typeErrors: [{ file: 'src/main.ts', line: 1, message: 'err' }],
        failingTests: [],
      },
      verifiedFacts: Array.from({ length: 20 }, (_, i) => ({
        target: `src/f-${i}.ts`,
        pattern: `fact-${i}`,
        verified_at: i,
        hash: `h${i}`,
      })),
    });

    const snapshot = JSON.parse(JSON.stringify(p));
    compressPerception(p, 1500);
    expect(p).toEqual(snapshot);
  });
});
