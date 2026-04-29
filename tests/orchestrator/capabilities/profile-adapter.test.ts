import { describe, expect, test } from 'bun:test';
import { buildAgentCapabilityProfile } from '../../../src/orchestrator/capabilities/profile-adapter.ts';
import type { AgentSpec } from '../../../src/orchestrator/types.ts';

function makeAgent(overrides: Partial<AgentSpec> & { id: string }): AgentSpec {
  return {
    name: overrides.id,
    description: 'test agent',
    ...overrides,
  };
}

describe('buildAgentCapabilityProfile', () => {
  test('converts a registry agent into a routeable capability profile', () => {
    const profile = buildAgentCapabilityProfile(
      makeAgent({
        id: 'ts-coder',
        builtin: true,
        roles: ['coder'],
        capabilities: [{ id: 'code.review.ts', evidence: 'builtin', confidence: 0.9, fileExtensions: ['.ts'] }],
        allowedTools: ['file_read'],
        capabilityOverrides: { readAny: true, writeAny: false, network: false, shell: false },
        routingHints: { minLevel: 1, preferExtensions: ['.ts'] },
      }),
    );

    expect(profile.id).toBe('ts-coder');
    expect(profile.routeTargetId).toBe('ts-coder');
    expect(profile.source).toBe('registry');
    expect(profile.trustTier).toBe('deterministic');
    expect(profile.claims[0]?.id).toBe('code.review.ts');
    expect(profile.roles).toEqual(['coder']);
    expect(profile.acl.writeAny).toBe(false);
    expect(profile.routingHints?.minLevel).toBe(1);
  });

  test('returns defensive copies of mutable capability and ACL arrays', () => {
    const agent = makeAgent({
      id: 'writer',
      capabilities: [{ id: 'writing.edit', evidence: 'builtin', confidence: 0.8, actionVerbs: ['edit'] }],
      roles: ['editor'],
      allowedTools: ['file_read'],
      routingHints: { preferDomains: ['creative-writing'] },
    });
    const profile = buildAgentCapabilityProfile(agent);

    agent.capabilities![0]!.actionVerbs!.push('poison');
    agent.roles!.push('poison');
    agent.allowedTools!.push('shell_exec');
    agent.routingHints!.preferDomains!.push('poison');

    expect(profile.claims[0]?.actionVerbs).toEqual(['edit']);
    expect(profile.roles).toEqual(['editor']);
    expect(profile.acl.allowedTools).toEqual(['file_read']);
    expect(profile.routingHints?.preferDomains).toEqual(['creative-writing']);
  });

  test('marks task-scoped synthetic agents as probabilistic profiles', () => {
    const profile = buildAgentCapabilityProfile(
      makeAgent({
        id: 'synthetic-abc12345',
        builtin: false,
        capabilities: [{ id: 'code.audit.jwt', evidence: 'synthesized', confidence: 0.4 }],
      }),
      { taskId: 'task-1' },
    );

    expect(profile.source).toBe('synthetic');
    expect(profile.trustTier).toBe('probabilistic');
    expect(profile.taskScope).toEqual({ taskId: 'task-1' });
  });
});