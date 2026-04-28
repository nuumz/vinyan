import { describe, expect, test } from 'bun:test';
import { decideCompletionTurn } from '../../../src/orchestrator/agent/agent-worker-entry.ts';

describe('decideCompletionTurn — accountability gate', () => {
  test('status=done with grade A → done turn', () => {
    const decision = decideCompletionTurn({
      status: 'done',
      proposedContent: 'Added foo export.',
      selfAssessment: { grade: 'A', acceptanceCriteriaSatisfied: ['exports foo'], gaps: [] },
    });
    expect(decision.type).toBe('done');
    expect(decision.proposedContent).toBe('Added foo export.');
    expect(decision.downgradedFromGradeC).toBe(false);
    expect(decision.missingSelfAssessment).toBe(false);
    expect(decision.selfGrade).toBe('A');
  });

  test('status=done with grade B → done turn (caveats allowed)', () => {
    const decision = decideCompletionTurn({
      status: 'done',
      summary: 'Goal met.',
      selfAssessment: { grade: 'B', gaps: ['lint warnings remain'] },
    });
    expect(decision.type).toBe('done');
    expect(decision.proposedContent).toBe('Goal met.');
    expect(decision.selfGrade).toBe('B');
    expect(decision.downgradedFromGradeC).toBe(false);
  });

  test('status=done with grade C → DOWNGRADED to uncertain', () => {
    const decision = decideCompletionTurn({
      status: 'done',
      proposedContent: 'I think this works',
      selfAssessment: {
        grade: 'C',
        gaps: ['type-check failed', 'no tests run'],
      },
    });
    expect(decision.type).toBe('uncertain');
    expect(decision.downgradedFromGradeC).toBe(true);
    expect(decision.selfGrade).toBe('C');
    expect(decision.uncertainties).toContain('type-check failed');
    expect(decision.uncertainties).toContain('no tests run');
    expect(decision.needsUserInput).toBe(false);
    expect(decision.reason).toMatch(/grade C|accountability/i);
  });

  test('status=done with grade C and no gaps → still downgrades with synthetic reason', () => {
    const decision = decideCompletionTurn({
      status: 'done',
      selfAssessment: { grade: 'C' },
    });
    expect(decision.type).toBe('uncertain');
    expect(decision.downgradedFromGradeC).toBe(true);
    expect(decision.uncertainties?.length).toBeGreaterThan(0);
  });

  test('status=done WITHOUT selfAssessment → done turn but flagged as missing', () => {
    // Backward compat: existing agents may not yet emit selfAssessment.
    // We allow the done through but mark missingSelfAssessment so callers
    // can emit telemetry / nudge prompts.
    const decision = decideCompletionTurn({
      status: 'done',
      proposedContent: 'legacy completion',
    });
    expect(decision.type).toBe('done');
    expect(decision.missingSelfAssessment).toBe(true);
    expect(decision.selfGrade).toBeUndefined();
    expect(decision.downgradedFromGradeC).toBe(false);
  });

  test('status=uncertain ignores selfAssessment, preserves needsUserInput', () => {
    const decision = decideCompletionTurn({
      status: 'uncertain',
      summary: 'need user input',
      uncertainties: ['Which file?'],
      needsUserInput: true,
      selfAssessment: { grade: 'A' }, // ignored — agent already chose uncertain
    });
    expect(decision.type).toBe('uncertain');
    expect(decision.needsUserInput).toBe(true);
    expect(decision.uncertainties).toEqual(['Which file?']);
    expect(decision.downgradedFromGradeC).toBe(false);
  });

  test('grade C downgrade preserves any pre-existing uncertainties', () => {
    const decision = decideCompletionTurn({
      status: 'done',
      uncertainties: ['unrelated note'],
      selfAssessment: { grade: 'C', gaps: ['missing acceptance criterion 2'] },
    });
    expect(decision.type).toBe('uncertain');
    expect(decision.uncertainties).toEqual(
      expect.arrayContaining(['missing acceptance criterion 2', 'unrelated note']),
    );
  });

  test('invalid grade value → treated as no grade (backward compat)', () => {
    const decision = decideCompletionTurn({
      status: 'done',
      selfAssessment: { grade: 'invalid' },
    });
    expect(decision.type).toBe('done');
    expect(decision.selfGrade).toBeUndefined();
    expect(decision.missingSelfAssessment).toBe(true);
  });

  test('selfGaps preserved on done turn (slice 4 Gap B forwarding)', () => {
    const decision = decideCompletionTurn({
      status: 'done',
      selfAssessment: { grade: 'B', gaps: ['no integration test', 'docs todo'] },
    });
    expect(decision.type).toBe('done');
    expect(decision.selfGrade).toBe('B');
    expect(decision.selfGaps).toEqual(['no integration test', 'docs todo']);
  });

  test('selfGaps preserved on uncertain turn', () => {
    const decision = decideCompletionTurn({
      status: 'uncertain',
      selfAssessment: { grade: 'B', gaps: ['edge case unverified'] },
    });
    expect(decision.type).toBe('uncertain');
    expect(decision.selfGrade).toBe('B');
    expect(decision.selfGaps).toEqual(['edge case unverified']);
  });

  test('selfGaps defaults to [] when no gaps provided', () => {
    const decision = decideCompletionTurn({
      status: 'done',
      selfAssessment: { grade: 'A' },
    });
    expect(decision.selfGaps).toEqual([]);
  });
});
