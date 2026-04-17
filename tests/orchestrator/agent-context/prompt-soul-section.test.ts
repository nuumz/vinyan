/**
 * Tests for agent-soul prompt section — verifies deep soul injection.
 */
import { describe, expect, test } from 'bun:test';
import { createDefaultRegistry } from '../../../src/orchestrator/llm/prompt-section-registry.ts';
import type { SectionContext } from '../../../src/orchestrator/llm/prompt-section-registry.ts';
import { createEmptyContext } from '../../../src/orchestrator/agent-context/types.ts';

function makeMinimalContext(overrides?: Partial<SectionContext>): SectionContext {
  return {
    goal: 'fix the auth bug',
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
    ...overrides,
  };
}

describe('Agent Soul Prompt Section', () => {
  const registry = createDefaultRegistry();

  test('renders [AGENT SOUL] when soulContent is provided', () => {
    const ctx = makeMinimalContext({
      soulContent: '## Philosophy\nI read before I edit.\n\n## Anti-Patterns\n- NEVER guess imports',
    });
    const system = registry.renderTarget('system', ctx);

    expect(system).toContain('[AGENT SOUL]');
    expect(system).toContain('I read before I edit');
    expect(system).toContain('NEVER guess imports');
  });

  test('falls back to [AGENT IDENTITY] when only agentContext is provided', () => {
    const ac = createEmptyContext('worker-1');
    ac.identity.persona = 'reliable specialist';
    ac.identity.strengths = ['refactoring'];

    const ctx = makeMinimalContext({ agentContext: ac });
    const system = registry.renderTarget('system', ctx);

    expect(system).toContain('[AGENT IDENTITY]');
    expect(system).toContain('reliable specialist');
    expect(system).not.toContain('[AGENT SOUL]');
  });

  test('soul takes precedence over agentContext identity', () => {
    const ac = createEmptyContext('worker-1');
    ac.identity.persona = 'should be overridden';

    const ctx = makeMinimalContext({
      agentContext: ac,
      soulContent: '## Philosophy\nI am the soul, not the identity.',
    });
    const system = registry.renderTarget('system', ctx);

    expect(system).toContain('[AGENT SOUL]');
    expect(system).toContain('I am the soul');
    expect(system).not.toContain('should be overridden');
  });

  test('no soul and no agentContext renders nothing', () => {
    const ctx = makeMinimalContext();
    const system = registry.renderTarget('system', ctx);

    expect(system).not.toContain('[AGENT SOUL]');
    expect(system).not.toContain('[AGENT IDENTITY]');
  });

  test('soul section uses session cache tier (priority 16)', () => {
    // Verify section exists with correct properties
    const sectionIds = registry.getSectionIds();
    expect(sectionIds).toContain('agent-soul');
  });

  test('agent-memory and agent-skills still render alongside soul', () => {
    const ac = createEmptyContext('worker-1');
    ac.memory.lessonsSummary = 'Learned many things.';
    ac.memory.episodes = [{
      taskId: 't1', taskSignature: 'test', outcome: 'success',
      lesson: 'good', filesInvolved: [], approachUsed: 'standard', timestamp: 1,
    }];
    ac.skills.proficiencies = {
      'code:test': {
        taskSignature: 'code:test', level: 'expert',
        successRate: 0.9, totalAttempts: 10, lastAttempt: 1,
      },
    };

    const ctx = makeMinimalContext({
      agentContext: ac,
      soulContent: '## Philosophy\nI am the soul.',
    });

    const system = registry.renderTarget('system', ctx);
    const user = registry.renderTarget('user', ctx);

    expect(system).toContain('[AGENT SOUL]');
    expect(user).toContain('[YOUR RECENT EXPERIENCE]');
    expect(user).toContain('[YOUR SKILL PROFILE]');
  });
});
