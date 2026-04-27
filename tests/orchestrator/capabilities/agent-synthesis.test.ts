/**
 * agent-synthesis tests — task-scoped synthetic agents (Phase B).
 *
 * Verifies:
 *   - planFromGap derives a plan from unmet requirements only
 *   - planFromGap returns null when nothing to synthesize
 *   - synthesizeAgent builds a strict-ACL spec
 *   - id is stable for identical inputs
 *   - capabilities carry evidence='synthesized' confidence=0.5
 *   - registry registerAgent rejects builtin overwrites & double-registration
 *   - registry sweeps synthetic agents by taskId
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadAgentRegistry } from '../../../src/orchestrator/agents/registry.ts';
import {
  planFromGap,
  synthesizeAgent,
} from '../../../src/orchestrator/capabilities/agent-synthesis.ts';
import type {
  CapabilityFit,
  CapabilityGapAnalysis,
  CapabilityRequirement,
} from '../../../src/orchestrator/types.ts';

function req(id: string, weight = 1, role?: string): CapabilityRequirement {
  return { id, weight, role, source: 'llm-extract' };
}

function fit(agentId: string, fitScore: number, matchedIds: string[] = []): CapabilityFit {
  return {
    agentId,
    fitScore,
    matched: matchedIds.map((id) => ({ id, weight: 1, confidence: 0.9 })),
    gap: [],
  };
}

function makeAnalysis(overrides?: Partial<CapabilityGapAnalysis>): CapabilityGapAnalysis {
  return {
    taskId: 't-1',
    required: [req('research.web'), req('writing.summary')],
    candidates: [fit('best', 0.0, [])],
    gapNormalized: 1,
    recommendedAction: 'synthesize',
    ...overrides,
  };
}

describe('planFromGap', () => {
  test('returns null when recommendedAction is proceed', () => {
    const a = makeAnalysis({ recommendedAction: 'proceed' });
    expect(planFromGap('t-1', a)).toBeNull();
  });

  test('returns null when required is empty', () => {
    const a = makeAnalysis({ required: [], recommendedAction: 'fallback' });
    expect(planFromGap('t-1', a)).toBeNull();
  });

  test('returns null when every requirement is matched by best candidate', () => {
    const a = makeAnalysis({
      recommendedAction: 'research',
      candidates: [fit('best', 1, ['research.web', 'writing.summary'])],
    });
    expect(planFromGap('t-1', a)).toBeNull();
  });

  test('builds claims for unmet requirements only', () => {
    const a = makeAnalysis({
      required: [req('research.web'), req('writing.summary'), req('design.api')],
      candidates: [fit('best', 0.4, ['design.api'])],
      recommendedAction: 'synthesize',
    });
    const plan = planFromGap('t-1', a);
    expect(plan).not.toBeNull();
    const ids = plan!.capabilities.map((c) => c.id).sort();
    expect(ids).toEqual(['research.web', 'writing.summary']);
    for (const c of plan!.capabilities) {
      expect(c.evidence).toBe('synthesized');
      expect(c.confidence).toBe(0.5);
    }
  });

  test('aggregates roles from requirement role hints + caller hints', () => {
    const a = makeAnalysis({
      required: [req('research.web', 1, 'researcher'), req('writing.summary', 1, 'editor')],
      candidates: [fit('best', 0)],
    });
    const plan = planFromGap('t-1', a, { rolesHint: ['planner'] });
    expect(plan!.roles.sort()).toEqual(['editor', 'planner', 'researcher']);
  });

  test('produces a stable suggestedId for identical inputs', () => {
    const a = makeAnalysis();
    const p1 = planFromGap('t-1', a);
    const p2 = planFromGap('t-1', a);
    expect(p1!.suggestedId).toBe(p2!.suggestedId);
    expect(p1!.suggestedId.startsWith('synthetic-')).toBe(true);
  });

  test('different taskIds produce different ids', () => {
    const a = makeAnalysis();
    const p1 = planFromGap('t-1', a);
    const p2 = planFromGap('t-2', a);
    expect(p1!.suggestedId).not.toBe(p2!.suggestedId);
  });
});

describe('synthesizeAgent', () => {
  test('builds a non-builtin spec with strict-ACL defaults', () => {
    const a = makeAnalysis();
    const plan = planFromGap('t-1', a)!;
    const spec = synthesizeAgent(plan);
    expect(spec.id).toBe(plan.suggestedId);
    expect(spec.builtin).toBe(false);
    expect(spec.capabilityOverrides?.writeAny).toBe(false);
    expect(spec.capabilityOverrides?.network).toBe(false);
    expect(spec.capabilityOverrides?.shell).toBe(false);
    expect(spec.capabilityOverrides?.readAny).toBe(true);
    // default allowedTools are read-only / scratch
    expect(spec.allowedTools).toEqual(['file_read', 'search_grep', 'directory_list']);
  });

  test('caps the number of synthesized claims', () => {
    const reqs: CapabilityRequirement[] = [];
    for (let i = 0; i < 12; i++) reqs.push(req(`cap.${i}`));
    const a = makeAnalysis({ required: reqs, candidates: [fit('best', 0)] });
    const plan = planFromGap('t-1', a)!;
    expect(plan.capabilities.length).toBe(12);
    const spec = synthesizeAgent(plan, { maxClaims: 4 });
    expect(spec.capabilities!.length).toBe(4);
  });

  test('soul mentions every claimed capability and the rationale', () => {
    const a = makeAnalysis();
    const plan = planFromGap('t-1', a, { goal: 'summarize a research paper' })!;
    const spec = synthesizeAgent(plan);
    expect(spec.soul).toContain('research.web');
    expect(spec.soul).toContain('writing.summary');
    expect(spec.soul).toContain('Rationale');
    expect(spec.soul).toContain('summarize a research paper');
  });

  test('roles propagate from plan onto spec.roles', () => {
    const a = makeAnalysis({
      required: [req('research.web', 1, 'researcher')],
      candidates: [fit('best', 0)],
    });
    const plan = planFromGap('t-1', a)!;
    const spec = synthesizeAgent(plan);
    expect(spec.roles).toEqual(['researcher']);
  });
});

function setupRegistry() {
  const workspace = mkdtempSync(join(tmpdir(), 'vinyan-synth-'));
  const registry = loadAgentRegistry(workspace, undefined);
  return { workspace, registry, cleanup: () => rmSync(workspace, { recursive: true, force: true }) };
}

describe('AgentRegistry mutation (synthesis support)', () => {
  test('registerAgent stores a synthetic spec retrievable via getAgent/has', () => {
    const { registry, cleanup } = setupRegistry();
    try {
      const a = makeAnalysis();
      const plan = planFromGap('t-1', a)!;
      const spec = synthesizeAgent(plan);
      registry.registerAgent(spec, { taskId: 't-1' });
      expect(registry.has(spec.id)).toBe(true);
      expect(registry.getAgent(spec.id)?.builtin).toBe(false);
    } finally {
      cleanup();
    }
  });

  test('registerAgent refuses to overwrite a builtin id', () => {
    const { registry, cleanup } = setupRegistry();
    try {
      const a = makeAnalysis();
      const plan = planFromGap('t-1', a)!;
      const spec = { ...synthesizeAgent(plan), id: 'ts-coder' };
      expect(() => registry.registerAgent(spec)).toThrow(/protected/);
    } finally {
      cleanup();
    }
  });

  test('registerAgent refuses double-registration of the same id', () => {
    const { registry, cleanup } = setupRegistry();
    try {
      const a = makeAnalysis();
      const plan = planFromGap('t-1', a)!;
      const spec = synthesizeAgent(plan);
      registry.registerAgent(spec, { taskId: 't-1' });
      expect(() => registry.registerAgent(spec, { taskId: 't-1' })).toThrow(/already registered/);
    } finally {
      cleanup();
    }
  });

  test('registerAgent refuses builtin=true', () => {
    const { registry, cleanup } = setupRegistry();
    try {
      const a = makeAnalysis();
      const plan = planFromGap('t-1', a)!;
      const spec = { ...synthesizeAgent(plan), builtin: true };
      expect(() => registry.registerAgent(spec)).toThrow(/builtin=true/);
    } finally {
      cleanup();
    }
  });

  test('unregisterAgent removes a synthetic and ignores protected ids', () => {
    const { registry, cleanup } = setupRegistry();
    try {
      const a = makeAnalysis();
      const plan = planFromGap('t-1', a)!;
      const spec = synthesizeAgent(plan);
      registry.registerAgent(spec, { taskId: 't-1' });
      expect(registry.unregisterAgent(spec.id)).toBe(true);
      expect(registry.has(spec.id)).toBe(false);
      // builtin id is left alone
      expect(registry.unregisterAgent('ts-coder')).toBe(false);
      expect(registry.has('ts-coder')).toBe(true);
    } finally {
      cleanup();
    }
  });

  test('unregisterAgentsForTask sweeps only that task and is idempotent', () => {
    const { registry, cleanup } = setupRegistry();
    try {
      const a = makeAnalysis();
      const planA = planFromGap('t-1', a)!;
      const planB = planFromGap('t-2', a)!;
      const specA = synthesizeAgent(planA);
      const specB = synthesizeAgent(planB);
      registry.registerAgent(specA, { taskId: 't-1' });
      registry.registerAgent(specB, { taskId: 't-2' });

      const removed = registry.unregisterAgentsForTask('t-1');
      expect(removed).toEqual([specA.id]);
      expect(registry.has(specA.id)).toBe(false);
      expect(registry.has(specB.id)).toBe(true);

      // idempotent
      expect(registry.unregisterAgentsForTask('t-1')).toEqual([]);
    } finally {
      cleanup();
    }
  });
});
