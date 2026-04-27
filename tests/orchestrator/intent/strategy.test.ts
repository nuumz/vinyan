/**
 * Strategy classification tests (plan commit D5).
 *
 * Pins the three layers of deterministic classification:
 *   - fallbackStrategy
 *   - mapUnderstandingToStrategy (confidence + ambiguity signals)
 *   - composeDeterministicCandidate (happy-path + demotion variants)
 */
import { describe, expect, it } from 'bun:test';
import {
  composeDeterministicCandidate,
  fallbackStrategy,
  mapUnderstandingToStrategy,
} from '../../../src/orchestrator/intent/strategy.ts';
import type { SemanticTaskUnderstanding, TaskInput } from '../../../src/orchestrator/types.ts';

function stu(over: Partial<SemanticTaskUnderstanding> = {}): SemanticTaskUnderstanding {
  return {
    rawGoal: 'do thing',
    taskDomain: 'code-mutation',
    taskIntent: 'execute',
    toolRequirement: 'none',
    resolvedEntities: [],
    semanticIntent: { pattern: 'default', implicitConstraints: [] },
    ...over,
  } as SemanticTaskUnderstanding;
}

function input(goal: string): TaskInput {
  return {
    id: 'i',
    source: 'cli',
    goal,
    taskType: 'code',
    budget: { maxTokens: 1000, maxDurationMs: 5000, maxRetries: 1 },
  };
}

describe('fallbackStrategy', () => {
  it('returns conversational for taskDomain=conversational', () => {
    expect(fallbackStrategy('conversational', 'chat', 'none')).toBe('conversational');
  });

  it('returns conversational for general-reasoning + inquire', () => {
    expect(fallbackStrategy('general-reasoning', 'inquire', 'none')).toBe('conversational');
  });

  it('returns direct-tool for non-code-mutation + execute + tool-needed', () => {
    expect(fallbackStrategy('general-reasoning', 'execute', 'tool-needed')).toBe('direct-tool');
  });

  it('returns agentic-workflow for general-reasoning + execute + none', () => {
    expect(fallbackStrategy('general-reasoning', 'execute', 'none')).toBe('agentic-workflow');
  });

  it('returns full-pipeline as the default', () => {
    expect(fallbackStrategy('code-mutation', 'execute', 'none')).toBe('full-pipeline');
  });

  it('preserves agentic-workflow on clarification answers', () => {
    const comprehension = {
      params: {
        type: 'comprehension' as const,
        inputHash: 'h',
        data: {
          state: { isClarificationAnswer: true },
        } as any,
      },
    } as any;
    // Even a pure "conversational" domain gets bumped to agentic-workflow.
    expect(fallbackStrategy('conversational', 'chat', 'none', comprehension)).toBe(
      'agentic-workflow',
    );
  });
});

describe('mapUnderstandingToStrategy', () => {
  it('marks conversational as high confidence and unambiguous', () => {
    const r = mapUnderstandingToStrategy(
      stu({ taskDomain: 'conversational', taskIntent: 'converse', toolRequirement: 'none' }),
    );
    expect(r.strategy).toBe('conversational');
    expect(r.confidence).toBeGreaterThanOrEqual(0.9);
    expect(r.ambiguous).toBe(false);
  });

  it('flags creative ambiguity (general-reasoning + execute + none)', () => {
    const r = mapUnderstandingToStrategy(
      stu({
        taskDomain: 'general-reasoning',
        taskIntent: 'execute',
        toolRequirement: 'none',
      }),
    );
    expect(r.ambiguous).toBe(true);
    expect(r.confidence).toBeLessThan(0.7);
  });

  it('flags code-reasoning inquiry as ambiguous', () => {
    const r = mapUnderstandingToStrategy(
      stu({ taskDomain: 'code-reasoning', taskIntent: 'inquire', toolRequirement: 'none' }),
    );
    expect(r.ambiguous).toBe(true);
  });

  it('flags missing-referent (file-token without resolved paths)', () => {
    const r = mapUnderstandingToStrategy(
      stu({
        rawGoal: 'refactor src/missing.ts',
        taskDomain: 'code-mutation',
        taskIntent: 'execute',
        toolRequirement: 'none',
        resolvedEntities: [],
      }),
    );
    expect(r.ambiguous).toBe(true);
  });

  it('gives code-mutation with target symbol high confidence', () => {
    const r = mapUnderstandingToStrategy(
      stu({
        taskDomain: 'code-mutation',
        taskIntent: 'execute',
        toolRequirement: 'none',
        targetSymbol: 'authenticate',
        resolvedEntities: [],
      } as Partial<SemanticTaskUnderstanding>),
    );
    expect(r.strategy).toBe('full-pipeline');
    expect(r.confidence).toBeGreaterThanOrEqual(0.85);
  });
});

describe('composeDeterministicCandidate', () => {
  it('returns deterministic reasoningSource + deterministicCandidate payload', () => {
    const result = composeDeterministicCandidate(
      input('say hi'),
      stu({ taskDomain: 'conversational', taskIntent: 'converse', toolRequirement: 'none' }),
    );
    expect(result.reasoningSource).toBe('deterministic');
    expect(result.deterministicCandidate).toBeDefined();
    expect(result.deterministicCandidate.strategy).toBe('conversational');
  });

  it('routes inspection verbs to full-pipeline with uncertain type', () => {
    const result = composeDeterministicCandidate(
      input('check git status'),
      stu({
        taskDomain: 'general-reasoning',
        taskIntent: 'execute',
        toolRequirement: 'tool-needed',
      }),
    );
    expect(result.strategy).toBe('full-pipeline');
    expect(result.type).toBe('uncertain');
    expect(result.reasoning).toMatch(/inspection verb|report expected/);
  });

  it('recognizes Thai inspection verbs', () => {
    const result = composeDeterministicCandidate(
      input('ตรวจสอบสถานะ repo'),
      stu({
        taskDomain: 'general-reasoning',
        taskIntent: 'execute',
        toolRequirement: 'tool-needed',
      }),
    );
    expect(result.strategy).toBe('full-pipeline');
  });

  it('emits skeleton with ambiguous=true for creative ambiguity', () => {
    const result = composeDeterministicCandidate(
      input('ช่วยคิดพล็อตนิยายหน่อย'),
      stu({
        taskDomain: 'general-reasoning',
        taskIntent: 'execute',
        toolRequirement: 'none',
      }),
    );
    expect(result.type).toBe('uncertain');
    expect(result.deterministicCandidate.ambiguous).toBe(true);
  });

  it('returns a full-pipeline skeleton for plain code-mutation', () => {
    const result = composeDeterministicCandidate(
      input('refactor the authenticate function'),
      stu({
        targetSymbol: 'authenticate',
        taskDomain: 'code-mutation',
        taskIntent: 'execute',
        toolRequirement: 'none',
      } as Partial<SemanticTaskUnderstanding>),
    );
    expect(result.strategy).toBe('full-pipeline');
    expect(result.type).toBe('known');
  });
});

describe('composeDeterministicCandidate — creative-deliverable pre-rule', () => {
  // The pre-rule is the bedtime-story bug fix. It runs BEFORE STU mapping
  // and overrides the comprehender's domain classification when the goal
  // text carries an unambiguous "verb + creative-noun" structural signal.
  it('catches the bedtime-story prompt at high confidence regardless of STU domain', () => {
    const result = composeDeterministicCandidate(
      input('ช่วยเขียนนิยายก่อนนอน สำหรับกล่อมลูกนอนให้สัก2บท'),
      // STU mis-classifies as conversational (the production failure mode).
      stu({ taskDomain: 'conversational', taskIntent: 'inquire', toolRequirement: 'none' }),
    );
    expect(result.strategy).toBe('agentic-workflow');
    expect(result.type).toBe('known');
    expect(result.confidence).toBeGreaterThanOrEqual(0.85);
    expect(result.deterministicCandidate.source).toBe('creative-deliverable-pattern');
    expect(result.deterministicCandidate.ambiguous).toBe(false);
  });

  it('catches English authoring requests too', () => {
    const result = composeDeterministicCandidate(
      input('write me a 2-chapter bedtime story'),
      stu({ taskDomain: 'conversational', taskIntent: 'inquire', toolRequirement: 'none' }),
    );
    expect(result.strategy).toBe('agentic-workflow');
    expect(result.deterministicCandidate.source).toBe('creative-deliverable-pattern');
  });

  it('does NOT trigger on definition questions (verb absent)', () => {
    const result = composeDeterministicCandidate(
      input('นิยายเว็บตูนคืออะไร'),
      stu({ taskDomain: 'conversational', taskIntent: 'inquire', toolRequirement: 'none' }),
    );
    expect(result.strategy).toBe('conversational');
    expect(result.deterministicCandidate.source).not.toBe('creative-deliverable-pattern');
  });

  it('does NOT trigger on noun-collision performance tasks (verb is not authoring)', () => {
    // "ทำให้เว็บตูนโหลดเร็วขึ้น" mentions "เว็บตูน" (a noun also used in
    // creative writing) but the verb is "ทำให้...โหลดเร็วขึ้น" — performance.
    const result = composeDeterministicCandidate(
      input('ทำให้เว็บตูนโหลดเร็วขึ้น'),
      stu({ taskDomain: 'general-reasoning', taskIntent: 'execute', toolRequirement: 'none' }),
    );
    expect(result.deterministicCandidate.source).not.toBe('creative-deliverable-pattern');
  });

  it('does NOT trigger on bare creative noun without authoring verb', () => {
    const result = composeDeterministicCandidate(
      input('นิยายเรื่องนี้สนุกมาก'),
      stu({ taskDomain: 'conversational', taskIntent: 'inquire', toolRequirement: 'none' }),
    );
    expect(result.deterministicCandidate.source).not.toBe('creative-deliverable-pattern');
  });
});
