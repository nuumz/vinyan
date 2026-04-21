/**
 * Progressive disclosure (L0/L1/L2) + token-budget tests.
 */
import { describe, expect, test } from 'bun:test';
import type { ConfidenceTier } from '../../src/core/confidence-tier.ts';
import { renderL0List, type SkillL0View, toL0, toL1 } from '../../src/skills/progressive-disclosure.ts';
import type { SkillMdRecord } from '../../src/skills/skill-md/index.ts';
import { parseSkillMd } from '../../src/skills/skill-md/index.ts';
import {
  estimateTokens,
  L0_BUDGET_TOKENS,
  L1_BUDGET_TOKENS,
  truncateToTokenBudget,
} from '../../src/skills/token-budget.ts';

function buildRecord(opts: {
  id: string;
  name?: string;
  tier?: ConfidenceTier;
  longProcedure?: boolean;
  files?: string[];
}): SkillMdRecord {
  const procedure = opts.longProcedure
    ? Array.from(
        { length: 4_000 },
        (_, i) => `${i + 1}. Step number ${i + 1} — perform operation with identifier ${i + 1}.`,
      ).join('\n')
    : '1. Do thing one.\n2. Do thing two.';
  const filesSection =
    opts.files && opts.files.length > 0 ? `\n\n## Files\n\n${opts.files.map((f) => `- ${f}`).join('\n')}` : '';
  const tier = opts.tier ?? 'heuristic';
  const contentHashLine = tier === 'deterministic' ? `content_hash: sha256:${'f'.repeat(64)}\n` : '';
  const text = `---
id: ${opts.id}
name: ${opts.name ?? 'Test Skill'}
version: 1.0.0
description: A skill for ${opts.id}
confidence_tier: ${tier}
${contentHashLine}requires_toolsets:
  - ast
fallback_for_toolsets: []
---

## Overview

Overview for ${opts.id}.

## When to use

When testing ${opts.id}.

## Procedure

${procedure}${filesSection}
`;
  return parseSkillMd(text);
}

describe('toL0', () => {
  test('preserves the listed fields and drops body', () => {
    const rec = buildRecord({ id: 'alpha', name: 'Alpha', tier: 'deterministic', files: ['a.ts'] });
    const l0 = toL0(rec);
    expect(l0.id).toBe('alpha');
    expect(l0.name).toBe('Alpha');
    expect(l0.version).toBe('1.0.0');
    expect(l0.confidenceTier).toBe('deterministic');
    expect(l0.requiresToolsets).toEqual(['ast']);
    expect(l0.fallbackForToolsets).toEqual([]);
    expect(l0.status).toBe('probation');
    // No body leak.
    expect((l0 as unknown as { body?: unknown }).body).toBeUndefined();
  });

  test('omits platforms when not specified', () => {
    const rec = buildRecord({ id: 'beta' });
    const l0 = toL0(rec);
    expect(l0.platforms).toBeUndefined();
  });
});

describe('toL1', () => {
  test('body sections are present and untruncated for small records', () => {
    const rec = buildRecord({ id: 'gamma' });
    const l1 = toL1(rec);
    expect(l1.l0.id).toBe('gamma');
    expect(l1.body.overview).toContain('Overview for gamma');
    expect(l1.body.whenToUse).toContain('testing gamma');
    expect(l1.body.procedure).toContain('Do thing one');
    expect(l1.truncated).toBe(false);
  });

  test('truncates procedure when over L1 budget', () => {
    const rec = buildRecord({ id: 'long', longProcedure: true });
    const l1 = toL1(rec);
    expect(l1.truncated).toBe(true);
    // Truncated body fits within the L1 budget (approximately).
    const totalTokens = estimateTokens(
      [l1.body.overview, l1.body.whenToUse, l1.body.preconditions ?? '', l1.body.procedure].join('\n\n'),
    );
    expect(totalTokens).toBeLessThanOrEqual(L1_BUDGET_TOKENS + 200);
  });

  test('surfaces file listing via fileListing', () => {
    const rec = buildRecord({ id: 'with-files', files: ['src/foo.ts', 'src/bar.ts'] });
    const l1 = toL1(rec);
    expect(l1.body.fileListing).toEqual(['src/foo.ts', 'src/bar.ts']);
  });
});

describe('renderL0List', () => {
  test('highest-tier first ordering', () => {
    const views: SkillL0View[] = [
      makeL0('spec-1', 'speculative'),
      makeL0('det-1', 'deterministic'),
      makeL0('heu-1', 'heuristic'),
      makeL0('prob-1', 'probabilistic'),
    ];
    const { text } = renderL0List(views);
    const idxDet = text.indexOf('det-1');
    const idxHeu = text.indexOf('heu-1');
    const idxProb = text.indexOf('prob-1');
    const idxSpec = text.indexOf('spec-1');
    expect(idxDet).toBeLessThan(idxHeu);
    expect(idxHeu).toBeLessThan(idxProb);
    expect(idxProb).toBeLessThan(idxSpec);
  });

  test('truncation count reflects dropped entries when over budget', () => {
    // Pack many views until packing truncates some.
    const many: SkillL0View[] = Array.from({ length: 400 }, (_, i) =>
      makeL0(`fill-${i}`, 'heuristic', 'x'.repeat(200)),
    );
    const { shown, truncated, text } = renderL0List(many);
    expect(shown + truncated).toBe(400);
    expect(truncated).toBeGreaterThan(0);
    expect(estimateTokens(text)).toBeLessThanOrEqual(L0_BUDGET_TOKENS);
  });

  test('empty list returns empty text and no truncation', () => {
    const { text, shown, truncated } = renderL0List([]);
    expect(text).toBe('');
    expect(shown).toBe(0);
    expect(truncated).toBe(0);
  });
});

describe('token estimator', () => {
  test('monotonic — longer input yields ≥ estimate', () => {
    const short = 'hello world';
    const long = 'hello world '.repeat(100);
    expect(estimateTokens(long)).toBeGreaterThan(estimateTokens(short));
  });

  test('empty string → 0 tokens', () => {
    expect(estimateTokens('')).toBe(0);
  });

  test('truncateToTokenBudget respects the cap', () => {
    const big = 'a '.repeat(20_000);
    const { text, truncated } = truncateToTokenBudget(big, 100);
    expect(truncated).toBe(true);
    expect(estimateTokens(text)).toBeLessThanOrEqual(120); // small slack for marker
  });

  test('truncateToTokenBudget passes through short input unchanged', () => {
    const { text, truncated } = truncateToTokenBudget('tiny', 1000);
    expect(truncated).toBe(false);
    expect(text).toBe('tiny');
  });
});

// ── helpers ──────────────────────────────────────────────────────────────

function makeL0(id: string, tier: ConfidenceTier, extraDescription = ''): SkillL0View {
  return {
    id,
    name: `Skill ${id}`,
    version: '1.0.0',
    description: `Description for ${id}${extraDescription ? ` — ${extraDescription}` : ''}`,
    confidenceTier: tier,
    origin: 'local',
    requiresToolsets: [],
    fallbackForToolsets: [],
    status: 'active',
  };
}
