/**
 * Gap-fix integration tests — verify the Phase-1/2/3 wiring is alive.
 *
 * Pre-fix audit found that effective-trust scoring, derived-capability flow,
 * and skill-narrowed ACL were dead code (schema present, no caller). These
 * tests prove the wiring now reaches the runtime decision points.
 */
import { Database } from 'bun:sqlite';
import { describe, expect, mock, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SKILL_OUTCOME_SCHEMA_SQL } from '../../src/db/skill-outcome-schema.ts';
import { recordSkillOutcomesFromBid, SkillOutcomeStore } from '../../src/db/skill-outcome-store.ts';
import type { SyncSkillResolver } from '../../src/orchestrator/agents/derive-persona-capabilities.ts';
import { saveBoundSkills } from '../../src/orchestrator/agents/persona-skill-loader.ts';
import { loadAgentRegistry } from '../../src/orchestrator/agents/registry.ts';
import { scoreFit } from '../../src/orchestrator/capabilities/capability-router.ts';
import {
  buildAgentCapabilityProfile,
  buildAgentCapabilityProfilesFromRegistry,
} from '../../src/orchestrator/capabilities/profile-adapter.ts';
import { effectiveTrust } from '../../src/orchestrator/capability-trust.ts';
import type { AgentSpec, CapabilityRequirement, SkillRef } from '../../src/orchestrator/types.ts';
import type { SkillMdRecord } from '../../src/skills/skill-md/index.ts';

function makeAgent(overrides: Partial<AgentSpec> & { id: string }): AgentSpec {
  return { name: overrides.id, description: '', ...overrides };
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

describe('G1 — capability-router fit scoring uses effectiveTrust', () => {
  test('mature evolved claim outranks curated builtin claim at the fit-score level', () => {
    const reqs: CapabilityRequirement[] = [{ id: 'cap.x', weight: 1, source: 'fingerprint' }];
    const builtinAgent = makeAgent({
      id: 'builtin-claim',
      capabilities: [{ id: 'cap.x', evidence: 'builtin', confidence: 0.95 }],
    });
    const evolvedAgent = makeAgent({
      id: 'evolved-claim',
      capabilities: [{ id: 'cap.x', evidence: 'evolved', confidence: 0.7 }],
    });
    const builtinFit = scoreFit(builtinAgent, reqs);
    const evolvedFit = scoreFit(evolvedAgent, reqs);
    // 'evolved' (heuristic default, evidence_weight 1.0) beats 'builtin' (heuristic, evidence_weight 0.7)
    expect(evolvedFit.fitScore).toBeGreaterThan(builtinFit.fitScore);
  });

  test('inferred claim ranks below builtin at the fit-score level', () => {
    const reqs: CapabilityRequirement[] = [{ id: 'cap.x', weight: 1, source: 'fingerprint' }];
    const inferredAgent = makeAgent({
      id: 'inferred-claim',
      capabilities: [{ id: 'cap.x', evidence: 'inferred', confidence: 0.4 }],
    });
    const builtinAgent = makeAgent({
      id: 'builtin-claim',
      capabilities: [{ id: 'cap.x', evidence: 'builtin', confidence: 0.7 }],
    });
    expect(scoreFit(builtinAgent, reqs).fitScore).toBeGreaterThan(scoreFit(inferredAgent, reqs).fitScore);
  });
});

describe('G2 — profile-adapter accepts derived capabilities + ACL', () => {
  test('derived claims win over raw spec claims when both supplied', () => {
    const agent = makeAgent({
      id: 'p',
      capabilities: [{ id: 'spec.cap', evidence: 'builtin', confidence: 0.9 }],
    });
    const profile = buildAgentCapabilityProfile(agent, {
      derived: {
        capabilities: [{ id: 'derived.cap', evidence: 'evolved', confidence: 0.7 }],
        effectiveAcl: { network: false },
        loadedSkills: [],
        resolvedRefs: [],
        skipped: [],
      },
    });
    expect(profile.claims.map((c) => c.id)).toEqual(['derived.cap']);
    expect(profile.acl.network).toBe(false);
  });

  test('without derived: falls back to spec capabilities + capabilityOverrides', () => {
    const agent = makeAgent({
      id: 'p',
      capabilities: [{ id: 'spec.cap', evidence: 'builtin', confidence: 0.9 }],
      capabilityOverrides: { network: true },
    });
    const profile = buildAgentCapabilityProfile(agent);
    expect(profile.claims.map((c) => c.id)).toEqual(['spec.cap']);
    expect(profile.acl.network).toBe(true);
  });

  test('buildAgentCapabilityProfilesFromRegistry threads derivation per agent', () => {
    const ws = mkdtempSync(join(tmpdir(), 'vinyan-gap-'));
    try {
      const skill = makeSkill('typescript-coding', {
        provides_capabilities: [{ id: 'code.mutation.ts', file_extensions: ['.ts'] }],
      });
      saveBoundSkills(ws, 'developer', [{ id: 'typescript-coding' }]);
      const reg = loadAgentRegistry(ws, undefined, undefined, { skillResolver: makeResolver([skill]) });
      const profiles = buildAgentCapabilityProfilesFromRegistry(reg.listAgents(), (id) =>
        reg.getDerivedCapabilities(id),
      );
      const dev = profiles.find((p) => p.id === 'developer');
      expect(dev).toBeDefined();
      // Skill-derived claim is now visible to the router
      expect(dev!.claims.some((c) => c.id === 'code.mutation.ts')).toBe(true);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});

describe('G3 — derived ACL composition feeds the agent contract', () => {
  test('skill ACL narrowing reaches getDerivedCapabilities.effectiveAcl', () => {
    const ws = mkdtempSync(join(tmpdir(), 'vinyan-gap-'));
    try {
      const skill = makeSkill('locked-skill', { acl: { network: false } });
      saveBoundSkills(ws, 'developer', [{ id: 'locked-skill' }]);
      const reg = loadAgentRegistry(ws, undefined, undefined, { skillResolver: makeResolver([skill]) });
      const derived = reg.getDerivedCapabilities('developer');
      // developer doesn't declare network in its built-in ACL, so the skill
      // narrowing introduces a concrete `false`.
      expect(derived?.effectiveAcl.network).toBe(false);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});

describe('G4 — recordSkillOutcomesFromBid wires settlement → outcome store', () => {
  function makeStore(): SkillOutcomeStore {
    const db = new Database(':memory:');
    db.exec(SKILL_OUTCOME_SCHEMA_SQL);
    return new SkillOutcomeStore(db);
  }

  test('persona-aware bid → one outcome row per loaded skill', () => {
    const store = makeStore();
    const recorded = recordSkillOutcomesFromBid(
      store,
      { personaId: 'developer', loadedSkillIds: ['ts-coding', 'react-patterns'] },
      'refactor::ts',
      'success',
      undefined,
      1000,
    );
    expect(recorded).toBe(2);
    const ts = store.getOutcome({ personaId: 'developer', skillId: 'ts-coding', taskSignature: 'refactor::ts' });
    expect(ts!.successes).toBe(1);
    const react = store.getOutcome({
      personaId: 'developer',
      skillId: 'react-patterns',
      taskSignature: 'refactor::ts',
    });
    expect(react!.successes).toBe(1);
  });

  test('legacy bid (no personaId) → no-op, no rows recorded', () => {
    const store = makeStore();
    const recorded = recordSkillOutcomesFromBid(store, {}, 'whatever', 'success');
    expect(recorded).toBe(0);
    expect(store.listForSkill('any')).toHaveLength(0);
  });
});

describe('G5 — soul lint throws for shipped built-in violations, warns for user-authored', () => {
  test('user-authored disk soul violation: warn only, registry still loads', () => {
    const ws = mkdtempSync(join(tmpdir(), 'vinyan-gap-'));
    const warnSpy = mock((..._args: unknown[]) => {});
    const original = console.warn;
    console.warn = warnSpy;
    try {
      // Write a soul that violates A1 from a non-Reviewer persona — disk override
      const { mkdirSync, writeFileSync } = require('node:fs');
      mkdirSync(join(ws, '.vinyan', 'souls'), { recursive: true });
      writeFileSync(join(ws, '.vinyan', 'souls', 'developer.soul.md'), 'I check my work twice.', 'utf-8');
      // Should NOT throw (user-authored override)
      expect(() => loadAgentRegistry(ws, undefined)).not.toThrow();
      const messages = warnSpy.mock.calls.map((c) => String(c[0]));
      expect(messages.some((m) => m.includes('agent:soul-lint') && m.includes('developer'))).toBe(true);
    } finally {
      console.warn = original;
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test('effectiveTrust default tier is now evidence-aware (regression guard)', () => {
    // Smoke-test: builtin claim should not score at speculative-tier levels anymore.
    const builtin = effectiveTrust({ id: 'x', evidence: 'builtin', confidence: 0.8 });
    // With heuristic default tier (TIER_WEIGHT 0.7) × 0.8 × 0.7 = 0.392
    // Pre-fix would have been 0.15 × 0.8 × 0.7 = 0.084
    expect(builtin).toBeGreaterThan(0.3);
  });
});
