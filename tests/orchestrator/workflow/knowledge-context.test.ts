import { describe, expect, test } from 'bun:test';
import { buildKnowledgeContext } from '../../../src/orchestrator/workflow/knowledge-context.ts';

describe('buildKnowledgeContext', () => {
  test('no deps → empty string', async () => {
    const ctx = await buildKnowledgeContext({});
    expect(ctx).toBe('');
  });

  test('worldGraph with facts → [VERIFIED FACTS] section', async () => {
    const worldGraph = {
      queryFacts: (target: string) => [
        { target, pattern: 'exports AuthService', confidence: 0.9 },
        { target, pattern: 'uses bcrypt', confidence: 0.85 },
      ],
    } as any;

    const ctx = await buildKnowledgeContext(
      { worldGraph },
      { targetFiles: ['src/auth.ts'] },
    );
    expect(ctx).toContain('[VERIFIED FACTS]');
    expect(ctx).toContain('AuthService');
    expect(ctx).toContain('0.90');
  });

  test('agentMemory with skills → [PROVEN APPROACHES] section', async () => {
    const agentMemory = {
      queryRelatedSkills: async () => [
        { approach: 'test-first refactor', successRate: 0.85, usageCount: 12, taskSignature: 'fix::ts::small' },
      ],
      queryFailedApproaches: async () => [],
    } as any;

    const ctx = await buildKnowledgeContext(
      { agentMemory },
      { taskSignature: 'fix::ts::small' },
    );
    expect(ctx).toContain('[PROVEN APPROACHES]');
    expect(ctx).toContain('test-first refactor');
    expect(ctx).toContain('85%');
  });

  test('agentMemory with rejected approaches → [APPROACHES TO AVOID] section', async () => {
    const agentMemory = {
      queryRelatedSkills: async () => [],
      queryFailedApproaches: async () => [
        { approach: 'inline everything', oracle_verdict: 'type error TS2322' },
      ],
    } as any;

    const ctx = await buildKnowledgeContext(
      { agentMemory },
      { taskSignature: 'fix::ts::small' },
    );
    expect(ctx).toContain('[APPROACHES TO AVOID]');
    expect(ctx).toContain('inline everything');
    expect(ctx).toContain('TS2322');
  });

  test('store errors → graceful empty sections', async () => {
    const worldGraph = { queryFacts: () => { throw new Error('db down'); } } as any;
    const agentMemory = {
      queryRelatedSkills: async () => { throw new Error('cache miss'); },
      queryFailedApproaches: async () => { throw new Error('timeout'); },
    } as any;

    const ctx = await buildKnowledgeContext(
      { worldGraph, agentMemory },
      { targetFiles: ['src/foo.ts'], taskSignature: 'fix::ts' },
    );
    expect(ctx).toBe('');
  });

  test('maxFactsPerFile limits output', async () => {
    const worldGraph = {
      queryFacts: () => Array.from({ length: 20 }, (_, i) => ({
        target: 'src/big.ts',
        pattern: `fact-${i}`,
        confidence: 0.8,
      })),
    } as any;

    const ctx = await buildKnowledgeContext(
      { worldGraph },
      { targetFiles: ['src/big.ts'], maxFactsPerFile: 3 },
    );
    const factCount = (ctx.match(/fact-/g) ?? []).length;
    expect(factCount).toBe(3);
  });
});
