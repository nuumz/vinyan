/**
 * Tests for LocalHubAcquirer — Phase-6 acquisition flow.
 *
 * Covers:
 *   - matches skill by capability id
 *   - filters by acquirableSkillTags
 *   - filters by status (probation/demoted/quarantined → reject)
 *   - filters by toolset allowlist for the persona's role
 *   - tier-ordered results (deterministic first)
 *   - empty store / no match → []
 *   - artifact-store list/read failures → [] (A9)
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalHubAcquirer } from '../../../src/orchestrator/agents/local-hub-acquirer.ts';
import type { AgentSpec, CapabilityRequirement } from '../../../src/orchestrator/types.ts';
import { SkillArtifactStore } from '../../../src/skills/artifact-store.ts';

function writeSkill(rootDir: string, namespace: string, id: string, body: string): void {
  const dir = join(rootDir, namespace, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), body, 'utf-8');
}

function makePersona(overrides: Partial<AgentSpec> = {}): AgentSpec {
  return {
    id: 'developer',
    name: 'Developer',
    description: 'gen',
    role: 'developer',
    acquirableSkillTags: ['language:*'],
    ...overrides,
  };
}

function gap(id: string): CapabilityRequirement {
  return { id, weight: 1, source: 'fingerprint' };
}

function skillMd(opts: {
  id: string;
  tier?: 'deterministic' | 'heuristic' | 'pragmatic' | 'probabilistic' | 'speculative';
  status?: 'active' | 'probation' | 'demoted' | 'retired' | 'quarantined';
  tags?: string[];
  provides: string[];
  toolsets?: string[];
}): string {
  const tier = opts.tier ?? 'heuristic';
  const status = opts.status ?? 'active';
  const tags = opts.tags ? `\ntags:\n${opts.tags.map((t) => `  - ${t}`).join('\n')}` : '';
  const toolsets = opts.toolsets
    ? `\nrequires_toolsets:\n${opts.toolsets.map((t) => `  - ${t}`).join('\n')}`
    : '\nrequires_toolsets: []';
  const provides = `\nprovides_capabilities:\n${opts.provides.map((c) => `  - id: ${c}`).join('\n')}`;
  // deterministic tier needs content_hash — give a fixture if needed
  const hashLine = tier === 'deterministic' ? `\ncontent_hash: sha256:${'0'.repeat(64)}` : '';
  return `---
id: ${opts.id}
name: ${opts.id}
version: 1.0.0
description: fixture skill ${opts.id}
confidence_tier: ${tier}
origin: local
status: ${status}${tags}${toolsets}${provides}${hashLine}
---

## Overview
fixture

## When to use
testing

## Procedure
1. step
`;
}

describe('LocalHubAcquirer', () => {
  function setup() {
    const ws = mkdtempSync(join(tmpdir(), 'vinyan-acquirer-'));
    const skillsRoot = join(ws, 'skills');
    mkdirSync(skillsRoot, { recursive: true });
    const store = new SkillArtifactStore({ rootDir: skillsRoot });
    const acquirer = new LocalHubAcquirer({ artifactStore: store });
    return { ws, skillsRoot, acquirer, cleanup: () => rmSync(ws, { recursive: true, force: true }) };
  }

  test('matches skill by capability id + tags + role allowlist', async () => {
    const { skillsRoot, acquirer, cleanup } = setup();
    try {
      writeSkill(
        skillsRoot,
        'local',
        'typescript-coding',
        skillMd({
          id: 'typescript-coding',
          tags: ['language:typescript'],
          provides: ['code.mutation.ts'],
        }),
      );
      const refs = await acquirer.acquireForGap(makePersona(), gap('code.mutation.ts'), {
        taskId: 't1',
      });
      expect(refs).toHaveLength(1);
      expect(refs[0]?.id).toBe('typescript-coding');
    } finally {
      cleanup();
    }
  });

  test('rejects skill whose tags do not match acquirableSkillTags', async () => {
    const { skillsRoot, acquirer, cleanup } = setup();
    try {
      writeSkill(
        skillsRoot,
        'local',
        'java-coding',
        skillMd({
          id: 'java-coding',
          tags: ['runtime:jvm'],
          provides: ['code.mutation.java'],
        }),
      );
      const refs = await acquirer.acquireForGap(
        makePersona({ acquirableSkillTags: ['language:*'] }),
        gap('code.mutation.java'),
        { taskId: 't1' },
      );
      expect(refs).toHaveLength(0);
    } finally {
      cleanup();
    }
  });

  test('rejects skill whose status is not active', async () => {
    const { skillsRoot, acquirer, cleanup } = setup();
    try {
      writeSkill(
        skillsRoot,
        'local',
        'shaky-skill',
        skillMd({
          id: 'shaky-skill',
          status: 'probation',
          tags: ['language:typescript'],
          provides: ['code.mutation.ts'],
        }),
      );
      const refs = await acquirer.acquireForGap(makePersona(), gap('code.mutation.ts'), {
        taskId: 't1',
      });
      expect(refs).toHaveLength(0);
    } finally {
      cleanup();
    }
  });

  test('rejects skill whose toolsets exceed role allowlist (mentor + shell)', async () => {
    const { skillsRoot, acquirer, cleanup } = setup();
    try {
      writeSkill(
        skillsRoot,
        'local',
        'shell-helper',
        skillMd({
          id: 'shell-helper',
          tags: ['runtime:shell'],
          provides: ['shell.run'],
          toolsets: ['shell-exec'],
        }),
      );
      const mentor = makePersona({ id: 'mentor', role: 'mentor', acquirableSkillTags: ['runtime:*'] });
      const refs = await acquirer.acquireForGap(mentor, gap('shell.run'), { taskId: 't1' });
      expect(refs).toHaveLength(0);
    } finally {
      cleanup();
    }
  });

  test('returns highest-tier skill first when multiple match', async () => {
    const { skillsRoot, acquirer, cleanup } = setup();
    try {
      writeSkill(
        skillsRoot,
        'local',
        'a-prob',
        skillMd({
          id: 'a-prob',
          tier: 'probabilistic',
          tags: ['language:typescript'],
          provides: ['code.mutation.ts'],
        }),
      );
      writeSkill(
        skillsRoot,
        'local',
        'b-heur',
        skillMd({
          id: 'b-heur',
          tier: 'heuristic',
          tags: ['language:typescript'],
          provides: ['code.mutation.ts'],
        }),
      );
      const refs = await acquirer.acquireForGap(makePersona(), gap('code.mutation.ts'), {
        taskId: 't1',
      });
      // Default maxResults = 1 → only the heuristic-tier (better) is returned
      expect(refs).toHaveLength(1);
      expect(refs[0]?.id).toBe('b-heur');
    } finally {
      cleanup();
    }
  });

  test('empty store → []', async () => {
    const { acquirer, cleanup } = setup();
    try {
      const refs = await acquirer.acquireForGap(makePersona(), gap('code.mutation.ts'), {
        taskId: 't1',
      });
      expect(refs).toHaveLength(0);
    } finally {
      cleanup();
    }
  });

  test('A9 — missing skill directory → []', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'vinyan-acquirer-missing-'));
    try {
      const store = new SkillArtifactStore({ rootDir: join(ws, 'never-existed') });
      const acquirer = new LocalHubAcquirer({ artifactStore: store });
      const refs = await acquirer.acquireForGap(makePersona(), gap('code.mutation.ts'), {
        taskId: 't1',
      });
      expect(refs).toHaveLength(0);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});
