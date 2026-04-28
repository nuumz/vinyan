/**
 * Skill tools tests — skills_list / skill_view / skill_view_file.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerSkillTools } from '../../../src/orchestrator/tools/register-skill-tools.ts';
import {
  createSkillsListTool,
  createSkillViewFileTool,
  createSkillViewTool,
} from '../../../src/orchestrator/tools/skill-tools.ts';
import type { Tool, ToolContext } from '../../../src/orchestrator/tools/tool-interface.ts';
import { SkillArtifactStore } from '../../../src/skills/artifact-store.ts';
import type { SkillMdRecord } from '../../../src/skills/skill-md/index.ts';
import { parseSkillMd } from '../../../src/skills/skill-md/index.ts';
import { estimateTokens, L0_BUDGET_TOKENS } from '../../../src/skills/token-budget.ts';

let rootDir: string;
let store: SkillArtifactStore;

beforeEach(() => {
  rootDir = mkdtempSync(join(tmpdir(), 'skill-tools-'));
  store = new SkillArtifactStore({ rootDir });
});

afterEach(() => {
  rmSync(rootDir, { recursive: true, force: true });
});

function makeContext(): ToolContext {
  return { routingLevel: 1, allowedPaths: [], workspace: rootDir };
}

function makeRecord(opts: {
  id: string;
  tier?: 'deterministic' | 'heuristic' | 'probabilistic' | 'speculative';
  status?: 'probation' | 'active' | 'demoted' | 'quarantined' | 'retired';
  files?: string[];
}): SkillMdRecord {
  const filesSection =
    opts.files && opts.files.length > 0 ? `\n\n## Files\n\n${opts.files.map((f) => `- ${f}`).join('\n')}` : '';
  const contentHashLine =
    (opts.tier ?? 'heuristic') === 'deterministic' ? `content_hash: sha256:${'a'.repeat(64)}\n` : '';
  const statusLine = opts.status ? `status: ${opts.status}\n` : '';
  return parseSkillMd(`---
id: ${opts.id}
name: Skill ${opts.id}
version: 1.0.0
description: description for ${opts.id}
confidence_tier: ${opts.tier ?? 'heuristic'}
${contentHashLine}${statusLine}---

## Overview

Overview for ${opts.id}.

## When to use

When testing ${opts.id}.

## Procedure

1. Run.${filesSection}
`);
}

describe('skills_list', () => {
  test('returns rendered text within budget', async () => {
    for (let i = 0; i < 20; i++) {
      await store.write(makeRecord({ id: `refactor/skill-${i}` }));
    }
    const tool = createSkillsListTool({ artifactStore: store });
    const res = await tool.execute({ callId: 'c1' }, makeContext());
    expect(res.status).toBe('success');
    const out = res.output as { skills: unknown[]; renderedText: string; truncated: number };
    expect(out.skills.length).toBeGreaterThan(0);
    expect(estimateTokens(out.renderedText)).toBeLessThanOrEqual(L0_BUDGET_TOKENS);
  });

  test('respects tier filter', async () => {
    await store.write(makeRecord({ id: 'a/det', tier: 'deterministic' }));
    await store.write(makeRecord({ id: 'a/heu', tier: 'heuristic' }));
    await store.write(makeRecord({ id: 'a/spec', tier: 'speculative' }));
    const tool = createSkillsListTool({ artifactStore: store });

    const res = await tool.execute({ callId: 'c1', tier: 'heuristic' }, makeContext());
    const out = res.output as { skills: Array<{ id: string; confidenceTier: string }> };
    expect(out.skills.every((s) => s.confidenceTier === 'heuristic')).toBe(true);
    expect(out.skills.some((s) => s.id === 'a/heu')).toBe(true);
    expect(out.skills.some((s) => s.id === 'a/det')).toBe(false);
  });

  test('respects limit', async () => {
    for (let i = 0; i < 10; i++) {
      await store.write(makeRecord({ id: `refactor/s-${i}` }));
    }
    const tool = createSkillsListTool({ artifactStore: store });
    const res = await tool.execute({ callId: 'c1', limit: 3 }, makeContext());
    const out = res.output as { skills: unknown[] };
    expect(out.skills.length).toBeLessThanOrEqual(3);
  });
});

describe('skill_view', () => {
  test('returns an L1 view', async () => {
    await store.write(makeRecord({ id: 'refactor/view-me' }));
    const tool = createSkillViewTool({ artifactStore: store });
    const res = await tool.execute({ callId: 'c1', id: 'refactor/view-me' }, makeContext());
    expect(res.status).toBe('success');
    const out = res.output as { l0: { id: string }; body: { overview: string } };
    expect(out.l0.id).toBe('refactor/view-me');
    expect(out.body.overview).toContain('Overview for refactor/view-me');
  });

  test('unknown id returns an error status', async () => {
    const tool = createSkillViewTool({ artifactStore: store });
    const res = await tool.execute({ callId: 'c1', id: 'does/not-exist' }, makeContext());
    expect(res.status).toBe('error');
    expect(res.error).toContain('not found');
  });

  test('quarantined skill is denied — rule-based, no LLM', async () => {
    await store.write(makeRecord({ id: 'a/quar', status: 'quarantined' }));
    const tool = createSkillViewTool({ artifactStore: store });
    const res = await tool.execute({ callId: 'c1', id: 'a/quar' }, makeContext());
    expect(res.status).toBe('denied');
    expect(res.error).toMatch(/quarantined/);
  });

  test('retired skill is also denied', async () => {
    await store.write(makeRecord({ id: 'a/ret', status: 'retired' }));
    const tool = createSkillViewTool({ artifactStore: store });
    const res = await tool.execute({ callId: 'c1', id: 'a/ret' }, makeContext());
    expect(res.status).toBe('denied');
  });

  test('Phase-11: emits skill:viewed when bus + taskId present', async () => {
    const { createBus } = await import('../../../src/core/bus.ts');
    const bus = createBus();
    const events: Array<{ taskId: string; skillId: string }> = [];
    bus.on('skill:viewed', (ev) => events.push(ev));

    await store.write(makeRecord({ id: 'refactor/observed' }));
    const tool = createSkillViewTool({ artifactStore: store, bus });
    const ctx: ToolContext = { ...makeContext(), taskId: 'task-xyz' };
    const res = await tool.execute({ callId: 'c1', id: 'refactor/observed' }, ctx);
    expect(res.status).toBe('success');
    expect(events).toEqual([{ taskId: 'task-xyz', skillId: 'refactor/observed' }]);
  });

  test('Phase-11: silent when bus omitted', async () => {
    await store.write(makeRecord({ id: 'refactor/silent' }));
    const tool = createSkillViewTool({ artifactStore: store });
    const ctx: ToolContext = { ...makeContext(), taskId: 'task-zzz' };
    const res = await tool.execute({ callId: 'c1', id: 'refactor/silent' }, ctx);
    expect(res.status).toBe('success'); // no throw → no bus required
  });

  test('Phase-11: silent when taskId missing on context', async () => {
    const { createBus } = await import('../../../src/core/bus.ts');
    const bus = createBus();
    const events: unknown[] = [];
    bus.on('skill:viewed', (ev) => events.push(ev));
    await store.write(makeRecord({ id: 'refactor/no-task' }));
    const tool = createSkillViewTool({ artifactStore: store, bus });
    await tool.execute({ callId: 'c1', id: 'refactor/no-task' }, makeContext()); // no taskId
    expect(events).toEqual([]);
  });

  test('Phase-11: denied skill does NOT emit skill:viewed', async () => {
    const { createBus } = await import('../../../src/core/bus.ts');
    const bus = createBus();
    const events: unknown[] = [];
    bus.on('skill:viewed', (ev) => events.push(ev));
    await store.write(makeRecord({ id: 'a/quar2', status: 'quarantined' }));
    const tool = createSkillViewTool({ artifactStore: store, bus });
    const ctx: ToolContext = { ...makeContext(), taskId: 'task-q' };
    const res = await tool.execute({ callId: 'c1', id: 'a/quar2' }, ctx);
    expect(res.status).toBe('denied');
    expect(events).toEqual([]);
  });
});

describe('skill_view_file', () => {
  test('reads a whitelisted file', async () => {
    const rec = makeRecord({ id: 'a/files', files: ['note.md'] });
    await store.write(rec, new Map([['note.md', 'hello world']]));
    const tool = createSkillViewFileTool({ artifactStore: store });
    const res = await tool.execute({ callId: 'c1', id: 'a/files', path: 'note.md' }, makeContext());
    expect(res.status).toBe('success');
    const out = res.output as { content: string; skillId: string };
    expect(out.content).toBe('hello world');
    expect(out.skillId).toBe('a/files');
  });

  test('denies a non-whitelisted path', async () => {
    const rec = makeRecord({ id: 'a/whitelist-only', files: ['note.md'] });
    await store.write(rec, new Map([['note.md', 'ok']]));
    const tool = createSkillViewFileTool({ artifactStore: store });
    const res = await tool.execute({ callId: 'c1', id: 'a/whitelist-only', path: 'other.md' }, makeContext());
    expect(res.status).toBe('denied');
  });

  test('denies path traversal', async () => {
    const rec = makeRecord({ id: 'a/trav', files: ['../../../etc/passwd'] });
    await store.write(rec);
    const tool = createSkillViewFileTool({ artifactStore: store });
    const res = await tool.execute({ callId: 'c1', id: 'a/trav', path: '../../../etc/passwd' }, makeContext());
    expect(res.status).toBe('denied');
  });

  test('denies quarantined skill', async () => {
    const rec = makeRecord({ id: 'a/quar-file', status: 'quarantined', files: ['note.md'] });
    await store.write(rec, new Map([['note.md', 'x']]));
    const tool = createSkillViewFileTool({ artifactStore: store });
    const res = await tool.execute({ callId: 'c1', id: 'a/quar-file', path: 'note.md' }, makeContext());
    expect(res.status).toBe('denied');
  });
});

describe('registerSkillTools', () => {
  test('installs all three tools on a Map registry', () => {
    const registry = new Map<string, Tool>();
    registerSkillTools({ toolRegistry: registry, deps: { artifactStore: store } });
    expect(registry.has('skills_list')).toBe(true);
    expect(registry.has('skill_view')).toBe(true);
    expect(registry.has('skill_view_file')).toBe(true);
  });
});
