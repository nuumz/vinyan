/**
 * Merge logic tests for intent-resolver tier merger (plan commit D7).
 *
 * Pure function — exercises the three branches of mergeDeterministicAndLLM
 * plus the isLLMRefinement helper.
 */
import { describe, expect, it } from 'bun:test';
import {
  isLLMRefinement,
  LLM_UNCERTAIN_THRESHOLD,
  mergeDeterministicAndLLM,
} from '../../../src/orchestrator/intent/merge.ts';
import type {
  IntentDeterministicCandidate,
  IntentResolution,
  SemanticTaskUnderstanding,
  TaskInput,
} from '../../../src/orchestrator/types.ts';

function input(goal = 'fix auth'): TaskInput {
  return {
    id: 'i',
    source: 'cli',
    goal,
    taskType: 'code',
    budget: { maxTokens: 1000, maxDurationMs: 5000, maxRetries: 1 },
  };
}

function understanding(
  over: Partial<SemanticTaskUnderstanding> = {},
): SemanticTaskUnderstanding {
  return {
    rawGoal: 'x',
    taskDomain: 'code-mutation',
    taskIntent: 'execute',
    toolRequirement: 'none',
    resolvedEntities: [],
    semanticIntent: { pattern: 'default', implicitConstraints: [] },
    ...over,
  } as SemanticTaskUnderstanding;
}

function det(
  strategy: IntentResolution['strategy'],
  over: Partial<IntentResolution> & { ambiguous?: boolean; resolvedTool?: boolean } = {},
): IntentResolution & { deterministicCandidate: IntentDeterministicCandidate } {
  const directToolCall = over.resolvedTool
    ? { tool: 'shell_exec', parameters: { command: 'ls' } }
    : undefined;
  const { ambiguous, resolvedTool, ...rest } = over;
  return {
    strategy,
    refinedGoal: 'x',
    confidence: 0.8,
    reasoning: 'rule said so',
    reasoningSource: 'deterministic',
    type: 'known',
    directToolCall,
    deterministicCandidate: {
      strategy,
      confidence: 0.8,
      source: 'mapUnderstandingToStrategy',
      ambiguous: !!ambiguous,
    },
    ...rest,
  };
}

function llm(
  strategy: 'conversational' | 'direct-tool' | 'full-pipeline' | 'agentic-workflow',
  confidence = 0.8,
  over: Record<string, unknown> = {},
): any {
  return {
    strategy,
    refinedGoal: 'llm-refined',
    reasoning: 'llm said so',
    confidence,
    ...over,
  };
}

describe('isLLMRefinement', () => {
  it('accepts identical strategies', () => {
    expect(isLLMRefinement('full-pipeline', 'full-pipeline')).toBe(true);
  });

  it('accepts full-pipeline ↔ agentic-workflow upgrades in both directions', () => {
    expect(isLLMRefinement('full-pipeline', 'agentic-workflow')).toBe(true);
    expect(isLLMRefinement('agentic-workflow', 'full-pipeline')).toBe(true);
  });

  it('accepts conversational → agentic-workflow deliverable upgrade', () => {
    expect(isLLMRefinement('conversational', 'agentic-workflow')).toBe(true);
  });

  it('rejects contradictory pairs', () => {
    expect(isLLMRefinement('conversational', 'direct-tool')).toBe(false);
    expect(isLLMRefinement('direct-tool', 'full-pipeline')).toBe(false);
    expect(isLLMRefinement('agentic-workflow', 'conversational')).toBe(false);
  });

  it('threshold is 0.5', () => {
    expect(LLM_UNCERTAIN_THRESHOLD).toBe(0.5);
  });
});

describe('mergeDeterministicAndLLM', () => {
  it('keeps deterministic strategy when LLM confidence is below threshold', () => {
    const result = mergeDeterministicAndLLM(
      input(),
      understanding(),
      det('full-pipeline'),
      llm('direct-tool', 0.3),
      undefined,
      't1',
    );
    expect(result.type).toBe('uncertain');
    expect(result.resolution.strategy).toBe('full-pipeline');
    expect(result.resolution.reasoningSource).toBe('merged');
    expect(result.resolution.clarificationRequest).toBeDefined();
  });

  it('emits intent:uncertain event when LLM is low-confidence', () => {
    const events: Array<{ event: string; payload: unknown }> = [];
    const bus: any = {
      emit: (event: string, payload: unknown) => {
        events.push({ event, payload });
      },
    };
    mergeDeterministicAndLLM(
      input(),
      understanding(),
      det('full-pipeline'),
      llm('direct-tool', 0.3),
      bus,
      't1',
    );
    expect(events.some((e) => e.event === 'intent:uncertain')).toBe(true);
  });

  it('A5 carve-out: hollow direct-tool rule yields to LLM refinement', () => {
    const hollow = det('direct-tool', { confidence: 0.8 }); // no directToolCall
    const result = mergeDeterministicAndLLM(
      input(),
      understanding(),
      hollow,
      llm('full-pipeline', 0.8),
      undefined,
      't1',
    );
    expect(result.type).toBe('known');
    expect(result.resolution.strategy).toBe('full-pipeline');
    expect(result.resolution.reasoning).toMatch(/carve-out|hollow/);
  });

  it('A5 contradiction: rule wins on real disagreement', () => {
    const result = mergeDeterministicAndLLM(
      input(),
      understanding(),
      det('conversational'),
      llm('direct-tool', 0.9),
      undefined,
      't1',
    );
    expect(result.type).toBe('contradictory');
    expect(result.resolution.strategy).toBe('conversational');
    expect(result.resolution.reasoning).toMatch(/A5 contradiction/);
    expect(result.resolution.clarificationRequest).toBeDefined();
  });

  it('emits intent:contradiction event with rule winner on contradiction', () => {
    const events: any[] = [];
    const bus: any = { emit: (event: string, payload: unknown) => events.push({ event, payload }) };
    mergeDeterministicAndLLM(
      input(),
      understanding(),
      det('conversational'),
      llm('direct-tool', 0.9),
      bus,
      't1',
    );
    const contradict = events.find((e) => e.event === 'intent:contradiction');
    expect(contradict).toBeDefined();
    expect(contradict.payload.winner).toBe('conversational');
  });

  it('agreement: accepts LLM refined goal at merged confidence', () => {
    const result = mergeDeterministicAndLLM(
      input(),
      understanding(),
      det('full-pipeline', { confidence: 0.8 }),
      llm('full-pipeline', 0.9, { refinedGoal: 'richer goal', reasoning: 'llm r' }),
      undefined,
      't1',
    );
    expect(result.type).toBe('known');
    expect(result.resolution.strategy).toBe('full-pipeline');
    expect(result.resolution.refinedGoal).toBe('richer goal');
    expect(result.resolution.confidence).toBe(0.9); // max(0.8, 0.9)
    expect(result.resolution.reasoning).toBe('llm r');
  });

  it('refinement upgrade (full-pipeline → agentic-workflow) accepted', () => {
    const result = mergeDeterministicAndLLM(
      input(),
      understanding(),
      det('full-pipeline'),
      llm('agentic-workflow', 0.85),
      undefined,
      't1',
    );
    expect(result.type).toBe('known');
    expect(result.resolution.strategy).toBe('agentic-workflow');
  });

  it('preserves deterministic direct-tool call when LLM lacks one (agreement path)', () => {
    const rule = det('direct-tool', { resolvedTool: true });
    const result = mergeDeterministicAndLLM(
      input(),
      understanding(),
      rule,
      llm('direct-tool', 0.9, { directToolCall: undefined }),
      undefined,
      't1',
    );
    expect(result.resolution.directToolCall).toEqual(rule.directToolCall);
  });

  it('default LLM confidence is 0.8 when omitted', () => {
    const result = mergeDeterministicAndLLM(
      input(),
      understanding(),
      det('full-pipeline'),
      llm('full-pipeline') as any,
      undefined,
      't1',
    );
    // 0.8 is above LLM_UNCERTAIN_THRESHOLD=0.5, so NOT uncertain
    expect(result.type).toBe('known');
  });
});
