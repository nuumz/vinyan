import { describe, expect, test } from 'bun:test';
import type { HMSConfig } from '../../src/hms/hms-config.ts';
import {
  analyzeForHallucinations,
  overconfidenceToFeedback,
  refutedClaimToFailure,
} from '../../src/hms/hms-feedback.ts';

const DEFAULT_CONFIG: HMSConfig = {
  enabled: true,
  grounding: { enabled: true, max_claims: 20 },
  overconfidence: { enabled: true, threshold: 0.6 },
  cross_validation: { enabled: false, max_probes_per_claim: 3, max_claims: 5, probe_budget_tokens: 1000 },
  risk_weights: { grounding: 0.35, overconfidence: 0.15, structural: 0.25, critic: 0.15, cross_validation: 0.1 },
};

describe('refutedClaimToFailure', () => {
  test('file_reference → hallucination_file', () => {
    const failure = refutedClaimToFailure({
      type: 'file_reference',
      value: 'src/fake/nonexistent.ts',
      source_line: 5,
      reason: 'File not found',
    });
    expect(failure.category).toBe('hallucination_file');
    expect(failure.file).toBe('src/fake/nonexistent.ts');
    expect(failure.message).toBe('File not found');
    expect(failure.suggestedFix).toContain('PERCEPTION');
  });

  test('import_claim → hallucination_import', () => {
    const failure = refutedClaimToFailure({
      type: 'import_claim',
      value: '@vinyan/fake/module',
      source_line: 3,
      reason: 'Import not found',
    });
    expect(failure.category).toBe('hallucination_import');
    expect(failure.suggestedFix).toContain('dependency cone');
  });

  test('fake_tool_call → hallucination_tool_call with severity error', () => {
    const failure = refutedClaimToFailure({
      type: 'fake_tool_call',
      value: '<function_calls>',
      source_line: 1,
      reason: 'Hallucinated tool call syntax',
    });
    expect(failure.category).toBe('hallucination_tool_call');
    expect(failure.severity).toBe('error');
    expect(failure.suggestedFix).toContain('proposedToolCalls');
  });
});

describe('overconfidenceToFeedback', () => {
  test('below threshold → no feedback', () => {
    const result = overconfidenceToFeedback(
      { certainty_markers: 0, hedging_absence: false, universal_claims: 0, false_precision: 0, score: 0.3 },
      0.6,
    );
    expect(result.failure).toBeUndefined();
    expect(result.uncertainty).toBeUndefined();
  });

  test('above threshold → failure + uncertainty', () => {
    const result = overconfidenceToFeedback(
      { certainty_markers: 5, hedging_absence: true, universal_claims: 3, false_precision: 0, score: 0.8 },
      0.6,
    );
    expect(result.failure).toBeDefined();
    expect(result.failure!.category).toBe('overconfidence');
    expect(result.uncertainty).toBeDefined();
    expect(result.uncertainty!.area).toContain('overconfidence');
  });
});

describe('analyzeForHallucinations', () => {
  test('returns null for empty output', () => {
    const result = analyzeForHallucinations({ proposedContent: '', mutations: [] }, '.', DEFAULT_CONFIG);
    expect(result).toBeNull();
  });

  test('detects refuted file references', () => {
    const result = analyzeForHallucinations(
      {
        proposedContent: 'Edit src/nonexistent/fake-file.ts for the fix.',
        mutations: [],
      },
      process.cwd(),
      DEFAULT_CONFIG,
    );
    expect(result).not.toBeNull();
    const fileFailures = result!.classifiedFailures.filter((f) => f.category === 'hallucination_file');
    expect(fileFailures.length).toBeGreaterThanOrEqual(1);
  });

  test('generates uncertainties for refuted claims', () => {
    const result = analyzeForHallucinations(
      {
        proposedContent: 'Edit src/totally/made-up.ts to fix the auth bug.',
        mutations: [],
      },
      process.cwd(),
      DEFAULT_CONFIG,
    );
    expect(result).not.toBeNull();
    expect(result!.uncertainties.length).toBeGreaterThanOrEqual(1);
    expect(result!.uncertainties[0]!.area).toContain('refuted');
  });

  test('detects fake tool calls', () => {
    const result = analyzeForHallucinations(
      {
        proposedContent: 'Here is the fix:\n<function_calls>\n<invoke name="write">',
        mutations: [],
      },
      process.cwd(),
      DEFAULT_CONFIG,
    );
    expect(result).not.toBeNull();
    const toolCallFailures = result!.classifiedFailures.filter((f) => f.category === 'hallucination_tool_call');
    expect(toolCallFailures.length).toBeGreaterThanOrEqual(1);
  });

  test('returns null when all claims verified', () => {
    const result = analyzeForHallucinations(
      {
        proposedContent: 'Edit package.json to update the version.',
        mutations: [],
      },
      process.cwd(),
      DEFAULT_CONFIG,
    );
    // package.json exists → verified → no failures
    expect(result).toBeNull();
  });

  test('respects disabled grounding config', () => {
    const config = { ...DEFAULT_CONFIG, grounding: { enabled: false, max_claims: 20 } };
    const result = analyzeForHallucinations(
      { proposedContent: 'Edit src/fake.ts', mutations: [] },
      process.cwd(),
      config,
    );
    // Grounding disabled → no file checks → might return null
    // (depends on overconfidence — short text won't trigger)
    expect(result === null || result.classifiedFailures.every((f) => f.category !== 'hallucination_file')).toBe(true);
  });

  test('includes risk score in result', () => {
    const result = analyzeForHallucinations(
      { proposedContent: 'Edit src/fake/nonexistent.ts for the fix.', mutations: [] },
      process.cwd(),
      DEFAULT_CONFIG,
    );
    expect(result).not.toBeNull();
    expect(result!.risk.score).toBeGreaterThan(0);
  });
});
