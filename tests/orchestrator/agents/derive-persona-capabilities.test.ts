/**
 * Tests for `derivePersonaCapabilities` — Phase 2 capability + ACL composition.
 *
 * Covers:
 *   - skillToClaims: provides_capabilities path and default-claim fallback
 *   - deriveEvidence: status × origin → CapabilityEvidence mapping (A5)
 *   - composeAcl: skill ACL only narrows, never widens (A6)
 *   - derivePersonaCapabilities end-to-end: load order, dedupe, missing skill (A9)
 *   - renderSkillCard: integrity envelope, MAX_SKILL_CARD_CHARS skip behaviour
 */
import { describe, expect, test } from 'bun:test';
import {
  composeAcl,
  deriveEvidence,
  derivePersonaCapabilities,
  MAX_SKILL_CARD_CHARS,
  renderSkillCard,
  type SyncSkillResolver,
  skillToClaims,
  toSkillCardView,
} from '../../../src/orchestrator/agents/derive-persona-capabilities.ts';
import type { AgentSpec, SkillRef } from '../../../src/orchestrator/types.ts';
import type { SkillMdFrontmatter, SkillMdRecord } from '../../../src/skills/skill-md/index.ts';

function makeFrontmatter(overrides: Partial<SkillMdFrontmatter> = {}): SkillMdFrontmatter {
  return {
    id: 'fixture-skill',
    name: 'Fixture',
    version: '1.0.0',
    description: 'fixture',
    requires_toolsets: [],
    fallback_for_toolsets: [],
    confidence_tier: 'heuristic',
    origin: 'local',
    declared_oracles: [],
    falsifiable_by: [],
    status: 'active',
    ...overrides,
  };
}

function makeSkill(overrides: Partial<SkillMdFrontmatter> = {}, bodyText = 'overview text'): SkillMdRecord {
  return {
    frontmatter: makeFrontmatter(overrides),
    body: {
      overview: bodyText,
      whenToUse: 'use it when fixture',
      procedure: '1. step one',
    },
    contentHash: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
  };
}

function makeResolver(skills: Record<string, SkillMdRecord>): SyncSkillResolver {
  return {
    resolve: (ref: SkillRef) => skills[ref.id] ?? null,
  };
}

function makePersona(overrides: Partial<AgentSpec> = {}): AgentSpec {
  return {
    id: 'developer',
    name: 'Developer',
    description: 'gen',
    role: 'developer',
    capabilities: [{ id: 'code.mutation', evidence: 'builtin', confidence: 0.8 }],
    ...overrides,
  };
}

describe('deriveEvidence', () => {
  test('active local skill is builtin (curated)', () => {
    expect(deriveEvidence(makeFrontmatter({ status: 'active', origin: 'local' }))).toBe('builtin');
  });

  test('active hub/a2a/mcp skill is synthesized (external, verified)', () => {
    expect(deriveEvidence(makeFrontmatter({ status: 'active', origin: 'hub' }))).toBe('synthesized');
    expect(deriveEvidence(makeFrontmatter({ status: 'active', origin: 'a2a' }))).toBe('synthesized');
    expect(deriveEvidence(makeFrontmatter({ status: 'active', origin: 'mcp' }))).toBe('synthesized');
  });

  test('probation status downgrades to synthesized regardless of origin', () => {
    expect(deriveEvidence(makeFrontmatter({ status: 'probation', origin: 'local' }))).toBe('synthesized');
  });

  test('demoted/retired/quarantined fall to inferred (caller should skip-load)', () => {
    expect(deriveEvidence(makeFrontmatter({ status: 'demoted' }))).toBe('inferred');
    expect(deriveEvidence(makeFrontmatter({ status: 'retired' }))).toBe('inferred');
    expect(deriveEvidence(makeFrontmatter({ status: 'quarantined' }))).toBe('inferred');
  });
});

describe('skillToClaims', () => {
  test('default minimal claim when provides_capabilities is absent', () => {
    const claims = skillToClaims(makeSkill({ id: 'foo' }));
    expect(claims).toHaveLength(1);
    expect(claims[0]?.id).toBe('skill.foo');
    expect(claims[0]?.evidence).toBe('builtin');
  });

  test('emits one claim per provides_capabilities entry with derived evidence', () => {
    const claims = skillToClaims(
      makeSkill({
        provides_capabilities: [
          { id: 'code.mutation.ts', file_extensions: ['.ts'] },
          { id: 'code.testing.ts', action_verbs: ['test'] },
        ],
      }),
    );
    expect(claims).toHaveLength(2);
    expect(claims[0]?.id).toBe('code.mutation.ts');
    expect(claims[0]?.fileExtensions).toEqual(['.ts']);
    expect(claims[1]?.id).toBe('code.testing.ts');
    expect(claims[1]?.actionVerbs).toEqual(['test']);
  });

  test('confidence tracks confidence_tier ceiling', () => {
    const det = skillToClaims(
      makeSkill({
        confidence_tier: 'deterministic',
        content_hash: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
      }),
    );
    const spec = skillToClaims(makeSkill({ confidence_tier: 'speculative' }));
    expect(det[0]!.confidence).toBeGreaterThan(spec[0]!.confidence);
  });
});

describe('composeAcl', () => {
  test('skill network=true does NOT widen persona network=false', () => {
    const persona = { network: false };
    const skill = makeSkill({ acl: { network: true } });
    expect(composeAcl(persona, [skill]).network).toBe(false);
  });

  test('skill network=false narrows permissive persona', () => {
    const persona = { network: true };
    const skill = makeSkill({ acl: { network: false } });
    expect(composeAcl(persona, [skill]).network).toBe(false);
  });

  test('skill without acl leaves persona ACL unchanged', () => {
    const persona = { network: true, shell: true };
    const skill = makeSkill({});
    expect(composeAcl(persona, [skill])).toEqual({ network: true, shell: true });
  });

  test('multi-skill intersection: any false wins', () => {
    const persona = { network: true, shell: true, writeAny: true };
    const a = makeSkill({ id: 'a', acl: { network: false } });
    const b = makeSkill({ id: 'b', acl: { shell: false } });
    const result = composeAcl(persona, [a, b]);
    expect(result.network).toBe(false);
    expect(result.shell).toBe(false);
    // writeAny was untouched by either skill
    expect(result.writeAny).toBe(true);
  });

  test('undefined persona ACL with skill narrowing produces concrete false', () => {
    const skill = makeSkill({ acl: { shell: false } });
    expect(composeAcl(undefined, [skill]).shell).toBe(false);
  });
});

describe('derivePersonaCapabilities', () => {
  test('combines persona builtin claims with skill-derived claims', () => {
    const persona = makePersona();
    const skill = makeSkill({
      id: 'typescript-coding',
      provides_capabilities: [{ id: 'code.mutation.ts', file_extensions: ['.ts'] }],
    });
    const resolver = makeResolver({ 'typescript-coding': skill });
    const refs: SkillRef[] = [{ id: 'typescript-coding' }];
    const result = derivePersonaCapabilities(persona, refs, resolver);
    expect(result.capabilities.map((c) => c.id).sort()).toEqual(['code.mutation', 'code.mutation.ts']);
    expect(result.loadedSkills).toHaveLength(1);
  });

  test('missing skill is collected into skipped[] without throwing (A9)', () => {
    const persona = makePersona();
    const resolver = makeResolver({});
    const refs: SkillRef[] = [{ id: 'absent-skill' }];
    const result = derivePersonaCapabilities(persona, refs, resolver);
    expect(result.loadedSkills).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]?.reason).toBe('not-found');
  });

  test('content_hash mismatch is skipped with pin-mismatch reason (A4)', () => {
    const persona = makePersona();
    const skill = makeSkill({ id: 'pinned-skill', content_hash: 'sha256:' + 'a'.repeat(64) });
    const resolver = makeResolver({ 'pinned-skill': skill });
    const refs: SkillRef[] = [{ id: 'pinned-skill', contentHash: 'sha256:' + 'b'.repeat(64) }];
    const result = derivePersonaCapabilities(persona, refs, resolver);
    expect(result.loadedSkills).toHaveLength(0);
    expect(result.skipped[0]?.reason).toBe('pin-mismatch');
  });

  test('demoted skills are skipped', () => {
    const persona = makePersona();
    const skill = makeSkill({ id: 'demoted-skill', status: 'demoted' });
    const resolver = makeResolver({ 'demoted-skill': skill });
    const result = derivePersonaCapabilities(persona, [{ id: 'demoted-skill' }], resolver);
    expect(result.loadedSkills).toHaveLength(0);
    expect(result.skipped[0]?.reason).toBe('demoted');
  });

  test('claims dedupe by id — later skill replaces earlier persona claim', () => {
    const persona = makePersona({
      capabilities: [{ id: 'code.mutation', evidence: 'builtin', confidence: 0.7, label: 'persona-version' }],
    });
    const skill = makeSkill({
      provides_capabilities: [{ id: 'code.mutation', label: 'skill-version' }],
    });
    const resolver = makeResolver({ 'fixture-skill': skill });
    const result = derivePersonaCapabilities(persona, [{ id: 'fixture-skill' }], resolver);
    const claim = result.capabilities.find((c) => c.id === 'code.mutation');
    expect(claim?.label).toBe('skill-version');
  });

  test('load order is tier desc then id asc (deterministic)', () => {
    const persona = makePersona();
    const probabilistic = makeSkill({ id: 'b-prob', confidence_tier: 'probabilistic' });
    const heuristic = makeSkill({ id: 'a-heur', confidence_tier: 'heuristic' });
    const deterministic = makeSkill({
      id: 'c-det',
      confidence_tier: 'deterministic',
      content_hash: 'sha256:' + '0'.repeat(64),
    });
    const resolver = makeResolver({
      'b-prob': probabilistic,
      'a-heur': heuristic,
      'c-det': deterministic,
    });
    const result = derivePersonaCapabilities(persona, [{ id: 'b-prob' }, { id: 'a-heur' }, { id: 'c-det' }], resolver);
    expect(result.loadedSkills.map((s) => s.frontmatter.id)).toEqual(['c-det', 'a-heur', 'b-prob']);
  });

  test('persona ACL is the floor — composition with skills narrows but never widens', () => {
    const persona = makePersona({ capabilityOverrides: { network: false, shell: false } });
    // Skill ACL fields are snake_case (mirrors SKILL.md frontmatter convention).
    const greedySkill = makeSkill({ acl: { network: true, shell: true, write_any: false } });
    const resolver = makeResolver({ 'fixture-skill': greedySkill });
    const result = derivePersonaCapabilities(persona, [{ id: 'fixture-skill' }], resolver);
    // skill cannot widen
    expect(result.effectiveAcl.network).toBe(false);
    expect(result.effectiveAcl.shell).toBe(false);
    // skill can narrow (write_any → writeAny on the AgentCapabilityOverrides side)
    expect(result.effectiveAcl.writeAny).toBe(false);
  });
});

describe('renderSkillCard', () => {
  test('emits envelope with hash + tier + source', () => {
    const view = toSkillCardView(
      makeSkill({
        id: 'foo',
        confidence_tier: 'deterministic',
        content_hash: 'sha256:' + '1'.repeat(64),
      }),
    );
    const text = renderSkillCard(view);
    expect(text).not.toBeNull();
    expect(text!).toContain('<skill-card');
    expect(text!).toContain('hash="sha256:');
    expect(text!).toContain('tier="deterministic"');
    expect(text!).toContain('source="local:foo@1.0.0"');
    expect(text!.endsWith('</skill-card>')).toBe(true);
  });

  test('returns null when card exceeds MAX_SKILL_CARD_CHARS (whole-block-or-skip)', () => {
    const huge = 'x'.repeat(MAX_SKILL_CARD_CHARS);
    const view = toSkillCardView(makeSkill({ description: huge }));
    expect(renderSkillCard(view)).toBeNull();
  });

  test('hash="unsigned" when content_hash is absent', () => {
    const view = toSkillCardView(makeSkill({ content_hash: undefined }));
    const text = renderSkillCard(view);
    expect(text).not.toBeNull();
    expect(text!).toContain('hash="unsigned"');
  });
});
