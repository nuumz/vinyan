/**
 * Intent formatters — unit tests for formatters.ts (plan commit D4).
 */
import { describe, expect, it } from 'bun:test';
import {
  buildClarificationRequest,
  formatAgentCatalog,
  formatConversationContext,
  resolveSelectedAgent,
} from '../../../src/orchestrator/intent/formatters.ts';
import type {
  AgentSpec,
  ConversationEntry,
  SemanticTaskUnderstanding,
  TaskInput,
} from '../../../src/orchestrator/types.ts';

function entry(role: 'user' | 'assistant', content: string): ConversationEntry {
  return { role, content, taskId: 't', timestamp: 0, tokenEstimate: 0 };
}

function input(goal: string, agentId?: string): TaskInput {
  return {
    id: 'i',
    source: 'cli',
    goal,
    taskType: 'code',
    budget: { maxTokens: 1000, maxDurationMs: 5000, maxRetries: 1 },
    ...(agentId !== undefined ? { agentId } : {}),
  };
}

function agent(id: string, description = 'x', routingHints?: AgentSpec['routingHints']): AgentSpec {
  return {
    id,
    name: id,
    description,
    ...(routingHints ? { routingHints } : {}),
  };
}

describe('formatConversationContext', () => {
  it('returns empty string for missing history', () => {
    expect(formatConversationContext()).toBe('');
    expect(formatConversationContext([])).toBe('');
  });

  it('includes the last 10 entries only', () => {
    const history: ConversationEntry[] = [];
    for (let i = 0; i < 15; i++) history.push(entry('user', `msg ${i}`));
    const rendered = formatConversationContext(history);
    expect(rendered).toContain('Recent conversation:');
    expect(rendered).toContain('msg 14');
    expect(rendered).not.toContain('msg 0');
    expect(rendered).not.toContain('msg 4');
  });

  it('truncates entries longer than 200 chars', () => {
    const long = 'x'.repeat(300);
    const rendered = formatConversationContext([entry('user', long)]);
    expect(rendered).toContain('...');
    // Truncated at 200 chars of x + ellipsis
    expect(rendered.length).toBeLessThan(300 + 50);
  });

  it('prefixes each line with [role]', () => {
    const rendered = formatConversationContext([
      entry('user', 'hi'),
      entry('assistant', 'hello'),
    ]);
    expect(rendered).toContain('[user]: hi');
    expect(rendered).toContain('[assistant]: hello');
  });
});

describe('formatAgentCatalog', () => {
  it('returns empty string for no agents', () => {
    expect(formatAgentCatalog(undefined, false)).toBe('');
    expect(formatAgentCatalog([], false)).toBe('');
  });

  it('emits override notice when override is active', () => {
    const rendered = formatAgentCatalog([agent('writer')], true, 'writer');
    expect(rendered).toContain('Agent override active');
    expect(rendered).toContain("'writer'");
  });

  it('renders agent roster with descriptions', () => {
    const rendered = formatAgentCatalog(
      [agent('ts-coder', 'TypeScript specialist'), agent('writer', 'prose + ideation')],
      false,
    );
    expect(rendered).toContain('ts-coder: TypeScript specialist');
    expect(rendered).toContain('writer: prose + ideation');
  });

  it('includes routing hints when present', () => {
    const rendered = formatAgentCatalog(
      [
        agent('ts-coder', 'x', {
          preferDomains: ['backend'],
          preferExtensions: ['ts', 'tsx'],
          preferFrameworks: ['react'],
        }),
      ],
      false,
    );
    expect(rendered).toContain('domains: backend');
    expect(rendered).toContain('ext: ts,tsx');
    expect(rendered).toContain('frameworks: react');
  });
});

describe('resolveSelectedAgent', () => {
  const agents = [agent('ts-coder'), agent('writer'), agent('reviewer')];

  it('returns {} when no agents available', () => {
    expect(resolveSelectedAgent(input('x'), undefined, undefined)).toEqual({});
    expect(resolveSelectedAgent(input('x'), [], undefined)).toEqual({});
  });

  it('honors user --agent override', () => {
    const result = resolveSelectedAgent(input('x', 'writer'), agents, 'ts-coder');
    expect(result.agentId).toBe('writer');
    expect(result.agentSelectionReason).toContain('override');
  });

  it('ignores unknown user override and falls back', () => {
    const result = resolveSelectedAgent(input('x', 'bogus'), agents, 'ts-coder');
    expect(result.agentId).toBe('ts-coder');
  });

  it('uses classifier pick when valid', () => {
    const result = resolveSelectedAgent(input('x'), agents, 'ts-coder', {
      agentId: 'reviewer',
      agentSelectionReason: 'wants review',
    });
    expect(result.agentId).toBe('reviewer');
    expect(result.agentSelectionReason).toBe('wants review');
  });

  it('falls back to default agent when classifier pick is unknown', () => {
    const result = resolveSelectedAgent(input('x'), agents, 'ts-coder', {
      agentId: 'nonexistent',
    });
    expect(result.agentId).toBe('ts-coder');
  });

  it('falls back to first agent when default is unknown', () => {
    const result = resolveSelectedAgent(input('x'), agents, 'missing-default');
    expect(result.agentId).toBe('ts-coder'); // first in roster
  });
});

describe('buildClarificationRequest', () => {
  const u: SemanticTaskUnderstanding = {
    taskDomain: 'code-mutation',
  } as SemanticTaskUnderstanding;

  it('uses English when goal has no Thai characters', () => {
    const result = buildClarificationRequest(input('refactor auth'), u, 'conversational');
    expect(result.request).toMatch(/Could you add more detail/);
    expect(result.options).toBeUndefined();
  });

  it('uses Thai when goal contains Thai characters', () => {
    const result = buildClarificationRequest(input('แก้ไข auth'), u, 'conversational');
    expect(result.request).toContain('ช่วยให้รายละเอียด');
    expect(result.options).toBeUndefined();
  });

  it('returns options when rule + LLM strategies disagree (EN)', () => {
    const result = buildClarificationRequest(
      input('build feature'),
      u,
      'full-pipeline',
      'agentic-workflow',
    );
    expect(result.options).toBeDefined();
    expect(result.options).toHaveLength(2);
    expect(result.options?.[0]).toContain('full-pipeline');
    expect(result.options?.[1]).toContain('agentic-workflow');
  });

  it('returns options in Thai when goal is Thai and strategies disagree', () => {
    const result = buildClarificationRequest(
      input('สร้าง feature'),
      u,
      'full-pipeline',
      'agentic-workflow',
    );
    expect(result.options?.[0]).toMatch(/ดำเนินการแบบ full-pipeline/);
  });
});
