/**
 * Tests for persona-skill binding — Phase 2.
 *
 * Covers:
 *   - persona-skill-loader: load/save round-trip, missing file → [], malformed → []
 *   - registry integration: getDerivedCapabilities reads bound skills
 *   - registry integration: missing resolver → degrades cleanly (no skill claims)
 *   - registry integration: feature flag off → skill composition skipped
 */
import { describe, expect, mock, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SyncSkillResolver } from '../../../src/orchestrator/agents/derive-persona-capabilities.ts';
import {
  boundSkillsPath,
  loadBoundSkills,
  saveBoundSkills,
} from '../../../src/orchestrator/agents/persona-skill-loader.ts';
import { loadAgentRegistry } from '../../../src/orchestrator/agents/registry.ts';
import type { SkillRef } from '../../../src/orchestrator/types.ts';
import type { SkillMdRecord } from '../../../src/skills/skill-md/index.ts';

function freshWorkspace(): string {
  return mkdtempSync(join(tmpdir(), 'vinyan-skill-binding-'));
}

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
    body: {
      overview: 'overview',
      whenToUse: 'when',
      procedure: 'procedure',
    },
    contentHash: 'sha256:' + '0'.repeat(64),
  };
}

function makeResolver(skills: SkillMdRecord[]): SyncSkillResolver {
  const map = new Map<string, SkillMdRecord>(skills.map((s) => [s.frontmatter.id, s]));
  return { resolve: (ref: SkillRef) => map.get(ref.id) ?? null };
}

describe('persona-skill-loader', () => {
  test('round-trip: save then load returns the persisted refs', () => {
    const ws = freshWorkspace();
    try {
      const refs: SkillRef[] = [{ id: 'typescript-coding', pinnedVersion: '1.2.0' }, { id: 'react-patterns' }];
      saveBoundSkills(ws, 'developer', refs);
      const loaded = loadBoundSkills(ws, 'developer');
      // Persisted in id-sorted order for stable diffs
      expect(loaded.map((r) => r.id)).toEqual(['react-patterns', 'typescript-coding']);
      expect(loaded.find((r) => r.id === 'typescript-coding')?.pinnedVersion).toBe('1.2.0');
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test('missing file returns [] (A9 — never crashes)', () => {
    const ws = freshWorkspace();
    try {
      expect(loadBoundSkills(ws, 'developer')).toEqual([]);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test('malformed file emits warning and returns [] (A9)', () => {
    const ws = freshWorkspace();
    const warnSpy = mock((..._args: unknown[]) => {});
    const original = console.warn;
    console.warn = warnSpy;
    try {
      mkdirSync(join(ws, '.vinyan', 'agents', 'developer'), { recursive: true });
      writeFileSync(boundSkillsPath(ws, 'developer'), '{ this is not valid json', 'utf-8');
      expect(loadBoundSkills(ws, 'developer')).toEqual([]);
      const messages = warnSpy.mock.calls.map((c) => String(c[0]));
      expect(messages.some((m) => m.includes('skill:bound-load'))).toBe(true);
    } finally {
      console.warn = original;
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test('personaId mismatch is rejected with warning', () => {
    const ws = freshWorkspace();
    const warnSpy = mock((..._args: unknown[]) => {});
    const original = console.warn;
    console.warn = warnSpy;
    try {
      mkdirSync(join(ws, '.vinyan', 'agents', 'developer'), { recursive: true });
      const wrong = JSON.stringify({ version: 1, personaId: 'author', skills: [] });
      writeFileSync(boundSkillsPath(ws, 'developer'), wrong, 'utf-8');
      expect(loadBoundSkills(ws, 'developer')).toEqual([]);
      const messages = warnSpy.mock.calls.map((c) => String(c[0]));
      expect(messages.some((m) => m.includes('personaId='))).toBe(true);
    } finally {
      console.warn = original;
      rmSync(ws, { recursive: true, force: true });
    }
  });
});

describe('registry.getDerivedCapabilities', () => {
  test('returns null for unknown agent', () => {
    const ws = freshWorkspace();
    try {
      const reg = loadAgentRegistry(ws, undefined);
      expect(reg.getDerivedCapabilities('nonexistent')).toBeNull();
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test('without resolver: returns persona capabilities + persona ACL unchanged', () => {
    const ws = freshWorkspace();
    try {
      const reg = loadAgentRegistry(ws, undefined);
      const result = reg.getDerivedCapabilities('developer');
      expect(result).not.toBeNull();
      expect(result!.loadedSkills).toHaveLength(0);
      expect(result!.capabilities.length).toBeGreaterThan(0);
      expect(result!.skipped).toHaveLength(0);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test('with resolver + bound skills: derived capabilities include skill claims', () => {
    const ws = freshWorkspace();
    try {
      const tsSkill = makeSkill('typescript-coding');
      saveBoundSkills(ws, 'developer', [{ id: 'typescript-coding' }]);
      const reg = loadAgentRegistry(ws, undefined, undefined, {
        skillResolver: makeResolver([tsSkill]),
      });
      const result = reg.getDerivedCapabilities('developer');
      expect(result!.loadedSkills).toHaveLength(1);
      expect(result!.capabilities.some((c) => c.id === 'cap.typescript-coding')).toBe(true);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test('feature flag off: skill composition is skipped even when resolver is present', () => {
    const ws = freshWorkspace();
    try {
      const tsSkill = makeSkill('typescript-coding');
      saveBoundSkills(ws, 'developer', [{ id: 'typescript-coding' }]);
      const reg = loadAgentRegistry(ws, undefined, undefined, {
        skillResolver: makeResolver([tsSkill]),
        enableSkillComposition: false,
      });
      const result = reg.getDerivedCapabilities('developer');
      expect(result!.loadedSkills).toHaveLength(0);
      expect(result!.capabilities.some((c) => c.id === 'cap.typescript-coding')).toBe(false);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test('binding a missing skill is collected in skipped[] (A9)', () => {
    const ws = freshWorkspace();
    const warnSpy = mock((..._args: unknown[]) => {});
    const original = console.warn;
    console.warn = warnSpy;
    try {
      saveBoundSkills(ws, 'developer', [{ id: 'absent-skill' }]);
      const reg = loadAgentRegistry(ws, undefined, undefined, {
        skillResolver: makeResolver([]),
      });
      const result = reg.getDerivedCapabilities('developer');
      expect(result!.skipped).toHaveLength(1);
      expect(result!.skipped[0]?.reason).toBe('not-found');
      // A8: structured warning emitted
      const messages = warnSpy.mock.calls.map((c) => String(c[0]));
      expect(messages.some((m) => m.includes('skill:load-skipped'))).toBe(true);
    } finally {
      console.warn = original;
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test('reload-on-call: changing skills.json mid-session takes effect on next call', () => {
    const ws = freshWorkspace();
    try {
      const ts = makeSkill('typescript-coding');
      const py = makeSkill('python-coding');
      const reg = loadAgentRegistry(ws, undefined, undefined, {
        skillResolver: makeResolver([ts, py]),
      });
      // initially no bindings
      expect(reg.getDerivedCapabilities('developer')!.loadedSkills).toHaveLength(0);
      // bind one
      saveBoundSkills(ws, 'developer', [{ id: 'typescript-coding' }]);
      expect(reg.getDerivedCapabilities('developer')!.loadedSkills.map((s) => s.frontmatter.id)).toEqual([
        'typescript-coding',
      ]);
      // bind another
      saveBoundSkills(ws, 'developer', [{ id: 'typescript-coding' }, { id: 'python-coding' }]);
      expect(reg.getDerivedCapabilities('developer')!.loadedSkills).toHaveLength(2);
      // unbind
      saveBoundSkills(ws, 'developer', []);
      expect(reg.getDerivedCapabilities('developer')!.loadedSkills).toHaveLength(0);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});
