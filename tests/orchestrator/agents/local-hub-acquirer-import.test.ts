/**
 * Phase-14 (Item 1) — LocalHubAcquirer remote-fetch fallback.
 *
 * Covers:
 *   - cache-miss → discoverCandidateIds → importer.import → rescan → hit
 *   - importer not wired → no fetch attempted (legacy path safe)
 *   - discovery hook returns empty → no fetch attempted
 *   - importer rejection → not promoted → not in result
 *   - discovery throws → degrades to local-only result (A9)
 *   - importer throws on one id → other ids still tried
 *   - cache hit → importer never called (steady-state fast path)
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalHubAcquirer } from '../../../src/orchestrator/agents/local-hub-acquirer.ts';
import type { AgentSpec, CapabilityRequirement } from '../../../src/orchestrator/types.ts';
import { SkillArtifactStore } from '../../../src/skills/artifact-store.ts';
import type { ImportState, SkillImporter } from '../../../src/skills/hub/importer.ts';

function writeSkill(rootDir: string, namespace: string, id: string, body: string): void {
  const dir = join(rootDir, namespace, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), body, 'utf-8');
}

function makePersona(): AgentSpec {
  return {
    id: 'developer',
    name: 'Developer',
    description: 'gen',
    role: 'developer',
    acquirableSkillTags: ['language:*'],
  };
}

function gap(id: string): CapabilityRequirement {
  return { id, weight: 1, source: 'fingerprint' };
}

function skillMd(opts: { id: string; provides: string[]; tags?: string[] }): string {
  const tags = opts.tags ? `\ntags:\n${opts.tags.map((t) => `  - ${t}`).join('\n')}` : '';
  const provides = `\nprovides_capabilities:\n${opts.provides.map((c) => `  - id: ${c}`).join('\n')}`;
  return `---
id: ${opts.id}
name: ${opts.id}
version: 1.0.0
description: fixture
confidence_tier: heuristic
origin: local
status: active${tags}
requires_toolsets: []${provides}
---

## Overview
fixture

## When to use
test

## Procedure
1. step
`;
}

function setup(skillsRoot: string) {
  return new SkillArtifactStore({ rootDir: skillsRoot });
}

/**
 * Fake importer that "promotes" a skill by writing it to the artifact store.
 * The real `SkillImporter.import` runs the full pipeline; here we cut to the
 * outcome (skill lands as `active` on disk) so the LocalHubAcquirer's
 * post-import rescan finds it.
 */
function makeFakeImporter(opts: {
  store: SkillArtifactStore;
  skillsRoot: string;
  capabilityId: string;
  rejectIds?: ReadonlySet<string>;
  throwOnIds?: ReadonlySet<string>;
}): { importer: SkillImporter; calls: string[] } {
  const calls: string[] = [];
  const importer = {
    async import(skillId: string): Promise<ImportState> {
      calls.push(skillId);
      if (opts.throwOnIds?.has(skillId)) throw new Error('boom');
      if (opts.rejectIds?.has(skillId)) {
        return { kind: 'rejected', skillId, parsed: null, reason: 'fixture-reject' };
      }
      // "promote" by writing an active skill to the local artifact store.
      const namespace = skillId.includes('/') ? skillId.split('/')[0]! : 'remote';
      const id = skillId.includes('/') ? skillId.split('/')[1]! : skillId;
      writeSkill(
        opts.skillsRoot,
        namespace,
        id,
        skillMd({ id: `${namespace}/${id}`, provides: [opts.capabilityId], tags: ['language:typescript'] }),
      );
      return { kind: 'promoted', skillId } as unknown as ImportState;
    },
  } as unknown as SkillImporter;
  return { importer, calls };
}

describe('LocalHubAcquirer — Phase-14 Item 1 remote fetch fallback', () => {
  test('cache miss → discovery → import → rescan → hit', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'vinyan-acquirer-import-'));
    const skillsRoot = join(ws, 'skills');
    mkdirSync(skillsRoot, { recursive: true });
    const store = setup(skillsRoot);
    const { importer, calls } = makeFakeImporter({
      store,
      skillsRoot,
      capabilityId: 'lang.typescript',
    });
    const acquirer = new LocalHubAcquirer({
      artifactStore: store,
      importer,
      discoverCandidateIds: async () => ['remote/ts-coding'],
    });

    try {
      const result = await acquirer.acquireForGap(makePersona(), gap('lang.typescript'), { taskId: 'task-1' });
      expect(calls).toEqual(['remote/ts-coding']);
      expect(result).toHaveLength(1);
      expect(result[0]!.id).toBe('remote/ts-coding');
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test('cache hit → importer never invoked (fast path)', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'vinyan-acquirer-fast-'));
    const skillsRoot = join(ws, 'skills');
    mkdirSync(skillsRoot, { recursive: true });
    writeSkill(
      skillsRoot,
      'local',
      'ts',
      skillMd({ id: 'local/ts', provides: ['lang.typescript'], tags: ['language:typescript'] }),
    );
    const store = setup(skillsRoot);
    const { importer, calls } = makeFakeImporter({ store, skillsRoot, capabilityId: 'lang.typescript' });
    const acquirer = new LocalHubAcquirer({
      artifactStore: store,
      importer,
      discoverCandidateIds: async () => ['remote/ts'],
    });
    try {
      const result = await acquirer.acquireForGap(makePersona(), gap('lang.typescript'), { taskId: 'task-1' });
      expect(result).toHaveLength(1);
      expect(result[0]!.id).toBe('local/ts');
      expect(calls).toEqual([]); // no remote attempt
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test('importer omitted → no remote attempt (legacy local-only path)', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'vinyan-acquirer-legacy-'));
    const skillsRoot = join(ws, 'skills');
    mkdirSync(skillsRoot, { recursive: true });
    const store = setup(skillsRoot);
    const acquirer = new LocalHubAcquirer({
      artifactStore: store,
      discoverCandidateIds: async () => ['remote/ts'],
    });
    try {
      const result = await acquirer.acquireForGap(makePersona(), gap('lang.typescript'), { taskId: 'task-1' });
      expect(result).toEqual([]);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test('discovery returns empty → no fetch attempted', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'vinyan-acquirer-empty-'));
    const skillsRoot = join(ws, 'skills');
    mkdirSync(skillsRoot, { recursive: true });
    const store = setup(skillsRoot);
    const { importer, calls } = makeFakeImporter({ store, skillsRoot, capabilityId: 'lang.typescript' });
    const acquirer = new LocalHubAcquirer({
      artifactStore: store,
      importer,
      discoverCandidateIds: async () => [],
    });
    try {
      const result = await acquirer.acquireForGap(makePersona(), gap('lang.typescript'), { taskId: 'task-1' });
      expect(result).toEqual([]);
      expect(calls).toEqual([]);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test('importer rejection → skill never appears in result', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'vinyan-acquirer-reject-'));
    const skillsRoot = join(ws, 'skills');
    mkdirSync(skillsRoot, { recursive: true });
    const store = setup(skillsRoot);
    const { importer } = makeFakeImporter({
      store,
      skillsRoot,
      capabilityId: 'lang.typescript',
      rejectIds: new Set(['remote/bad']),
    });
    const acquirer = new LocalHubAcquirer({
      artifactStore: store,
      importer,
      discoverCandidateIds: async () => ['remote/bad'],
    });
    try {
      const result = await acquirer.acquireForGap(makePersona(), gap('lang.typescript'), { taskId: 'task-1' });
      expect(result).toEqual([]);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test('discovery throws → degrades to local-only (A9)', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'vinyan-acquirer-disco-throw-'));
    const skillsRoot = join(ws, 'skills');
    mkdirSync(skillsRoot, { recursive: true });
    const store = setup(skillsRoot);
    const { importer, calls } = makeFakeImporter({ store, skillsRoot, capabilityId: 'lang.typescript' });
    const acquirer = new LocalHubAcquirer({
      artifactStore: store,
      importer,
      discoverCandidateIds: async () => {
        throw new Error('discovery boom');
      },
    });
    try {
      const result = await acquirer.acquireForGap(makePersona(), gap('lang.typescript'), { taskId: 'task-1' });
      expect(result).toEqual([]);
      expect(calls).toEqual([]); // never called because discovery threw
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test('importer throws on one id → other ids still tried', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'vinyan-acquirer-resilient-'));
    const skillsRoot = join(ws, 'skills');
    mkdirSync(skillsRoot, { recursive: true });
    const store = setup(skillsRoot);
    const { importer, calls } = makeFakeImporter({
      store,
      skillsRoot,
      capabilityId: 'lang.typescript',
      throwOnIds: new Set(['remote/broken']),
    });
    const acquirer = new LocalHubAcquirer({
      artifactStore: store,
      importer,
      discoverCandidateIds: async () => ['remote/broken', 'remote/works'],
    });
    try {
      const result = await acquirer.acquireForGap(makePersona(), gap('lang.typescript'), { taskId: 'task-1' });
      expect(calls).toEqual(['remote/broken', 'remote/works']);
      expect(result).toHaveLength(1);
      expect(result[0]!.id).toBe('remote/works');
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});
