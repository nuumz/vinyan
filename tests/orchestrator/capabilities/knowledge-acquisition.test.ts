/**
 * knowledge-acquisition tests — local-first capability research (Phase C1).
 *
 * Verifies:
 *   - planFromGapForResearch returns null when not in research mode
 *   - planFromGapForResearch only emits queries for unmet capabilities
 *   - acquireKnowledge degrades gracefully when no providers configured
 *   - WorldGraph fact lookups produce KnowledgeContext entries
 *   - Workspace docs grep finds matches and clamps confidence to heuristic
 *   - Results are sorted by confidence (deterministic governance)
 *   - buildResearchContextConstraint round-trips through JSON.parse
 *   - Empty acquisition → null constraint (no empty section in prompt)
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Fact } from '../../../src/core/types.ts';
import {
  acquireKnowledge,
  buildResearchContextConstraint,
  createWorkspaceDocsKnowledgeProvider,
  createWorldGraphKnowledgeProvider,
  type KnowledgeProvider,
  planFromGapForResearch,
} from '../../../src/orchestrator/capabilities/knowledge-acquisition.ts';
import type {
  CapabilityFit,
  CapabilityGapAnalysis,
  CapabilityRequirement,
} from '../../../src/orchestrator/types.ts';

function req(id: string, weight = 1, extras?: Partial<CapabilityRequirement>): CapabilityRequirement {
  return { id, weight, source: 'llm-extract', ...extras };
}

function fit(agentId: string, fitScore: number, matchedIds: string[] = []): CapabilityFit {
  return {
    agentId,
    fitScore,
    matched: matchedIds.map((id) => ({ id, weight: 1, confidence: 0.9 })),
    gap: [],
  };
}

function makeAnalysis(overrides?: Partial<CapabilityGapAnalysis>): CapabilityGapAnalysis {
  return {
    taskId: 't-1',
    required: [req('research.web'), req('writing.summary')],
    candidates: [fit('best', 0.5, ['writing.summary'])],
    gapNormalized: 0.5,
    recommendedAction: 'research',
    ...overrides,
  };
}

function fakeFact(id: string, target: string, pattern: string, confidence = 0.7): Fact {
  return {
    id,
    target,
    pattern,
    evidence: [],
    oracleName: 'test-oracle',
    fileHash: 'h',
    sourceFile: '/x',
    verifiedAt: Date.now(),
    confidence,
  };
}

describe('planFromGapForResearch', () => {
  test('returns null when recommendedAction is not research', () => {
    expect(planFromGapForResearch('t-1', makeAnalysis({ recommendedAction: 'proceed' }))).toBeNull();
    expect(planFromGapForResearch('t-1', makeAnalysis({ recommendedAction: 'synthesize' }))).toBeNull();
    expect(planFromGapForResearch('t-1', makeAnalysis({ recommendedAction: 'fallback' }))).toBeNull();
  });

  test('returns null when there are no required capabilities', () => {
    expect(
      planFromGapForResearch(
        't-1',
        makeAnalysis({ required: [], candidates: [fit('best', 0)] }),
      ),
    ).toBeNull();
  });

  test('returns null when every requirement is matched by best candidate', () => {
    const a = makeAnalysis({
      required: [req('a'), req('b')],
      candidates: [fit('best', 1, ['a', 'b'])],
    });
    expect(planFromGapForResearch('t-1', a)).toBeNull();
  });

  test('emits queries only for unmet capabilities', () => {
    const a = makeAnalysis({
      required: [req('research.web'), req('writing.summary')],
      candidates: [fit('best', 0.5, ['writing.summary'])],
    });
    const plan = planFromGapForResearch('t-1', a)!;
    expect(plan).not.toBeNull();
    expect(plan.capabilities).toEqual(['research.web']);
    expect(plan.queries).toContain('research.web');
    expect(plan.queries).not.toContain('writing.summary');
  });

  test('action verbs and framework markers feed the query set', () => {
    const a = makeAnalysis({
      required: [
        req('research.web', 1, { actionVerbs: ['investigate', 'crawl'], frameworkMarkers: ['react'] }),
      ],
      candidates: [fit('best', 0)],
    });
    const plan = planFromGapForResearch('t-1', a)!;
    expect(plan.queries.sort()).toEqual(['crawl', 'investigate', 'react', 'research.web']);
  });

  test('accepts provider order from the orchestrator dependency surface', () => {
    const plan = planFromGapForResearch('t-1', makeAnalysis(), { providers: ['peer', 'web'] })!;

    expect(plan.providers).toEqual(['peer', 'web']);
  });
});

describe('acquireKnowledge', () => {
  test('returns empty when no providers configured', async () => {
    const ctxs = await acquireKnowledge(
      { taskId: 't-1', capabilities: ['research.web'], queries: ['research.web'] },
      {},
    );
    expect(ctxs).toEqual([]);
  });

  test('returns empty when query list is empty', async () => {
    const ctxs = await acquireKnowledge(
      { taskId: 't-1', capabilities: [], queries: [] },
      { worldGraph: { queryFacts: () => [fakeFact('f1', 'x', 'p')] } as never },
    );
    expect(ctxs).toEqual([]);
  });

  test('world-graph hits become KnowledgeContext with capped confidence', async () => {
    const wg = {
      queryFacts: (target: string) =>
        target === 'research.web' ? [fakeFact('f1', 'research.web', 'oracle says X', 0.95)] : [],
    } as never;
    const ctxs = await acquireKnowledge(
      { taskId: 't-1', capabilities: ['research.web'], queries: ['research.web'] },
      { worldGraph: wg },
    );
    expect(ctxs).toHaveLength(1);
    const c0 = ctxs[0]!;
    expect(c0.source).toBe('world-graph');
    expect(c0.capability).toBe('research.web');
    expect(c0.reference).toBe('f1');
    // Capped to 0.9 because evidence ≠ verdict (A1).
    expect(c0.confidence).toBeLessThanOrEqual(0.9);
    expect(c0.content).toContain('oracle says X');
  });

  test('workspace docs grep produces heuristic-tier entries', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vinyan-doc-'));
    try {
      writeFileSync(
        join(dir, 'README.md'),
        '# Project\nSome notes about research.web tactics — fetch + summarize.',
      );
      mkdirSync(join(dir, 'docs'));
      writeFileSync(join(dir, 'docs', 'guide.md'), 'Unrelated text.');
      const ctxs = await acquireKnowledge(
        { taskId: 't-1', capabilities: ['research.web'], queries: ['research.web'] },
        { workspace: dir },
      );
      expect(ctxs.length).toBeGreaterThan(0);
      const doc = ctxs.find((c) => c.source === 'workspace-docs');
      expect(doc).toBeDefined();
      expect(doc!.confidence).toBe(0.4);
      expect(doc!.reference).toBe('README.md');
      expect(doc!.content.toLowerCase()).toContain('research.web');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('skips files in node_modules and other excluded dirs', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vinyan-doc-'));
    try {
      mkdirSync(join(dir, 'node_modules', 'pkg'), { recursive: true });
      writeFileSync(join(dir, 'node_modules', 'pkg', 'README.md'), 'hit research.web here');
      const ctxs = await acquireKnowledge(
        { taskId: 't-1', capabilities: ['research.web'], queries: ['research.web'] },
        { workspace: dir },
      );
      expect(ctxs.find((c) => c.source === 'workspace-docs')).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('results sort by confidence desc; world-graph beats docs on ties broken by source rank', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vinyan-doc-'));
    try {
      writeFileSync(join(dir, 'README.md'), 'mention of x.cap inside the readme');
      const wg = {
        queryFacts: (t: string) => (t === 'x.cap' ? [fakeFact('f1', 'x.cap', 'fact body', 0.8)] : []),
      } as never;
      const ctxs = await acquireKnowledge(
        { taskId: 't-1', capabilities: ['x.cap'], queries: ['x.cap'] },
        { worldGraph: wg, workspace: dir },
      );
      expect(ctxs.length).toBeGreaterThanOrEqual(2);
      const top = ctxs[0]!;
      const second = ctxs[1]!;
      // Highest confidence first.
      expect(top.source).toBe('world-graph');
      expect(top.confidence).toBeGreaterThan(second.confidence);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('honors maxTotal cap', async () => {
    const wg = {
      queryFacts: (_t: string) =>
        Array.from({ length: 20 }, (_, i) => fakeFact(`f${i}`, 'q', `pattern ${i}`, 0.5)),
    } as never;
    const ctxs = await acquireKnowledge(
      { taskId: 't-1', capabilities: ['q'], queries: ['q'] },
      { worldGraph: wg, maxTotal: 4, maxPerSource: 100 },
    );
    expect(ctxs.length).toBeLessThanOrEqual(4);
  });

  test('source failure does not poison other sources', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vinyan-doc-'));
    try {
      writeFileSync(join(dir, 'README.md'), 'project mentions cap.q here');
      const wg = {
        queryFacts: () => {
          throw new Error('database is on fire');
        },
      } as never;
      const ctxs = await acquireKnowledge(
        { taskId: 't-1', capabilities: ['cap.q'], queries: ['cap.q'] },
        { worldGraph: wg, workspace: dir },
      );
      expect(ctxs.find((c) => c.source === 'workspace-docs')).toBeDefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('custom providers only run when requested by provider id', async () => {
    const webProvider: KnowledgeProvider = {
      id: 'web',
      collect(req, ctx) {
        return [
          {
            source: 'web',
            capability: req.capabilities[0],
            query: req.queries[0]!,
            content: 'adapter-normalized web evidence',
            reference: 'https://example.test/evidence',
            confidence: 0.35,
            retrievedAt: ctx.now(),
          },
        ];
      },
    };

    const skipped = await acquireKnowledge(
      { taskId: 't-1', capabilities: ['cap.web'], queries: ['cap.web'], providers: ['docs'] },
      { knowledgeProviders: [webProvider] },
    );
    expect(skipped).toEqual([]);

    const ctxs = await acquireKnowledge(
      { taskId: 't-1', capabilities: ['cap.web'], queries: ['cap.web'], providers: ['web'] },
      { knowledgeProviders: [webProvider] },
    );
    expect(ctxs).toHaveLength(1);
    expect(ctxs[0]!.source).toBe('web');
    expect(ctxs[0]!.confidence).toBe(0.35);
  });

  test('custom provider failure is isolated from later requested providers', async () => {
    const failingProvider: KnowledgeProvider = {
      id: 'web',
      collect() {
        throw new Error('remote provider failed');
      },
    };
    const peerProvider: KnowledgeProvider = {
      id: 'peer',
      collect(req, ctx) {
        return [
          {
            source: 'peer',
            capability: req.capabilities[0],
            query: req.queries[0]!,
            content: 'peer evidence with ECP semantics already adapted',
            reference: 'peer:local-lab',
            confidence: 0.55,
            retrievedAt: ctx.now(),
          },
        ];
      },
    };

    const ctxs = await acquireKnowledge(
      { taskId: 't-1', capabilities: ['cap.peer'], queries: ['cap.peer'], providers: ['web', 'peer'] },
      { knowledgeProviders: [failingProvider, peerProvider] },
    );

    expect(ctxs).toHaveLength(1);
    expect(ctxs[0]!.source).toBe('peer');
    expect(ctxs[0]!.content).toContain('ECP');
  });

  test('exported local provider factories preserve world-graph and docs behavior', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vinyan-doc-'));
    try {
      writeFileSync(join(dir, 'README.md'), 'provider.factory appears in local docs');
      const wg = {
        queryFacts: (target: string) =>
          target === 'provider.factory' ? [fakeFact('f-provider', 'provider.factory', 'factory fact', 0.7)] : [],
      } as never;

      const ctxs = await acquireKnowledge(
        { taskId: 't-1', capabilities: ['provider.factory'], queries: ['provider.factory'] },
        {
          knowledgeProviders: [createWorldGraphKnowledgeProvider(wg), createWorkspaceDocsKnowledgeProvider(dir)],
        },
      );

      expect(ctxs.map((ctx) => ctx.source)).toEqual(['world-graph', 'workspace-docs']);
      expect(ctxs[0]!.reference).toBe('f-provider');
      expect(ctxs[1]!.reference).toBe('README.md');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('buildResearchContextConstraint', () => {
  test('returns null when no contexts', () => {
    expect(buildResearchContextConstraint([])).toBeNull();
  });

  test('produces a RESEARCH_CONTEXT-prefixed JSON line that round-trips', () => {
    const line = buildResearchContextConstraint([
      {
        source: 'world-graph',
        capability: 'research.web',
        query: 'research.web',
        content: 'fact body',
        reference: 'f1',
        confidence: 0.7,
        retrievedAt: 0,
      },
    ])!;
    expect(line.startsWith('RESEARCH_CONTEXT:')).toBe(true);
    const payload = JSON.parse(line.slice('RESEARCH_CONTEXT:'.length));
    expect(payload.entries).toHaveLength(1);
    expect(payload.entries[0].source).toBe('world-graph');
    expect(payload.entries[0].capability).toBe('research.web');
    expect(payload.entries[0].confidence).toBe(0.7);
    // retrievedAt should NOT be in the wire payload — it's internal.
    expect(payload.entries[0].retrievedAt).toBeUndefined();
  });
});
