/**
 * Stub draft generator tests (W4 SK4).
 *
 * The stub is the MVP LLM replacement — it has to produce a schema-valid
 * SkillMdRecord that downstream verification (gate + critic) can consume.
 * These tests pin the invariants every creation path relies on.
 */
import { describe, expect, test } from 'bun:test';
import { SkillMdFrontmatterSchema } from '../../../src/skills/skill-md/schema.ts';
import { buildStubDraftGenerator, type DraftRequest } from '../../../src/skills/autonomous/index.ts';

const baseRequest: DraftRequest = {
  taskSignature: 'refactor::extract-method',
  representativeSamples: [
    { taskId: 't1', taskSignature: 'refactor::extract-method', compositeError: 0.5, outcome: 'success', ts: 1 },
    { taskId: 't2', taskSignature: 'refactor::extract-method', compositeError: 0.4, outcome: 'success', ts: 2 },
    { taskId: 't3', taskSignature: 'refactor::extract-method', compositeError: 0.2, outcome: 'success', ts: 3 },
  ],
  expectedReduction: { baseline: 0.5, target: 0.2, window: 20 },
};

describe('buildStubDraftGenerator', () => {
  test('produces a schema-valid SkillMdFrontmatter', async () => {
    const gen = buildStubDraftGenerator();
    const record = await gen(baseRequest);
    const parsed = SkillMdFrontmatterSchema.safeParse(record.frontmatter);
    expect(parsed.success).toBe(true);
  });

  test('confidence_tier is "probabilistic"', async () => {
    const gen = buildStubDraftGenerator();
    const record = await gen(baseRequest);
    expect(record.frontmatter.confidence_tier).toBe('probabilistic');
  });

  test('status is "quarantined"', async () => {
    const gen = buildStubDraftGenerator();
    const record = await gen(baseRequest);
    expect(record.frontmatter.status).toBe('quarantined');
  });

  test('origin is "local"', async () => {
    const gen = buildStubDraftGenerator();
    const record = await gen(baseRequest);
    expect(record.frontmatter.origin).toBe('local');
  });

  test('expected_prediction_error_reduction mirrors the request', async () => {
    const gen = buildStubDraftGenerator();
    const record = await gen(baseRequest);
    const expected = record.frontmatter.expected_prediction_error_reduction;
    expect(expected).toBeDefined();
    expect(expected?.baseline_composite_error).toBeCloseTo(0.5, 5);
    expect(expected?.target_composite_error).toBeCloseTo(0.2, 5);
    expect(expected?.trial_window).toBe(20);
  });

  test('procedure body references sample taskIds so tests can tail-grep', async () => {
    const gen = buildStubDraftGenerator();
    const record = await gen(baseRequest);
    expect(record.body.procedure).toContain('t1');
    expect(record.body.procedure).toContain('t3');
  });

  test('computes a stable sha256 content hash', async () => {
    const gen = buildStubDraftGenerator();
    const r1 = await gen(baseRequest);
    const r2 = await gen(baseRequest);
    expect(r1.contentHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(r1.contentHash).toBe(r2.contentHash);
  });

  test('sanitizes task signature with non-id chars into a valid skill id', async () => {
    const gen = buildStubDraftGenerator();
    const record = await gen({
      ...baseRequest,
      taskSignature: 'Refactor::Extract Method!!!',
    });
    const parsed = SkillMdFrontmatterSchema.safeParse(record.frontmatter);
    expect(parsed.success).toBe(true);
    expect(record.frontmatter.id.startsWith('auto/')).toBe(true);
  });
});
