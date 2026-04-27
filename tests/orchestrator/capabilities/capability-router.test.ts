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
import { analyzeFit, scoreFit } from '../../../src/orchestrator/capabilities/capability-router.ts';
import type { AgentSpec, CapabilityRequirement } from '../../../src/orchestrator/types.ts';

function makeAgent(overrides: Partial<AgentSpec> & { id: string }): AgentSpec {
  return {
    name: overrides.id,
    description: '',
    ...overrides,
  };
}

describe('scoreFit', () => {
  test('exact id match scores claim.confidence × req.weight', () => {
    const agent = makeAgent({
      id: 'a',
      capabilities: [{ id: 'code.refactor.ts', evidence: 'builtin', confidence: 0.9 }],
    });
    const reqs: CapabilityRequirement[] = [{ id: 'code.refactor.ts', weight: 0.5, source: 'llm-extract' }];
    const fit = scoreFit(agent, reqs);
    expect(fit.matched).toHaveLength(1);
    expect(fit.gap).toHaveLength(0);
    expect(fit.fitScore).toBeCloseTo(0.9 * 0.5, 5);
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
});
