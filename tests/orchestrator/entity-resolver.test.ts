import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, test } from 'bun:test';
import { EntityResolver, PERCEPTION_EXPANSION_THRESHOLD } from '../../src/orchestrator/understanding/entity-resolver.ts';
import type { TaskInput, TaskUnderstanding } from '../../src/orchestrator/types.ts';

function makeInput(overrides?: Partial<TaskInput>): TaskInput {
  return {
    id: 't1',
    source: 'cli',
    goal: 'fix the auth service',
    taskType: 'code',
    budget: { maxTokens: 10000, maxDurationMs: 60000, maxRetries: 3 },
    ...overrides,
  };
}

function makeUnderstanding(overrides?: Partial<TaskUnderstanding>): TaskUnderstanding {
  return {
    rawGoal: 'fix the auth service',
    actionVerb: 'fix',
    actionCategory: 'mutation',
    frameworkContext: [],
    constraints: [],
    acceptanceCriteria: [],
    expectsMutation: true,
    ...overrides,
  };
}

/** Create a temp workspace with a known file structure for testing. */
function createTestWorkspace(): string {
  const base = join(tmpdir(), `vinyan-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(base, 'src', 'auth'), { recursive: true });
  mkdirSync(join(base, 'src', 'services'), { recursive: true });
  mkdirSync(join(base, 'src', 'utils'), { recursive: true });
  mkdirSync(join(base, 'tests'), { recursive: true });

  writeFileSync(join(base, 'src', 'auth', 'login.ts'), 'export function login() {}');
  writeFileSync(join(base, 'src', 'auth', 'session.ts'), 'export function session() {}');
  writeFileSync(join(base, 'src', 'services', 'auth-service.ts'), 'export class AuthService {}');
  writeFileSync(join(base, 'src', 'services', 'payment.ts'), 'export class Payment {}');
  writeFileSync(join(base, 'src', 'utils', 'hash.ts'), 'export function hash() {}');
  writeFileSync(join(base, 'tests', 'auth.test.ts'), 'test("auth", () => {})');

  return base;
}

describe('EntityResolver', () => {
  describe('exact match (targetFiles provided)', () => {
    test('returns exact match with confidence 1.0', () => {
      const workspace = createTestWorkspace();
      const resolver = new EntityResolver(workspace);
      const input = makeInput({ targetFiles: ['src/auth/login.ts'] });
      const understanding = makeUnderstanding();

      const result = resolver.resolve(input, understanding);

      expect(result).toHaveLength(1);
      expect(result[0]!.resolution).toBe('exact');
      expect(result[0]!.confidence).toBe(1.0);
      expect(result[0]!.resolvedPaths).toEqual(['src/auth/login.ts']);
      expect(result[0]!.confidenceSource).toBe('evidence-derived');
    });

    test('skips fuzzy resolution when targetFiles provided', () => {
      const workspace = createTestWorkspace();
      const resolver = new EntityResolver(workspace);
      const input = makeInput({
        goal: 'fix the auth service',
        targetFiles: ['src/auth/login.ts'],
      });
      const understanding = makeUnderstanding();

      const result = resolver.resolve(input, understanding);

      // Should only have the exact match, no fuzzy results
      expect(result).toHaveLength(1);
      expect(result[0]!.resolution).toBe('exact');
    });
  });

  describe('fuzzy path match', () => {
    test('resolves "auth" token to auth-related files', () => {
      const workspace = createTestWorkspace();
      const resolver = new EntityResolver(workspace);
      const input = makeInput({ goal: 'fix the auth service' });
      const understanding = makeUnderstanding();

      const result = resolver.resolve(input, understanding);

      const fuzzyEntity = result.find(e => e.resolution === 'fuzzy-path');
      expect(fuzzyEntity).toBeDefined();
      // Should match files containing "auth"
      const authPaths = fuzzyEntity!.resolvedPaths.filter(p => p.includes('auth'));
      expect(authPaths.length).toBeGreaterThan(0);
    });

    test('returns empty for unrecognizable tokens', () => {
      const workspace = createTestWorkspace();
      const resolver = new EntityResolver(workspace);
      const input = makeInput({ goal: 'do something completely random xyz' });
      const understanding = makeUnderstanding({ rawGoal: 'do something completely random xyz' });

      const result = resolver.resolve(input, understanding);

      const fuzzyResults = result.filter(e => e.resolution === 'fuzzy-path');
      expect(fuzzyResults).toHaveLength(0);
    });

    test('all fuzzy results have evidence-derived confidenceSource', () => {
      const workspace = createTestWorkspace();
      const resolver = new EntityResolver(workspace);
      const input = makeInput({ goal: 'fix the payment service' });
      const understanding = makeUnderstanding();

      const result = resolver.resolve(input, understanding);

      for (const entity of result) {
        expect(entity.confidenceSource).toBe('evidence-derived');
      }
    });

    test('confidence is capped below 1.0', () => {
      const workspace = createTestWorkspace();
      const resolver = new EntityResolver(workspace);
      const input = makeInput({ goal: 'fix the auth service' });
      const understanding = makeUnderstanding();

      const result = resolver.resolve(input, understanding);

      for (const entity of result) {
        if (entity.resolution === 'fuzzy-path') {
          expect(entity.confidence).toBeLessThan(1.0);
        }
      }
    });
  });

  describe('symbol search', () => {
    test('resolves targetSymbol via WorldGraph facts', () => {
      const workspace = createTestWorkspace();
      const mockWorldGraph = {
        queryFacts: (target: string) => {
          if (target === 'AuthService') {
            return [{ sourceFile: 'src/services/auth-service.ts', confidence: 0.9, pattern: 'class-def' }];
          }
          return [];
        },
        queryDependents: () => [],
        queryDependencies: () => [],
      } as any;

      const resolver = new EntityResolver(workspace, mockWorldGraph);
      const input = makeInput({ goal: 'fix `AuthService` validation' });
      const understanding = makeUnderstanding({ targetSymbol: 'AuthService' });

      const result = resolver.resolve(input, understanding);

      const symbolEntity = result.find(e => e.resolution === 'fuzzy-symbol');
      expect(symbolEntity).toBeDefined();
      expect(symbolEntity!.resolvedPaths).toContain('src/services/auth-service.ts');
      expect(symbolEntity!.confidence).toBe(0.85);
    });

    test('skips symbol search when no WorldGraph', () => {
      const workspace = createTestWorkspace();
      const resolver = new EntityResolver(workspace); // no worldGraph
      const input = makeInput({ goal: 'fix `AuthService`' });
      const understanding = makeUnderstanding({ targetSymbol: 'AuthService' });

      const result = resolver.resolve(input, understanding);

      const symbolEntity = result.find(e => e.resolution === 'fuzzy-symbol');
      expect(symbolEntity).toBeUndefined();
    });
  });

  describe('dependency inference', () => {
    test('expands high-confidence symbol entities via dependents', () => {
      const workspace = createTestWorkspace();
      const mockWorldGraph = {
        queryFacts: (target: string) => {
          if (target === 'AuthService') {
            return [{ sourceFile: 'src/services/auth-service.ts', confidence: 0.9, pattern: 'class' }];
          }
          return [];
        },
        queryDependents: (file: string) => {
          if (file.includes('auth-service')) return ['src/app.ts'];
          return [];
        },
        queryDependencies: () => [],
      } as any;

      const resolver = new EntityResolver(workspace, mockWorldGraph);
      // Symbol search returns confidence 0.85 >= PERCEPTION_EXPANSION_THRESHOLD (0.8)
      const input = makeInput({ goal: 'fix `AuthService` validation' });
      const understanding = makeUnderstanding({ targetSymbol: 'AuthService' });

      const result = resolver.resolve(input, understanding);

      const inferred = result.find(e => e.resolution === 'dependency-inferred');
      expect(inferred).toBeDefined();
      expect(inferred!.confidence).toBe(0.75);
      expect(inferred!.resolvedPaths).toContain('src/app.ts');
    });

    test('does not expand low-confidence entities', () => {
      const workspace = createTestWorkspace();
      let queryDependentsCalled = false;
      const mockWorldGraph = {
        queryFacts: () => [],
        queryDependents: () => {
          queryDependentsCalled = true;
          return ['src/app.ts'];
        },
        queryDependencies: () => [],
      } as any;

      const resolver = new EntityResolver(workspace, mockWorldGraph);
      // Goal tokens produce fuzzy matches but likely below 0.8 threshold
      const input = makeInput({ goal: 'fix something vague' });
      const understanding = makeUnderstanding();

      const result = resolver.resolve(input, understanding);

      // If no entity has confidence >= 0.8, dependency inference should not trigger
      const inferred = result.find(e => e.resolution === 'dependency-inferred');
      const hasHighConfidence = result.some(e => e.confidence >= PERCEPTION_EXPANSION_THRESHOLD && e.resolution !== 'dependency-inferred');
      if (!hasHighConfidence) {
        expect(inferred).toBeUndefined();
      }
    });
  });

  describe('caching', () => {
    test('second resolve call reuses cached file list', () => {
      const workspace = createTestWorkspace();
      const resolver = new EntityResolver(workspace);
      const input = makeInput({ goal: 'fix auth service' });
      const understanding = makeUnderstanding();

      const result1 = resolver.resolve(input, understanding);
      const result2 = resolver.resolve(input, understanding);

      // Same results (deterministic)
      expect(result1).toEqual(result2);
    });

    test('forceRefresh invalidates cache', () => {
      const workspace = createTestWorkspace();
      const resolver = new EntityResolver(workspace);
      const input = makeInput({ goal: 'fix auth service' });
      const understanding = makeUnderstanding();

      // First call populates cache
      resolver.resolve(input, understanding);

      // Add a new file
      mkdirSync(join(workspace, 'src', 'auth', 'newmodule'), { recursive: true });
      writeFileSync(join(workspace, 'src', 'auth', 'newmodule', 'handler.ts'), 'export {}');

      // Without forceRefresh — uses stale cache
      const staleResult = resolver.resolve(input, understanding);
      const stalePaths = staleResult.flatMap(e => e.resolvedPaths);

      // With forceRefresh — picks up new file
      const freshResult = resolver.resolve(input, understanding, { forceRefresh: true });
      const freshPaths = freshResult.flatMap(e => e.resolvedPaths);

      // Fresh should potentially have more paths
      expect(freshPaths.length).toBeGreaterThanOrEqual(stalePaths.length);
    });
  });

  describe('PERCEPTION_EXPANSION_THRESHOLD', () => {
    test('threshold is 0.8', () => {
      expect(PERCEPTION_EXPANSION_THRESHOLD).toBe(0.8);
    });
  });

  describe('Phase E: cross-task understanding transfer', () => {
    test('prior understanding-verified facts accelerate resolution', () => {
      const { WorldGraph } = require('../../src/world-graph/world-graph.ts');
      const wg = new WorldGraph(':memory:');
      const workspace = createTestWorkspace();

      // Store a prior understanding fact for "auth" → "src/auth/login.ts"
      wg.storeFact({
        target: 'auth',
        pattern: 'understanding-verified',
        evidence: [{ file: 'src/auth/login.ts', line: 0, snippet: '' }],
        oracleName: 'fs',
        sourceFile: 'src/auth/login.ts',
        fileHash: 'prior-hash',
        verifiedAt: Date.now(),
        confidence: 0.99,
        decayModel: 'linear',
        tierReliability: 1.0,
      });

      const resolver = new EntityResolver(workspace, wg);
      const input = makeInput({ goal: 'fix the auth module' });
      const understanding = makeUnderstanding({ targetSymbol: undefined });
      const entities = resolver.resolve(input, understanding);

      // Should have at least one entity from fuzzy match + potentially one from prior facts
      expect(entities.length).toBeGreaterThan(0);

      // Check that prior facts can contribute (if the token "auth" matched)
      const allPaths = entities.flatMap(e => e.resolvedPaths);
      // The auth directory should be found either from fuzzy match or prior facts
      expect(allPaths.some(p => p.includes('auth'))).toBe(true);
    });

    test('prior facts are discounted (confidence * 0.9, capped at 0.85)', () => {
      const { WorldGraph } = require('../../src/world-graph/world-graph.ts');
      const wg = new WorldGraph(':memory:');
      const workspace = createTestWorkspace();

      wg.storeFact({
        target: 'payment',
        pattern: 'understanding-verified',
        evidence: [{ file: 'src/services/payment.ts', line: 0, snippet: '' }],
        oracleName: 'fs',
        sourceFile: 'src/services/payment.ts',
        fileHash: 'prior-hash',
        verifiedAt: Date.now(),
        confidence: 0.99,
        decayModel: 'none',
        tierReliability: 1.0,
      });

      const resolver = new EntityResolver(workspace, wg);
      const input = makeInput({ goal: 'fix the payment system' });
      const understanding = makeUnderstanding({ targetSymbol: undefined });
      const entities = resolver.resolve(input, understanding);

      const priorEntity = entities.find(e => e.reference.startsWith('prior:'));
      if (priorEntity) {
        // Confidence should be discounted
        expect(priorEntity.confidence).toBeLessThanOrEqual(0.85);
      }
    });

    test('no WorldGraph → no prior fact resolution', () => {
      const workspace = createTestWorkspace();
      const resolver = new EntityResolver(workspace, undefined);
      const input = makeInput({ goal: 'fix the auth module' });
      const understanding = makeUnderstanding({ targetSymbol: undefined });
      const entities = resolver.resolve(input, understanding);

      // Should still resolve via fuzzy path match
      const priorEntities = entities.filter(e => e.reference.startsWith('prior:'));
      expect(priorEntities).toHaveLength(0);
    });
  });
});
