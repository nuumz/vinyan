/**
 * Tests for the Phase-5B `getDerivedCapabilities({ extraRefs })` extension —
 * the **acquired** scope foundation.
 *
 * Covers:
 *   - extraRefs flow through to derivation alongside base + bound
 *   - extraRefs honor the same skill resolver as base/bound
 *   - extraRefs do NOT persist between calls (caller-managed)
 *   - dedupe-by-last lets an acquired claim override a stale bound claim
 *     of the same id
 *   - feature-flag off → extraRefs ignored (legacy behaviour preserved)
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SyncSkillResolver } from '../../../src/orchestrator/agents/derive-persona-capabilities.ts';
import { saveBoundSkills } from '../../../src/orchestrator/agents/persona-skill-loader.ts';
import { loadAgentRegistry } from '../../../src/orchestrator/agents/registry.ts';
import type { SkillRef } from '../../../src/orchestrator/types.ts';
import type { SkillMdRecord } from '../../../src/skills/skill-md/index.ts';

function makeSkill(id: string, overrides: Partial<SkillMdRecord['frontmatter']> = {}): SkillMdRecord {
  return {
    frontmatter: {
      id,
      name: id,
      version: '1.0.0',
      description: 'fixture',
      requires_toolsets: [],
      fallback_for_toolsets: [],
      confidence_tier: 'heuristic',
      origin: 'local',
      declared_oracles: [],
      falsifiable_by: [],
      status: 'active',
      provides_capabilities: [{ id: `cap.${id}` }],
      ...overrides,
    },
    body: { overview: 'o', whenToUse: 'w', procedure: 'p' },
    contentHash: `sha256:${'0'.repeat(64)}`,
  };
}

function makeResolver(skills: SkillMdRecord[]): SyncSkillResolver {
  const map = new Map(skills.map((s) => [s.frontmatter.id, s]));
  return { resolve: (ref: SkillRef) => map.get(ref.id) ?? null };
}

describe('registry.getDerivedCapabilities — Phase-5B extraRefs (acquired scope)', () => {
  function setup(boundIds: string[], availableSkills: SkillMdRecord[]) {
    const ws = mkdtempSync(join(tmpdir(), 'vinyan-extra-'));
    if (boundIds.length > 0) {
      saveBoundSkills(
        ws,
        'developer',
        boundIds.map((id) => ({ id })),
      );
    }
    const reg = loadAgentRegistry(ws, undefined, undefined, { skillResolver: makeResolver(availableSkills) });
    return { reg, cleanup: () => rmSync(ws, { recursive: true, force: true }) };
  }

  test('extraRefs flow through alongside base + bound skills', () => {
    const tsSkill = makeSkill('typescript-coding');
    const reactSkill = makeSkill('react-patterns');
    const { reg, cleanup } = setup(['typescript-coding'], [tsSkill, reactSkill]);
    try {
      const derived = reg.getDerivedCapabilities('developer', {
        extraRefs: [{ id: 'react-patterns' }],
      });
      const ids = derived!.loadedSkills.map((s) => s.frontmatter.id).sort();
      expect(ids).toEqual(['react-patterns', 'typescript-coding']);
    } finally {
      cleanup();
    }
  });

  test('extraRefs do NOT persist between calls (caller-managed lifecycle)', () => {
    const tsSkill = makeSkill('typescript-coding');
    const acquired = makeSkill('one-shot-skill');
    const { reg, cleanup } = setup(['typescript-coding'], [tsSkill, acquired]);
    try {
      // First call: extras supplied → present
      const withExtras = reg.getDerivedCapabilities('developer', {
        extraRefs: [{ id: 'one-shot-skill' }],
      });
      expect(withExtras!.loadedSkills.map((s) => s.frontmatter.id)).toContain('one-shot-skill');

      // Second call: no extras → only bound visible
      const withoutExtras = reg.getDerivedCapabilities('developer');
      expect(withoutExtras!.loadedSkills.map((s) => s.frontmatter.id)).not.toContain('one-shot-skill');
      expect(withoutExtras!.loadedSkills.map((s) => s.frontmatter.id)).toContain('typescript-coding');
    } finally {
      cleanup();
    }
  });

  test('feature flag off → extraRefs ignored', () => {
    const acquired = makeSkill('acquired-skill');
    const ws = mkdtempSync(join(tmpdir(), 'vinyan-extra-flag-'));
    try {
      const reg = loadAgentRegistry(ws, undefined, undefined, {
        skillResolver: makeResolver([acquired]),
        enableSkillComposition: false,
      });
      const derived = reg.getDerivedCapabilities('developer', {
        extraRefs: [{ id: 'acquired-skill' }],
      });
      // Composition disabled → no skills loaded regardless of extras
      expect(derived!.loadedSkills).toHaveLength(0);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test('extraRefs honor pin-mismatch checks like base/bound', () => {
    const tsSkill = makeSkill('typescript-coding', { content_hash: `sha256:${'a'.repeat(64)}` });
    const { reg, cleanup } = setup([], [tsSkill]);
    try {
      const derived = reg.getDerivedCapabilities('developer', {
        extraRefs: [{ id: 'typescript-coding', contentHash: `sha256:${'b'.repeat(64)}` }],
      });
      // Pin mismatch → skipped, not loaded
      expect(derived!.loadedSkills).toHaveLength(0);
      expect(derived!.skipped).toHaveLength(1);
      expect(derived!.skipped[0]?.reason).toBe('pin-mismatch');
    } finally {
      cleanup();
    }
  });

  test('declared capability ids include extraRefs-derived claims', () => {
    const acquired = makeSkill('research-skill', {
      provides_capabilities: [{ id: 'research.synthesis' }],
    });
    const { reg, cleanup } = setup([], [acquired]);
    try {
      const derived = reg.getDerivedCapabilities('developer', {
        extraRefs: [{ id: 'research-skill' }],
      });
      const claimIds = derived!.capabilities.map((c) => c.id);
      expect(claimIds).toContain('research.synthesis');
    } finally {
      cleanup();
    }
  });
});
