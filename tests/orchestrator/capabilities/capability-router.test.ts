/**
 * Capability Router internals — `scoreFit` + `analyzeFit`.
 *
 * Covers:
 *   - Exact id match → fitScore reflects claim confidence × weight
 *   - Dimension overlap (e.g. extension only) yields partial score
 *   - Role match in `agent.roles` short-circuits to 1.0
 *   - Missing requirements appear in `gap`, not `matched`
 *   - `analyzeFit` ranks candidates and emits a `recommendedAction`:
 *     proceed (small gap), research (mid gap), synthesize (large/no fit)
 */
import { describe, expect, test } from 'bun:test';
import {
  analyzeFit,
  analyzeProfileFit,
  scoreFit,
  scoreProfile,
} from '../../../src/orchestrator/capabilities/capability-router.ts';
import { buildAgentCapabilityProfile } from '../../../src/orchestrator/capabilities/profile-adapter.ts';
import type { AgentSpec, CapabilityRequirement } from '../../../src/orchestrator/types.ts';

function makeAgent(overrides: Partial<AgentSpec> & { id: string }): AgentSpec {
  return {
    name: overrides.id,
    description: '',
    ...overrides,
  };
}

describe('scoreFit', () => {
  test('exact id match scores effectiveTrust(claim) × overlap × req.weight', () => {
    const agent = makeAgent({
      id: 'a',
      capabilities: [{ id: 'code.refactor.ts', evidence: 'builtin', confidence: 0.9 }],
    });
    const reqs: CapabilityRequirement[] = [{ id: 'code.refactor.ts', weight: 0.5, source: 'llm-extract' }];
    const fit = scoreFit(agent, reqs);
    expect(fit.matched).toHaveLength(1);
    expect(fit.gap).toHaveLength(0);
    // Phase-1 fix: fitScore now uses effectiveTrust, not raw confidence.
    // For builtin evidence + confidence 0.9: tier defaults to 'heuristic' (0.7),
    //   evidence_weight['builtin'] = 0.7, wilson cold-start uses static
    //   confidence so wilson = max(0.5, 0.9) = 0.9.
    //   effectiveTrust = 0.7 × 0.9 × 0.7 = 0.441; × overlap 1 × weight 0.5 = 0.2205.
    expect(fit.fitScore).toBeCloseTo(0.441 * 0.5, 3);
  });

  test('extension-only requirement matches a claim that declares the extension', () => {
    const agent = makeAgent({
      id: 'a',
      capabilities: [
        {
          id: 'code.mutation.ts',
          fileExtensions: ['.ts', '.tsx'],
          domains: ['code-mutation'],
          evidence: 'builtin',
          confidence: 0.9,
        },
      ],
    });
    const reqs: CapabilityRequirement[] = [
      { id: 'task.file-extensions', weight: 0.5, fileExtensions: ['.ts'], source: 'fingerprint' },
    ];
    const fit = scoreFit(agent, reqs);
    expect(fit.matched).toHaveLength(1);
    expect(fit.fitScore).toBeGreaterThan(0);
  });

  test('role match in agent.roles short-circuits to full match', () => {
    const agent = makeAgent({
      id: 'a',
      roles: ['editor'],
      capabilities: [],
    });
    const reqs: CapabilityRequirement[] = [{ id: 'task.role.editor', weight: 0.4, role: 'editor', source: 'caller' }];
    const fit = scoreFit(agent, reqs);
    expect(fit.matched).toHaveLength(1);
    expect(fit.fitScore).toBeCloseTo(0.4, 5);
  });

  test('profile scoring returns route target and profile provenance', () => {
    const profile = buildAgentCapabilityProfile(
      makeAgent({
        id: 'synthetic-abc12345',
        capabilities: [{ id: 'code.audit.jwt', evidence: 'synthesized', confidence: 0.7 }],
      }),
      { taskId: 'task-1' },
    );
    const fit = scoreProfile(profile, [{ id: 'code.audit.jwt', weight: 1, source: 'llm-extract' }]);

    expect(fit.agentId).toBe('synthetic-abc12345');
    expect(fit.profileId).toBe('synthetic-abc12345');
    expect(fit.profileSource).toBe('synthetic');
    expect(fit.trustTier).toBe('probabilistic');
    // Phase-1 fix: fitScore uses effectiveTrust. For 'synthesized' evidence
    // + confidence 0.7: default tier 'probabilistic' (0.4), evidence_weight 0.5,
    //   wilson = max(0.5, 0.7) = 0.7 → effectiveTrust = 0.4 × 0.7 × 0.5 = 0.14.
    //   × overlap 1 × weight 1 = 0.14.
    expect(fit.fitScore).toBeCloseTo(0.14, 3);
  });

  test('unmet requirement is recorded in `gap`', () => {
    const agent = makeAgent({ id: 'a', capabilities: [] });
    const reqs: CapabilityRequirement[] = [
      { id: 'task.file-extensions', weight: 0.5, fileExtensions: ['.ts'], source: 'fingerprint' },
    ];
    const fit = scoreFit(agent, reqs);
    expect(fit.matched).toHaveLength(0);
    expect(fit.gap).toHaveLength(1);
    expect(fit.gap[0]?.id).toBe('task.file-extensions');
    expect(fit.fitScore).toBe(0);
  });
});

describe('analyzeFit', () => {
  test('ranks candidates by fitScore descending', () => {
    const a = makeAgent({
      id: 'a',
      capabilities: [{ id: 'x', fileExtensions: ['.ts'], evidence: 'builtin', confidence: 0.9 }],
    });
    const b = makeAgent({
      id: 'b',
      capabilities: [{ id: 'y', fileExtensions: ['.ts'], evidence: 'builtin', confidence: 0.5 }],
    });
    const reqs: CapabilityRequirement[] = [
      { id: 'task.file-extensions', weight: 0.5, fileExtensions: ['.ts'], source: 'fingerprint' },
    ];
    const analysis = analyzeFit('t1', [b, a], reqs);
    expect(analysis.candidates[0]?.agentId).toBe('a');
    expect(analysis.candidates[1]?.agentId).toBe('b');
  });

  test('all-met → recommendedAction=proceed', () => {
    const a = makeAgent({
      id: 'a',
      capabilities: [{ id: 'x', fileExtensions: ['.ts'], evidence: 'builtin', confidence: 1 }],
    });
    const reqs: CapabilityRequirement[] = [
      { id: 'task.file-extensions', weight: 0.5, fileExtensions: ['.ts'], source: 'fingerprint' },
    ];
    const analysis = analyzeFit('t1', [a], reqs);
    expect(analysis.recommendedAction).toBe('proceed');
    expect(analysis.gapNormalized).toBe(0);
  });

  test('half unmet → recommendedAction=research', () => {
    const a = makeAgent({
      id: 'a',
      capabilities: [{ id: 'x', fileExtensions: ['.ts'], evidence: 'builtin', confidence: 1 }],
    });
    const reqs: CapabilityRequirement[] = [
      { id: 'task.file-extensions', weight: 0.5, fileExtensions: ['.ts'], source: 'fingerprint' },
      { id: 'task.frameworks', weight: 0.5, frameworkMarkers: ['unknown-fw'], source: 'fingerprint' },
    ];
    const analysis = analyzeFit('t1', [a], reqs);
    expect(analysis.recommendedAction).toBe('research');
  });

  test('no fit at all → recommendedAction=synthesize', () => {
    const a = makeAgent({ id: 'a', capabilities: [] });
    const reqs: CapabilityRequirement[] = [
      { id: 'task.file-extensions', weight: 0.5, fileExtensions: ['.ts'], source: 'fingerprint' },
    ];
    const analysis = analyzeFit('t1', [a], reqs);
    expect(analysis.recommendedAction).toBe('synthesize');
  });

  test('empty agent list → recommendedAction=fallback', () => {
    const reqs: CapabilityRequirement[] = [
      { id: 'task.file-extensions', weight: 0.5, fileExtensions: ['.ts'], source: 'fingerprint' },
    ];
    const analysis = analyzeFit('t1', [], reqs);
    expect(analysis.recommendedAction).toBe('fallback');
    expect(analysis.candidates).toHaveLength(0);
  });

  test('analyzeProfileFit ranks profiles without requiring AgentSpec identity fields', () => {
    const weaker = buildAgentCapabilityProfile(
      makeAgent({ id: 'a', capabilities: [{ id: 'x', evidence: 'builtin', confidence: 0.4 }] }),
    );
    const stronger = buildAgentCapabilityProfile(
      makeAgent({ id: 'b', capabilities: [{ id: 'x', evidence: 'builtin', confidence: 0.9 }] }),
    );
    const analysis = analyzeProfileFit('t1', [weaker, stronger], [{ id: 'x', weight: 1, source: 'llm-extract' }]);

    expect(analysis.candidates[0]?.agentId).toBe('b');
    expect(analysis.candidates[0]?.profileSource).toBe('registry');
  });
});
