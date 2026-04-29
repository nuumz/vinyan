/**
 * Phase-14 (Item 2) — LLM-backed DraftGenerator adapter.
 *
 * Covers:
 *   - calls provider.generate with the documented system prompt + user prompt
 *   - parses returned content into a SkillMdRecord via parseSkillMd
 *   - tolerates a code-fenced response (```markdown ... ```)
 *   - throws on unparseable content (caller's outer catch records rejection)
 *   - propagates timeoutMs / maxTokens / temperature from options
 */
import { describe, expect, test } from 'bun:test';
import type { LLMProvider, LLMRequest, LLMResponse } from '../../../src/orchestrator/types.ts';
import { buildLLMDraftGenerator } from '../../../src/skills/autonomous/draft-generator-llm.ts';
import type { DraftRequest } from '../../../src/skills/autonomous/types.ts';

function makeProvider(content: string): { provider: LLMProvider; calls: LLMRequest[] } {
  const calls: LLMRequest[] = [];
  const provider: LLMProvider = {
    id: 'mock-balanced',
    tier: 'balanced',
    async generate(req: LLMRequest): Promise<LLMResponse> {
      calls.push(req);
      return {
        content,
        toolCalls: [],
        tokensUsed: { input: 100, output: 200 },
        model: 'mock-balanced',
        stopReason: 'end_turn',
      };
    },
  };
  return { provider, calls };
}

function makeRequest(): DraftRequest {
  return {
    taskSignature: 'code::refactor::extract-helper',
    representativeSamples: [
      { taskId: 't1', taskSignature: 'code::refactor::extract-helper', compositeError: 0.12, outcome: 'success', ts: 1, personaId: 'developer' },
      { taskId: 't2', taskSignature: 'code::refactor::extract-helper', compositeError: 0.10, outcome: 'success', ts: 2, personaId: 'developer' },
    ],
    workspaceHint: { files: ['src/foo.ts', 'src/bar.ts'] },
    expectedReduction: { baseline: 0.3, target: 0.15, window: 30 },
  };
}

const VALID_SKILL_MD = `---
id: autonomous/code-refactor-extract-helper
name: Extract Helper for Refactor
version: 1.0.0
description: Drafted skill for code refactor extract helper task family
confidence_tier: probabilistic
origin: autonomous
status: probation
tags:
  - code-refactor-extract-helper
provides_capabilities:
  - id: code.refactor.extract
requires_toolsets: []
expected_prediction_error_reduction:
  baseline_composite_error: 0.3
  target_composite_error: 0.15
  trial_window: 30
---

## Overview

Drafted skill for extracting helpers during refactoring.

## When to use

- code refactor extract helper task family
- Files matching src/foo.ts or similar

## Procedure

1. Identify the duplicated logic
2. Extract into a typed helper function
3. Replace call sites
`;

describe('buildLLMDraftGenerator', () => {
  test('parses a valid SKILL.md response into a SkillMdRecord', async () => {
    const { provider } = makeProvider(VALID_SKILL_MD);
    const gen = buildLLMDraftGenerator({ provider });
    const record = await gen(makeRequest());
    expect(record.frontmatter.id).toBe('autonomous/code-refactor-extract-helper');
    expect(record.frontmatter.confidence_tier).toBe('probabilistic');
    expect(record.frontmatter.status).toBe('probation');
    expect(record.frontmatter.origin).toBe('autonomous');
  });

  test('strips ```markdown fence around the response', async () => {
    const fenced = '```markdown\n' + VALID_SKILL_MD + '\n```';
    const { provider } = makeProvider(fenced);
    const gen = buildLLMDraftGenerator({ provider });
    const record = await gen(makeRequest());
    expect(record.frontmatter.id).toBe('autonomous/code-refactor-extract-helper');
  });

  test('strips bare ``` fence', async () => {
    const fenced = '```\n' + VALID_SKILL_MD + '\n```';
    const { provider } = makeProvider(fenced);
    const gen = buildLLMDraftGenerator({ provider });
    const record = await gen(makeRequest());
    expect(record.frontmatter.id).toBe('autonomous/code-refactor-extract-helper');
  });

  test('throws on garbage response (caller logs as drafted-rejected)', async () => {
    const { provider } = makeProvider('this is not a SKILL.md');
    const gen = buildLLMDraftGenerator({ provider });
    await expect(gen(makeRequest())).rejects.toThrow();
  });

  test('passes maxTokens / temperature / timeoutMs to the provider', async () => {
    const { provider, calls } = makeProvider(VALID_SKILL_MD);
    const gen = buildLLMDraftGenerator({
      provider,
      maxTokens: 1234,
      temperature: 0.2,
      timeoutMs: 30_000,
    });
    await gen(makeRequest());
    expect(calls).toHaveLength(1);
    expect(calls[0]!.maxTokens).toBe(1234);
    expect(calls[0]!.temperature).toBe(0.2);
    expect(calls[0]!.timeoutMs).toBe(30_000);
  });

  test('user prompt includes task signature, expected reduction, samples, hint files', async () => {
    const { provider, calls } = makeProvider(VALID_SKILL_MD);
    const gen = buildLLMDraftGenerator({ provider });
    await gen(makeRequest());
    const userPrompt = calls[0]!.userPrompt;
    expect(userPrompt).toContain('code::refactor::extract-helper');
    expect(userPrompt).toContain('baseline_composite_error: 0.3000');
    expect(userPrompt).toContain('target_composite_error:   0.1500');
    expect(userPrompt).toContain('trial_window:             30');
    expect(userPrompt).toContain('t1');
    expect(userPrompt).toContain('t2');
    expect(userPrompt).toContain('src/foo.ts');
  });

  test('system prompt anchors on SKILL.md drafter role', async () => {
    const { provider, calls } = makeProvider(VALID_SKILL_MD);
    const gen = buildLLMDraftGenerator({ provider });
    await gen(makeRequest());
    expect(calls[0]!.systemPrompt).toContain('SKILL.md drafter');
    expect(calls[0]!.systemPrompt).toContain("'probabilistic'");
    expect(calls[0]!.systemPrompt).toContain("'probation'");
  });
});
