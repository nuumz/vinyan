import { describe, expect, test } from 'bun:test';
import {
  type AbstractPatternExport,
  abstractPattern,
  classifyPortability,
  exportPatterns,
  importAbstractPattern,
  importPatterns,
  migrateExport,
  projectSimilarity,
} from '../../src/evolution/pattern-abstraction.ts';
import type { ExtractedPattern } from '../../src/orchestrator/types.ts';

function makePattern(overrides?: Partial<ExtractedPattern>): ExtractedPattern {
  return {
    id: 'sp-test-001',
    type: 'success-pattern',
    description: 'Approach "direct" outperforms "indirect" by 30% on task type "refactor::.ts::small"',
    frequency: 15,
    confidence: 0.7,
    taskTypeSignature: 'refactor::.ts::small',
    approach: 'direct',
    comparedApproach: 'indirect',
    qualityDelta: 0.3,
    sourceTraceIds: ['t1', 't2', 't3'],
    createdAt: Date.now(),
    decayWeight: 1.0,
    ...overrides,
  };
}

describe('abstractPattern', () => {
  test('produces AbstractPattern from success-pattern', () => {
    const result = abstractPattern(makePattern(), 'my-project');
    expect(result).not.toBeNull();
    expect(result!.fingerprint.actionVerb).toBe('refactor');
    expect(result!.fingerprint.fileExtensions).toEqual(['.ts']);
    expect(result!.fingerprint.blastRadiusBucket).toBe('small');
    expect(result!.sourceProjectId).toBe('my-project');
    expect(result!.type).toBe('success-pattern');
    expect(result!.confidence).toBe(0.7);
  });

  test('strips file paths from approach description', () => {
    const result = abstractPattern(
      makePattern({ approach: 'refactor src/components/Header.tsx by extracting method' }),
      'proj',
    );
    expect(result).not.toBeNull();
    expect(result!.approach).toContain('<path>');
    expect(result!.approach).not.toContain('src/components');
  });

  test('retains framework markers in fingerprint', () => {
    const result = abstractPattern(
      makePattern({
        taskTypeSignature: 'fix::.tsx::medium',
      }),
      'proj',
    );
    expect(result).not.toBeNull();
    expect(result!.applicabilityConditions.languageMarkers).toContain('typescript');
  });

  test('returns null for low-confidence patterns', () => {
    const result = abstractPattern(makePattern({ confidence: 0.1 }), 'proj');
    expect(result).toBeNull();
  });

  test('returns null for low-frequency patterns', () => {
    const result = abstractPattern(makePattern({ frequency: 2 }), 'proj');
    expect(result).toBeNull();
  });

  test('returns null for unparseable task type signature', () => {
    const result = abstractPattern(makePattern({ taskTypeSignature: 'single-segment' }), 'proj');
    expect(result).toBeNull();
  });

  test('handles worker-performance patterns', () => {
    const result = abstractPattern(
      makePattern({
        type: 'worker-performance',
        workerId: 'w1',
        comparedWorkerId: 'w2',
      }),
      'proj',
    );
    expect(result).not.toBeNull();
    expect(result!.type).toBe('worker-performance');
  });
});

describe('importAbstractPattern', () => {
  test('reduces confidence by 50% on import', () => {
    const abstract = abstractPattern(makePattern({ confidence: 0.8 }), 'source')!;
    const imported = importAbstractPattern(abstract, 'target');

    expect(imported.confidence).toBeCloseTo(0.4, 2);
    expect(imported.description).toContain('[imported]');
    expect(imported.decayWeight).toBe(1.0);
    expect(imported.frequency).toBe(0);
  });

  test('reconstructs task type signature from fingerprint', () => {
    const abstract = abstractPattern(makePattern(), 'source')!;
    const imported = importAbstractPattern(abstract, 'target');

    expect(imported.taskTypeSignature).toBe('refactor::.ts::small');
  });

  test('sets derivedFrom to source pattern ID', () => {
    const abstract = abstractPattern(makePattern(), 'source')!;
    const imported = importAbstractPattern(abstract, 'target');

    expect(imported.derivedFrom).toBe('sp-test-001');
  });
});

describe('round-trip serialization', () => {
  test('export → JSON → import preserves structure', () => {
    const patterns = [
      makePattern({ id: 'sp-001' }),
      makePattern({ id: 'sp-002', taskTypeSignature: 'fix::.py::medium' }),
    ];

    const exported = exportPatterns(patterns, 'source-project');
    const json = JSON.stringify(exported);
    const parsed = JSON.parse(json) as AbstractPatternExport;

    expect(parsed.version).toBe(1);
    expect(parsed.projectId).toBe('source-project');
    expect(parsed.patterns.length).toBeGreaterThanOrEqual(1);

    // Import with matching markers
    const imported = importPatterns(
      parsed,
      'target-project',
      { frameworks: [], languages: ['typescript', 'python'] },
      0.3,
    );

    expect(imported.length).toBeGreaterThanOrEqual(1);
    for (const p of imported) {
      expect(p.confidence).toBeLessThan(0.8); // reduced by 50%
      expect(p.description).toContain('[imported]');
    }
  });
});

describe('projectSimilarity', () => {
  test('returns 1.0 for identical marker sets', () => {
    const sim = projectSimilarity(
      { frameworkMarkers: ['react', 'zod'], languageMarkers: ['typescript'], complexityRange: ['small'] },
      { frameworks: ['react', 'zod'], languages: ['typescript'] },
    );
    expect(sim).toBe(1.0);
  });

  test('returns 0 for completely different markers', () => {
    const sim = projectSimilarity(
      { frameworkMarkers: ['django'], languageMarkers: ['python'], complexityRange: ['large'] },
      { frameworks: ['react'], languages: ['typescript'] },
    );
    expect(sim).toBe(0);
  });

  test('returns partial overlap score', () => {
    const sim = projectSimilarity(
      { frameworkMarkers: ['react', 'zod'], languageMarkers: ['typescript'], complexityRange: [] },
      { frameworks: ['react', 'express'], languages: ['typescript'] },
    );
    // shared: react, typescript (2 of 4 union)
    expect(sim).toBeCloseTo(0.5, 1);
  });

  test('returns 1.0 for both empty', () => {
    const sim = projectSimilarity(
      { frameworkMarkers: [], languageMarkers: [], complexityRange: [] },
      { frameworks: [], languages: [] },
    );
    expect(sim).toBe(1.0);
  });
});

describe('classifyPortability', () => {
  test('universal for language-only markers', () => {
    const ap = abstractPattern(makePattern(), 'proj')!;
    // .ts → typescript language marker, no explicit framework markers
    const cls = classifyPortability(ap);
    expect(cls).toBe('universal');
  });

  test('framework-specific when framework markers present', () => {
    const ap = abstractPattern(makePattern(), 'proj')!;
    // Add framework markers manually
    ap.applicabilityConditions.frameworkMarkers = ['react'];
    const cls = classifyPortability(ap);
    expect(cls).toBe('framework-specific');
  });

  test('project-specific when no markers at all', () => {
    const ap = abstractPattern(makePattern(), 'proj')!;
    ap.applicabilityConditions.frameworkMarkers = [];
    ap.applicabilityConditions.languageMarkers = [];
    const cls = classifyPortability(ap);
    expect(cls).toBe('project-specific');
  });
});

describe('migrateExport', () => {
  test('returns same object for current version', () => {
    const exported = exportPatterns([makePattern()], 'proj');
    const migrated = migrateExport(exported);
    expect(migrated).toBe(exported); // identity — no copy needed
  });

  test('throws for version newer than current', () => {
    const futureExport: AbstractPatternExport = {
      version: 999,
      projectId: 'proj',
      exportedAt: Date.now(),
      patterns: [],
    };
    expect(() => migrateExport(futureExport)).toThrow(/newer than supported/);
  });

  test('throws for version below minimum', () => {
    const ancientExport: AbstractPatternExport = {
      version: 0,
      projectId: 'proj',
      exportedAt: Date.now(),
      patterns: [],
    };
    expect(() => migrateExport(ancientExport)).toThrow(/too old to migrate/);
  });
});

describe('importPatterns with version migration', () => {
  test('importPatterns calls migrateExport transparently for current version', () => {
    const patterns = [makePattern()];
    const exported = exportPatterns(patterns, 'source');

    // Should work without error — migration is a no-op for current version
    const imported = importPatterns(exported, 'target', { frameworks: [], languages: ['typescript'] }, 0.5);
    expect(imported.length).toBeGreaterThanOrEqual(1);
  });

  test('importPatterns rejects future versions', () => {
    const futureExport: AbstractPatternExport = {
      version: 999,
      projectId: 'source',
      exportedAt: Date.now(),
      patterns: [],
    };
    expect(() => importPatterns(futureExport, 'target', { frameworks: [], languages: [] })).toThrow(
      /newer than supported/,
    );
  });
});

describe('importPatterns with similarity filtering', () => {
  test('filters out patterns below similarity threshold', () => {
    const patterns = [makePattern()]; // .ts → typescript
    const exported = exportPatterns(patterns, 'source');

    // Import into a Python project — low similarity
    const imported = importPatterns(exported, 'target', { frameworks: ['django'], languages: ['python'] }, 0.5);
    expect(imported).toHaveLength(0);
  });

  test('includes patterns above similarity threshold', () => {
    const patterns = [makePattern()]; // .ts → typescript
    const exported = exportPatterns(patterns, 'source');

    // Import into a TypeScript project — high similarity
    const imported = importPatterns(exported, 'target', { frameworks: [], languages: ['typescript'] }, 0.5);
    expect(imported.length).toBeGreaterThanOrEqual(1);
  });
});
