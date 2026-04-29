import { describe, expect, test } from 'bun:test';
import {
  findResultBlocks,
  parseFinalResult,
  parseFinalResultWithDiagnosis,
} from '../../../src/orchestrator/external-coding-cli/external-coding-cli-result-parser.ts';
import { RESULT_CLOSE_TAG, RESULT_OPEN_TAG } from '../../../src/orchestrator/external-coding-cli/types.ts';

const validResult = {
  status: 'completed',
  providerId: 'claude-code',
  summary: 'Implemented feature X',
  changedFiles: ['src/foo.ts'],
  commandsRun: ['bun test'],
  testsRun: ['tests/foo.test.ts'],
  decisions: [],
  verification: { claimedPassed: true, details: '' },
  blockers: [],
  requiresHumanReview: false,
};

describe('coding-cli result parser', () => {
  test('finds zero blocks in plain text', () => {
    expect(findResultBlocks('hello world')).toEqual([]);
  });

  test('parses a single valid block', () => {
    const text = `prelude...\n${RESULT_OPEN_TAG}\n${JSON.stringify(validResult)}\n${RESULT_CLOSE_TAG}\nepilogue`;
    const result = parseFinalResult(text);
    expect(result?.status).toBe('completed');
    expect(result?.providerId).toBe('claude-code');
  });

  test('takes the LAST valid block when multiple are present', () => {
    const draft = { ...validResult, summary: 'draft' };
    const final = { ...validResult, summary: 'final' };
    const text = [
      `${RESULT_OPEN_TAG}${JSON.stringify(draft)}${RESULT_CLOSE_TAG}`,
      `${RESULT_OPEN_TAG}${JSON.stringify(final)}${RESULT_CLOSE_TAG}`,
    ].join('\n');
    const result = parseFinalResult(text);
    expect(result?.summary).toBe('final');
  });

  test('rejects provider id mismatch', () => {
    const text = `${RESULT_OPEN_TAG}${JSON.stringify(validResult)}${RESULT_CLOSE_TAG}`;
    const result = parseFinalResult(text, { expectedProviderId: 'github-copilot' });
    expect(result).toBeNull();
  });

  test('returns null when JSON is malformed and reports diagnosis', () => {
    const text = `${RESULT_OPEN_TAG}{not valid json${RESULT_CLOSE_TAG}`;
    const { result, diagnosis } = parseFinalResultWithDiagnosis(text);
    expect(result).toBeNull();
    expect(diagnosis.blocksFound).toBe(1);
    expect(diagnosis.lastError).toContain('JSON parse failed');
  });

  test('parses when "missing" fields have schema defaults', () => {
    const minimal = { status: 'completed', providerId: 'claude-code' };
    const text = `${RESULT_OPEN_TAG}${JSON.stringify(minimal)}${RESULT_CLOSE_TAG}`;
    const { result, diagnosis } = parseFinalResultWithDiagnosis(text);
    expect(result?.status).toBe('completed');
    expect(result?.changedFiles).toEqual([]);
    expect(diagnosis.blocksFound).toBe(1);
  });

  test('rejects bad enum on status', () => {
    const broken = { ...validResult, status: 'rocket-launched' };
    const text = `${RESULT_OPEN_TAG}${JSON.stringify(broken)}${RESULT_CLOSE_TAG}`;
    const result = parseFinalResult(text);
    expect(result).toBeNull();
  });

  test('handles unterminated block (no close tag) gracefully', () => {
    const text = `${RESULT_OPEN_TAG}${JSON.stringify(validResult)}`;
    expect(parseFinalResult(text)).toBeNull();
  });
});
