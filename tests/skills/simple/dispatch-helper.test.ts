/**
 * Simple-skill dispatch helper — covers the contract worker-pool and
 * conversational-result-builder share. The helper has to:
 *
 *   1. Snapshot the registry and run the matcher against `goal`.
 *   2. Honour explicit `/skill-name` invocation over similarity matching.
 *   3. Per-agent visibility — only the agent's + shared skills are visible.
 *   4. Emit `skill:simple_invoked` for each inlined body when bus + taskId given.
 *   5. Render the `[AVAILABLE SKILLS]` / `[ACTIVE SKILLS]` blocks identically
 *      to the way the prompt-section-registry renders them in the full
 *      pipeline path (so conversational ↔ subprocess ↔ in-process all
 *      produce the same prompt for the same skills).
 */
import { describe, expect, test } from 'bun:test';
import { createBus, type VinyanBusEvents } from '../../../src/core/bus.ts';
import {
  renderSimpleSkillSections,
  resolveSimpleSkillsForDispatch,
} from '../../../src/skills/simple/dispatch-helper.ts';
import type { SimpleSkill } from '../../../src/skills/simple/loader.ts';
import type { SimpleSkillRegistry } from '../../../src/skills/simple/registry.ts';

function mkSkill(over: Partial<SimpleSkill> & Pick<SimpleSkill, 'name' | 'description'>): SimpleSkill {
  return {
    name: over.name,
    description: over.description,
    body: over.body ?? `body for ${over.name}`,
    scope: over.scope ?? 'project',
    ...(over.agentId ? { agentId: over.agentId } : {}),
    path: over.path ?? `/tmp/${over.name}/SKILL.md`,
  };
}

function staticRegistry(skills: readonly SimpleSkill[]): SimpleSkillRegistry {
  return {
    getAll: () => skills,
    getForAgent: (agentId) => {
      if (!agentId) return skills.filter((s) => s.scope === 'user' || s.scope === 'project');
      return skills.filter(
        (s) =>
          s.scope === 'user' ||
          s.scope === 'project' ||
          ((s.scope === 'user-agent' || s.scope === 'project-agent') && s.agentId === agentId),
      );
    },
    getByName: (name) => skills.find((s) => s.name === name) ?? null,
    getVersion: () => 1,
    close: () => undefined,
  };
}

describe('resolveSimpleSkillsForDispatch', () => {
  test('returns empty when registry is missing', () => {
    const out = resolveSimpleSkillsForDispatch({
      registry: undefined,
      goal: 'review some code please',
    });
    expect(out.simpleSkills).toEqual([]);
    expect(out.simpleSkillBodies).toEqual([]);
  });

  test('returns empty when registry has no visible skills', () => {
    const out = resolveSimpleSkillsForDispatch({
      registry: staticRegistry([]),
      goal: 'review some code please',
    });
    expect(out.simpleSkills).toEqual([]);
    expect(out.simpleSkillBodies).toEqual([]);
  });

  test('matches by description tokens (Jaccard similarity)', () => {
    const review = mkSkill({
      name: 'code-review',
      description: 'Review code for bugs and regressions when reviewing PRs.',
    });
    const out = resolveSimpleSkillsForDispatch({
      registry: staticRegistry([review]),
      goal: 'review code for bugs in this PR',
    });
    expect(out.simpleSkills.map((s) => s.name)).toEqual(['code-review']);
    expect(out.simpleSkillBodies.map((s) => s.name)).toEqual(['code-review']);
  });

  test('explicit /skill-name invocation wins over similarity', () => {
    const review = mkSkill({
      name: 'code-review',
      description: 'Review TypeScript code.',
    });
    const writer = mkSkill({
      name: 'writer',
      description: 'Helpful prose writing assistant.',
    });
    const out = resolveSimpleSkillsForDispatch({
      registry: staticRegistry([review, writer]),
      // Goal text actually mentions writing — would match `writer` by tokens
      // — but the explicit invocation takes precedence.
      goal: '/code-review please look at this paragraph for me',
    });
    expect(out.simpleSkillBodies.map((s) => s.name)).toEqual(['code-review']);
  });

  test('per-agent visibility filtering', () => {
    const shared = mkSkill({ name: 'shared-thing', description: 'shared scope skill' });
    const onlyForResearcher = mkSkill({
      name: 'web-search',
      description: 'web-search skill researcher uses',
      scope: 'project-agent',
      agentId: 'researcher',
    });
    const reg = staticRegistry([shared, onlyForResearcher]);

    const forResearcher = resolveSimpleSkillsForDispatch({
      registry: reg,
      goal: 'web-search shared',
      agentId: 'researcher',
    });
    expect(forResearcher.simpleSkills.map((s) => s.name).sort()).toEqual([
      'shared-thing',
      'web-search',
    ]);

    const forOther = resolveSimpleSkillsForDispatch({
      registry: reg,
      goal: 'web-search shared',
      agentId: 'developer',
    });
    expect(forOther.simpleSkills.map((s) => s.name)).toEqual(['shared-thing']);
  });

  test('emits skill:simple_invoked per inlined body when bus + taskId provided', () => {
    const review = mkSkill({
      name: 'code-review',
      description: 'Review code for bugs.',
    });
    const bus = createBus();
    const fired: VinyanBusEvents['skill:simple_invoked'][] = [];
    bus.on('skill:simple_invoked', (ev) => fired.push(ev));

    const out = resolveSimpleSkillsForDispatch({
      registry: staticRegistry([review]),
      goal: 'review code for bugs',
      bus,
      taskId: 'task-1',
    });
    expect(out.simpleSkillBodies.map((s) => s.name)).toEqual(['code-review']);
    expect(fired).toHaveLength(1);
    expect(fired[0]?.skillName).toBe('code-review');
    expect(fired[0]?.taskId).toBe('task-1');
  });

  test('emits nothing when no bodies match (bus must not fire spuriously)', () => {
    const skill = mkSkill({
      name: 'code-review',
      description: 'Review code.',
    });
    const bus = createBus();
    const fired: VinyanBusEvents['skill:simple_invoked'][] = [];
    bus.on('skill:simple_invoked', (ev) => fired.push(ev));

    const out = resolveSimpleSkillsForDispatch({
      registry: staticRegistry([skill]),
      goal: 'render an svg of a duck',
      bus,
      taskId: 'task-1',
    });
    expect(out.simpleSkillBodies).toEqual([]);
    expect(fired).toEqual([]);
  });
});

describe('renderSimpleSkillSections', () => {
  test('returns null blocks when both inputs are empty', () => {
    const out = renderSimpleSkillSections([], []);
    expect(out.available).toBeNull();
    expect(out.active).toBeNull();
  });

  test('available block lists every skill description', () => {
    const a = mkSkill({ name: 'a', description: 'first thing' });
    const b = mkSkill({ name: 'b', description: 'second thing' });
    const out = renderSimpleSkillSections([a, b], []);
    expect(out.available).toContain('[AVAILABLE SKILLS]');
    expect(out.available).toContain('- a: first thing');
    expect(out.available).toContain('- b: second thing');
    expect(out.active).toBeNull();
  });

  test('active block inlines body verbatim with header dividers', () => {
    const a = mkSkill({
      name: 'code-review',
      description: 'Review code for bugs.',
      body: 'When reviewing:\n1. Check null derefs\n2. Verify error handling',
    });
    const out = renderSimpleSkillSections([a], [a]);
    expect(out.active).toContain('[ACTIVE SKILLS]');
    expect(out.active).toContain('── code-review ──');
    expect(out.active).toContain('Review code for bugs.');
    expect(out.active).toContain('Check null derefs');
    expect(out.active).toContain('Verify error handling');
  });
});
