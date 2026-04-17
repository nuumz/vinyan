/**
 * Tests for agent context prompt sections — verifies that agent identity,
 * memory, and skills appear in the assembled prompt.
 */
import { describe, expect, test } from 'bun:test';
import { createDefaultRegistry } from '../../../src/orchestrator/llm/prompt-section-registry.ts';
import type { SectionContext } from '../../../src/orchestrator/llm/prompt-section-registry.ts';
import type { AgentContext } from '../../../src/orchestrator/agent-context/types.ts';
import { createEmptyContext } from '../../../src/orchestrator/agent-context/types.ts';

function makeMinimalContext(agentContext?: AgentContext): SectionContext {
  return {
    goal: 'refactor the auth module',
    perception: {
      taskTarget: { file: 'src/auth.ts', description: 'auth module' },
      dependencyCone: { directImporters: [], directImportees: [], transitiveBlastRadius: 0 },
      diagnostics: { typeErrors: [], lintWarnings: [] },
      verifiedFacts: [],
      runtime: { availableTools: new Set() },
    } as unknown as SectionContext['perception'],
    memory: {
      failedApproaches: [],
      activeHypotheses: [],
      unresolvedUncertainties: [],
    } as unknown as SectionContext['memory'],
    agentContext,
  };
}

describe('Agent Context Prompt Sections', () => {
  const registry = createDefaultRegistry();

  test('agent-identity section renders when persona is set', () => {
    const ac = createEmptyContext('worker-1');
    ac.identity.persona = 'reliable TypeScript specialist';
    ac.identity.strengths = ['refactoring', 'test-gen'];
    ac.identity.weaknesses = ['python'];
    ac.identity.approachStyle = 'reads thoroughly before editing';

    const ctx = makeMinimalContext(ac);
    const system = registry.renderTarget('system', ctx);

    expect(system).toContain('[AGENT IDENTITY]');
    expect(system).toContain('reliable TypeScript specialist');
    expect(system).toContain('refactoring, test-gen');
    expect(system).toContain('python');
    expect(system).toContain('reads thoroughly before editing');
  });

  test('agent-identity section skipped when persona is empty', () => {
    const ac = createEmptyContext('worker-1');
    const ctx = makeMinimalContext(ac);
    const system = registry.renderTarget('system', ctx);

    expect(system).not.toContain('[AGENT IDENTITY]');
  });

  test('agent-memory section renders episodes and lessons', () => {
    const ac = createEmptyContext('worker-1');
    ac.memory.lessonsSummary = 'Strong at refactoring, weak at Python.';
    ac.memory.episodes = [
      {
        taskId: 'task-1',
        taskSignature: 'code:refactor:medium',
        outcome: 'success',
        lesson: 'Completed successfully (3 oracles passed).',
        filesInvolved: ['src/foo.ts'],
        approachUsed: 'extract method',
        timestamp: 1000,
      },
    ];

    const ctx = makeMinimalContext(ac);
    const user = registry.renderTarget('user', ctx);

    expect(user).toContain('[YOUR RECENT EXPERIENCE]');
    expect(user).toContain('Strong at refactoring');
    expect(user).toContain('code:refactor:medium');
    expect(user).toContain('success');
  });

  test('agent-memory section skipped when empty', () => {
    const ac = createEmptyContext('worker-1');
    const ctx = makeMinimalContext(ac);
    const user = registry.renderTarget('user', ctx);

    expect(user).not.toContain('[YOUR RECENT EXPERIENCE]');
  });

  test('agent-skills section renders proficiencies and anti-patterns', () => {
    const ac = createEmptyContext('worker-1');
    ac.skills.proficiencies = {
      'code:refactor:medium': {
        taskSignature: 'code:refactor:medium',
        level: 'expert',
        successRate: 0.9,
        totalAttempts: 10,
        lastAttempt: 1000,
      },
      'code:test:small': {
        taskSignature: 'code:test:small',
        level: 'competent',
        successRate: 0.7,
        totalAttempts: 5,
        lastAttempt: 1000,
      },
    };
    ac.skills.preferredApproaches = { 'code:refactor:medium': 'extract method' };
    ac.skills.antiPatterns = ['never inline without tests'];

    const ctx = makeMinimalContext(ac);
    const user = registry.renderTarget('user', ctx);

    expect(user).toContain('[YOUR SKILL PROFILE]');
    expect(user).toContain('Expert: code:refactor:medium');
    expect(user).toContain('Competent: code:test:small');
    expect(user).toContain('extract method');
    expect(user).toContain('DO NOT:');
    expect(user).toContain('never inline without tests');
  });

  test('agent-skills section skipped when empty', () => {
    const ac = createEmptyContext('worker-1');
    const ctx = makeMinimalContext(ac);
    const user = registry.renderTarget('user', ctx);

    expect(user).not.toContain('[YOUR SKILL PROFILE]');
  });

  test('no agent context renders normally without errors', () => {
    const ctx = makeMinimalContext(undefined);
    const system = registry.renderTarget('system', ctx);
    const user = registry.renderTarget('user', ctx);

    expect(system).toContain('[ROLE]');
    expect(system).not.toContain('[AGENT IDENTITY]');
    expect(user).not.toContain('[YOUR RECENT EXPERIENCE]');
    expect(user).not.toContain('[YOUR SKILL PROFILE]');
  });
});
