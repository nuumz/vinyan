/**
 * Tests for `buildPersonaBidContext` — Phase-4 wiring activation.
 *
 * Covers:
 *   - returns null when agentId is undefined or registry has no derivation
 *   - returns null when persona has no loaded skills (legacy bid pass-through)
 *   - skillFingerprint is sha256 hex, deterministic, independent of bind order
 *   - skillTokenOverhead approximates rendered card chars / 4
 *   - declaredCapabilityIds includes both persona builtin claims and skill-derived
 *   - requiredCapabilities pass-through
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SyncSkillResolver } from '../../../src/orchestrator/agents/derive-persona-capabilities.ts';
import {
  buildPersonaBidContext,
  computeSkillFingerprint,
  estimateSkillTokenOverhead,
} from '../../../src/orchestrator/agents/persona-context-builder.ts';
import { saveBoundSkills } from '../../../src/orchestrator/agents/persona-skill-loader.ts';
import { loadAgentRegistry } from '../../../src/orchestrator/agents/registry.ts';
import type { CapabilityRequirement, SkillRef } from '../../../src/orchestrator/types.ts';
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
    contentHash: 'sha256:' + '0'.repeat(64),
  };
}

function makeResolver(skills: SkillMdRecord[]): SyncSkillResolver {
  const map = new Map<string, SkillMdRecord>(skills.map((s) => [s.frontmatter.id, s]));
  return { resolve: (ref: SkillRef) => map.get(ref.id) ?? null };
}

describe('computeSkillFingerprint', () => {
  test('empty list gets a sentinel fingerprint', () => {
    expect(computeSkillFingerprint([])).toBe('sha256:empty');
  });

  test('order-independent: same skills different order → same fingerprint', () => {
    const a = computeSkillFingerprint(['c', 'a', 'b']);
    const b = computeSkillFingerprint(['a', 'b', 'c']);
    expect(a).toBe(b);
  });

  test('different skill sets → different fingerprints', () => {
    expect(computeSkillFingerprint(['a', 'b'])).not.toBe(computeSkillFingerprint(['a', 'c']));
  });

  test('format is sha256:<64 hex chars>', () => {
    const fp = computeSkillFingerprint(['ts-coding']);
    expect(fp).toMatch(/^sha256:[a-f0-9]{64}$/);
  });
});

describe('estimateSkillTokenOverhead', () => {
  test('empty cards → 0 tokens', () => {
    expect(estimateSkillTokenOverhead([])).toBe(0);
  });

  test('overhead grows with card count', () => {
    const skill = makeSkill('a');
    const view = {
      source: 'local:a@1.0.0',
      hash: skill.contentHash,
      tier: skill.frontmatter.confidence_tier,
      status: skill.frontmatter.status,
      body: 'short body',
    };
    const one = estimateSkillTokenOverhead([view]);
    const two = estimateSkillTokenOverhead([view, view]);
    expect(two).toBeGreaterThan(one);
  });
});

describe('buildPersonaBidContext', () => {
  function freshRegistry(skills: SkillMdRecord[], boundIds: string[]) {
    const ws = mkdtempSync(join(tmpdir(), 'vinyan-pcb-'));
    if (boundIds.length > 0) {
      saveBoundSkills(
        ws,
        'developer',
        boundIds.map((id) => ({ id })),
      );
    }
    const reg = loadAgentRegistry(ws, undefined, undefined, { skillResolver: makeResolver(skills) });
    return { reg, cleanup: () => rmSync(ws, { recursive: true, force: true }) };
  }

  test('returns null when agentId is undefined', () => {
    const { reg, cleanup } = freshRegistry([], []);
    try {
      expect(buildPersonaBidContext(reg, undefined)).toBeNull();
    } finally {
      cleanup();
    }
  });

  test('returns null when persona has no loaded skills (legacy pass-through)', () => {
    const { reg, cleanup } = freshRegistry([], []);
    try {
      expect(buildPersonaBidContext(reg, 'developer')).toBeNull();
    } finally {
      cleanup();
    }
  });

  test('returns null when agentId is unknown', () => {
    const { reg, cleanup } = freshRegistry([], []);
    try {
      expect(buildPersonaBidContext(reg, 'nonexistent')).toBeNull();
    } finally {
      cleanup();
    }
  });

  test('builds full context for persona with bound skills', () => {
    const skill = makeSkill('typescript-coding', {
      provides_capabilities: [{ id: 'code.mutation.ts', file_extensions: ['.ts'] }],
    });
    const { reg, cleanup } = freshRegistry([skill], ['typescript-coding']);
    try {
      const ctx = buildPersonaBidContext(reg, 'developer');
      expect(ctx).not.toBeNull();
      expect(ctx!.personaId).toBe('developer');
      expect(ctx!.loadedSkillIds).toEqual(['typescript-coding']);
      expect(ctx!.declaredCapabilityIds).toContain('code.mutation.ts');
      // developer also has builtin claim 'code.mutation' from its persona spec
      expect(ctx!.declaredCapabilityIds.length).toBeGreaterThan(1);
      expect(ctx!.skillFingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
      expect(ctx!.skillTokenOverhead ?? 0).toBeGreaterThan(0);
    } finally {
      cleanup();
    }
  });

  test('forwards required capabilities verbatim', () => {
    const skill = makeSkill('typescript-coding');
    const { reg, cleanup } = freshRegistry([skill], ['typescript-coding']);
    try {
      const required: CapabilityRequirement[] = [{ id: 'code.mutation', weight: 1, source: 'fingerprint' }];
      const ctx = buildPersonaBidContext(reg, 'developer', required);
      expect(ctx?.requiredCapabilities).toEqual([{ id: 'code.mutation', weight: 1 }]);
    } finally {
      cleanup();
    }
  });
});
