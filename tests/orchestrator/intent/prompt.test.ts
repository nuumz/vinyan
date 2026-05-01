/**
 * Classifier prompt builder tests (plan commit D6).
 *
 * Pure functions — no LLM, no DB, no orchestrator. Exercise the layout of
 * the prompt fragments + the comprehension block's routing-rule injection.
 */
import { describe, expect, it } from 'bun:test';
import { asPersonaId } from '../../../src/core/agent-vocabulary.ts';
import {
  buildClassifierUserPrompt,
  buildComprehensionBlock,
} from '../../../src/orchestrator/intent/prompt.ts';
import type { IntentResolverDeps } from '../../../src/orchestrator/intent/types.ts';
import type { TaskInput } from '../../../src/orchestrator/types.ts';

function input(over: Partial<TaskInput> = {}): TaskInput {
  return {
    id: 'i',
    source: 'cli',
    goal: 'fix auth',
    taskType: 'code',
    budget: { maxTokens: 1000, maxDurationMs: 5000, maxRetries: 1 },
    ...over,
  };
}

function deps(over: Partial<IntentResolverDeps> = {}): IntentResolverDeps {
  return { registry: undefined as any, ...over };
}

describe('buildComprehensionBlock', () => {
  it('returns empty string when no comprehension supplied', () => {
    expect(buildComprehensionBlock()).toBe('');
  });

  it('returns empty string for non-comprehension params', () => {
    expect(
      buildComprehensionBlock({
        params: { type: 'not-comprehension' as any, inputHash: 'h', data: null },
      } as any),
    ).toBe('');
  });

  it('surfaces state flags + rootGoal + pendingQuestions', () => {
    const block = buildComprehensionBlock({
      params: {
        type: 'comprehension',
        tier: 'deterministic',
        inputHash: 'h',
        data: {
          literalGoal: 'yes',
          resolvedGoal: 'yes, continue with option A',
          state: {
            isNewTopic: false,
            isClarificationAnswer: true,
            isFollowUp: false,
            hasAmbiguousReferents: false,
            rootGoal: 'write a romance novel outline',
            pendingQuestions: ['What genre?', 'How long?'],
          },
        },
      },
    } as any);
    expect(block).toContain('tier=deterministic');
    expect(block).toContain('isClarificationAnswer: true');
    expect(block).toContain('rootGoal: "write a romance novel outline"');
    expect(block).toContain('pendingQuestions (2):');
    expect(block).toContain('- What genre?');
    expect(block).toContain('resolvedGoal (prefer over literal):');
    expect(block).toContain('ROUTING RULE');
  });

  it('omits ROUTING RULE when isClarificationAnswer=false', () => {
    const block = buildComprehensionBlock({
      params: {
        type: 'comprehension',
        tier: 'llm',
        inputHash: 'h',
        data: {
          literalGoal: 'x',
          state: {
            isNewTopic: true,
            isClarificationAnswer: false,
            isFollowUp: false,
            hasAmbiguousReferents: false,
            pendingQuestions: [],
          },
        },
      },
    } as any);
    expect(block).not.toContain('ROUTING RULE');
  });

  it('truncates very long rootGoal to 160 chars', () => {
    const long = 'x'.repeat(400);
    const block = buildComprehensionBlock({
      params: {
        type: 'comprehension',
        tier: 't',
        inputHash: 'h',
        data: {
          literalGoal: 'x',
          state: {
            isNewTopic: true,
            isClarificationAnswer: false,
            isFollowUp: false,
            hasAmbiguousReferents: false,
            rootGoal: long,
            pendingQuestions: [],
          },
        },
      },
    } as any);
    expect(block).toContain('...');
    expect(block.includes('x'.repeat(400))).toBe(false);
  });
});

describe('buildClassifierUserPrompt', () => {
  it('includes goal, taskType, and platform header', () => {
    const prompt = buildClassifierUserPrompt(input({ goal: 'refactor auth' }), deps(), null);
    expect(prompt).toContain('User goal: "refactor auth"');
    expect(prompt).toContain('Task type: code');
    expect(prompt).toContain('Current platform:');
  });

  it('renders "none" for empty targetFiles + constraints', () => {
    const prompt = buildClassifierUserPrompt(input(), deps(), null);
    expect(prompt).toContain('Target files: none');
    expect(prompt).toContain('Constraints: none');
  });

  it('exposes provided targetFiles + constraints', () => {
    const prompt = buildClassifierUserPrompt(
      input({ targetFiles: ['src/a.ts'], constraints: ['no deps'] }),
      deps(),
      null,
    );
    expect(prompt).toContain('Target files: src/a.ts');
    expect(prompt).toContain('Constraints: no deps');
  });

  it('uses the default tool list when availableTools is unset', () => {
    const prompt = buildClassifierUserPrompt(input(), deps(), null);
    expect(prompt).toContain('Available tools: shell_exec, file_read');
  });

  it('uses provided tool list when availableTools is set', () => {
    const prompt = buildClassifierUserPrompt(
      input(),
      deps({ availableTools: ['git_status', 'git_diff'] }),
      null,
    );
    expect(prompt).toContain('Available tools: git_status, git_diff');
    expect(prompt).not.toContain('shell_exec, file_read');
  });

  it('injects Rule-based candidate block when deterministic is supplied', () => {
    const deterministic: any = {
      strategy: 'direct-tool',
      refinedGoal: 'run it',
      reasoning: 'x',
      confidence: 0.85,
      reasoningSource: 'deterministic',
      type: 'known',
      deterministicCandidate: {
        strategy: 'direct-tool',
        confidence: 0.85,
        source: 'composed',
        ambiguous: false,
      },
    };
    const prompt = buildClassifierUserPrompt(input(), deps(), deterministic);
    expect(prompt).toContain('Rule-based candidate');
    expect(prompt).toContain('strategy=direct-tool');
    expect(prompt).toContain('confidence=0.85');
    expect(prompt).not.toContain('AMBIGUOUS');
  });

  it('marks AMBIGUOUS when the deterministic candidate flags ambiguity', () => {
    const deterministic: any = {
      strategy: 'full-pipeline',
      confidence: 0.55,
      reasoning: 'x',
      reasoningSource: 'deterministic',
      type: 'uncertain',
      deterministicCandidate: {
        strategy: 'full-pipeline',
        confidence: 0.55,
        source: 'mapUnderstandingToStrategy',
        ambiguous: true,
      },
    };
    const prompt = buildClassifierUserPrompt(input(), deps(), deterministic);
    expect(prompt).toContain('AMBIGUOUS');
  });

  it('appends agent override notice when input.agentId matches a known agent', () => {
    const prompt = buildClassifierUserPrompt(
      input({ agentId: asPersonaId('writer') }),
      deps({ agents: [{ id: 'writer', name: 'writer', description: 'ideation' }] }),
      null,
    );
    expect(prompt).toContain('Agent override active');
    expect(prompt).toContain("'writer'");
  });
});
