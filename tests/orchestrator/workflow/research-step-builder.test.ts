/**
 * Tests for research-step-builder — detection + workflow-step prepending.
 */
import { describe, expect, test } from 'bun:test';
import {
  buildResearchStep,
  detectResearchCues,
  prependResearchStep,
  RESEARCH_STEP_ID,
} from '../../../src/orchestrator/workflow/research-step-builder.ts';
import type { WorkflowStep } from '../../../src/orchestrator/workflow/types.ts';

function step(overrides: Partial<WorkflowStep>): WorkflowStep {
  return {
    id: overrides.id ?? 'step1',
    description: overrides.description ?? 'do a thing',
    strategy: overrides.strategy ?? 'llm-reasoning',
    dependencies: overrides.dependencies ?? [],
    inputs: overrides.inputs ?? {},
    expectedOutput: overrides.expectedOutput ?? 'output',
    budgetFraction: overrides.budgetFraction ?? 0.5,
  };
}

describe('detectResearchCues', () => {
  test('fires on explicit TH research cues (เทรนด์ / ยอดฮิต / กลุ่มเป้าหมาย)', () => {
    expect(detectResearchCues('อยากรู้เทรนด์นิยายที่กำลังดัง').needsResearch).toBe(true);
    expect(detectResearchCues('วิเคราะห์กลุ่มเป้าหมายของคอนเทนต์').needsResearch).toBe(true);
    expect(detectResearchCues('คอนเทนต์ยอดฮิตตอนนี้').needsResearch).toBe(true);
  });

  test('fires on explicit EN research cues (trending / market / audience)', () => {
    expect(detectResearchCues('analyse the webtoon market').needsResearch).toBe(true);
    expect(detectResearchCues("what's trending in webtoons").needsResearch).toBe(true);
    expect(detectResearchCues('study the audience for sci-fi podcasts').needsResearch).toBe(true);
  });

  test('fires on long-form creative goals (webtoon / novel / article)', () => {
    const result = detectResearchCues('อยากให้ช่วยเขียนนิยายลงขายในเว็บตูนสักเรื่อง');
    expect(result.needsResearch).toBe(true);
    expect(result.reason).toBe('long-form-creative');
    expect(result.brief).toContain('trends');
  });

  test('does NOT fire on informational / negated utterances', () => {
    expect(detectResearchCues('นิยายคืออะไร').needsResearch).toBe(false);
    expect(detectResearchCues('what is a webtoon').needsResearch).toBe(false);
    expect(detectResearchCues('just curious about novels').needsResearch).toBe(false);
    expect(detectResearchCues('แค่อยากรู้ว่านิยายเว็บตูนคืออะไร').needsResearch).toBe(false);
  });

  test('does NOT fire on short / unrelated goals', () => {
    expect(detectResearchCues('hi').needsResearch).toBe(false);
    expect(detectResearchCues('fix the bug in foo.ts').needsResearch).toBe(false);
    expect(detectResearchCues('refactor auth module').needsResearch).toBe(false);
  });
});

describe('buildResearchStep', () => {
  test('produces an llm-reasoning step with the brief as description', () => {
    const s = buildResearchStep('Research current webtoon trends');
    expect(s.id).toBe(RESEARCH_STEP_ID);
    expect(s.strategy).toBe('llm-reasoning');
    expect(s.description).toContain('Research current webtoon trends');
    expect(s.dependencies).toEqual([]);
    expect(s.budgetFraction).toBeGreaterThan(0);
    expect(s.budgetFraction).toBeLessThan(0.25);
    expect(s.expectedOutput).toContain('bullet');
  });
});

describe('prependResearchStep', () => {
  test('prepends and rewires previously-root steps to depend on the research step', () => {
    const research = buildResearchStep('brief');
    const plan = [
      step({ id: 'write', dependencies: [] }),
      step({ id: 'edit', dependencies: ['write'] }),
    ];
    const result = prependResearchStep(plan, research);

    expect(result.map((s) => s.id)).toEqual([RESEARCH_STEP_ID, 'write', 'edit']);
    expect(result.find((s) => s.id === 'write')!.dependencies).toEqual([RESEARCH_STEP_ID]);
    // Already-dependent steps stay as-is.
    expect(result.find((s) => s.id === 'edit')!.dependencies).toEqual(['write']);
  });

  test('scales existing budgetFraction to keep total within 1.0 after injection', () => {
    const research = buildResearchStep('brief');
    const plan = [
      step({ id: 'a', dependencies: [], budgetFraction: 0.6 }),
      step({ id: 'b', dependencies: ['a'], budgetFraction: 0.4 }),
    ];
    const result = prependResearchStep(plan, research);

    const total = result.reduce((sum, s) => sum + s.budgetFraction, 0);
    expect(total).toBeLessThanOrEqual(1.0001); // allow fp rounding
  });

  test('is a no-op when a research step already exists in the plan', () => {
    const research = buildResearchStep('brief');
    const plan = [
      { ...research, description: 'planner-generated research' },
      step({ id: 'draft', dependencies: [research.id] }),
    ];
    const result = prependResearchStep(plan, research);
    expect(result).toBe(plan);
  });
});
