/**
 * Behaviour tests for the CLI oracle stubs. These stubs carry TODO(w4)
 * markers and are used only until the real gate/critic/goal-alignment
 * oracles are wired through the CLI — the tests lock down their
 * advertised defaults so a future change cannot silently downgrade CLI
 * behaviour.
 */
import { describe, expect, test } from 'bun:test';
import { stubGoalAlignmentOracle, stubImporterCriticFn, stubImporterGateFn } from '../../src/cli/oracle-stubs.ts';

describe('stubGoalAlignmentOracle', () => {
  test('returns {confidence: 0.8, aligned: true} for any input', async () => {
    const fn = stubGoalAlignmentOracle();
    const out = await fn({ goal: 'summarize PRs', nlOriginal: 'every weekday summarize PRs' });
    expect(out.confidence).toBe(0.8);
    expect(out.aligned).toBe(true);
  });

  test('confidence is above the interpreter MIN_ALIGNMENT_CONFIDENCE (0.5)', async () => {
    const fn = stubGoalAlignmentOracle();
    const out = await fn({ goal: '', nlOriginal: '' });
    expect(out.confidence).toBeGreaterThanOrEqual(0.5);
  });
});

describe('stubImporterGateFn', () => {
  test('returns an allow verdict with an allow epistemic decision', async () => {
    const fn = stubImporterGateFn();
    const out = await fn({
      tool: 'import_skill_dry_run',
      params: { file_path: 'skills/x/SKILL.md', content: 'body', workspace: '/tmp' },
      skillId: 'github:x/y',
      dryRun: true,
    });
    expect(out.decision).toBe('allow');
    expect(out.epistemicDecision).toBe('allow');
  });

  test('aggregateConfidence exceeds the hub promotion floor (0.7)', async () => {
    const fn = stubImporterGateFn();
    const out = await fn({
      tool: 'import_skill_dry_run',
      params: { file_path: 'skills/x/SKILL.md', content: 'body', workspace: '/tmp' },
      skillId: 'github:x/y',
      dryRun: true,
    });
    expect(out.aggregateConfidence).toBeGreaterThanOrEqual(0.7);
  });
});

describe('stubImporterCriticFn', () => {
  test('returns approved:true with confidence 0.9', async () => {
    const fn = stubImporterCriticFn();
    const out = await fn({
      skillId: 'github:x/y',
      skillMd: 'dummy',
      gateVerdict: { decision: 'allow', aggregateConfidence: 0.85 },
    });
    expect(out.approved).toBe(true);
    expect(out.confidence).toBeCloseTo(0.9, 5);
    expect(out.notes).toMatch(/TODO|stub/i);
  });
});
