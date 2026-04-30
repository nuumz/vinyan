/**
 * Result fallback chain — behavior tests.
 *
 * Three layers, in order of preference:
 *   1. Literal CODING_CLI_RESULT marker scan on raw stdout.
 *   2. Stream-json envelope scan: look inside `{"type":"result","result":"<text>"}`
 *      lines (where the assistant text has been de-escaped by JSON.parse).
 *   3. Synthesized partial claim from session state (filesChanged, commands,
 *      assistant text) — only when exit was clean.
 *
 * The tests target ClaudeCodeAdapter.parseFinalResult directly because the
 * stream-json envelope handling is provider-specific.
 */
import { describe, expect, test } from 'bun:test';
import { ClaudeCodeAdapter } from '../../../src/orchestrator/external-coding-cli/providers/claude-code-adapter.ts';
import {
  RESULT_CLOSE_TAG,
  RESULT_OPEN_TAG,
} from '../../../src/orchestrator/external-coding-cli/types.ts';

function block(json: object): string {
  return `${RESULT_OPEN_TAG}\n${JSON.stringify(json)}\n${RESULT_CLOSE_TAG}`;
}

describe('ClaudeCodeAdapter.parseFinalResult — fallback chain', () => {
  test('layer 1: literal marker scan on raw stdout (plain text)', () => {
    const adapter = new ClaudeCodeAdapter();
    const stdout = `working...\n${block({
      status: 'completed',
      providerId: 'claude-code',
      summary: 'plain text emission',
      changedFiles: ['src/foo.ts'],
      commandsRun: [],
      testsRun: [],
      decisions: [],
      verification: { claimedPassed: true, details: '' },
      blockers: [],
      requiresHumanReview: false,
    })}\n`;
    const out = adapter.parseFinalResult(stdout);
    expect(out).not.toBeNull();
    expect(out?.summary).toBe('plain text emission');
    expect(out?.changedFiles).toEqual(['src/foo.ts']);
  });

  test('layer 2: stream-json envelope (assistant text JSON-encoded)', () => {
    const adapter = new ClaudeCodeAdapter();
    // Realistic stream-json: each line is a JSON object. The final
    // `result` line contains the assistant's full text — including the
    // CODING_CLI_RESULT block — as a *string*. JSON encoding escapes
    // newlines to \n and quotes to \", which is why a literal-marker
    // scan on the raw stdout finds the markers but JSON.parse on the
    // body fails.
    const innerText = `Done.\n\n${block({
      status: 'completed',
      providerId: 'claude-code',
      summary: 'inside stream-json envelope',
      changedFiles: ['src/bar.ts'],
      commandsRun: [],
      testsRun: [],
      decisions: [],
      verification: { claimedPassed: true, details: '' },
      blockers: [],
      requiresHumanReview: false,
    })}`;
    const lines = [
      JSON.stringify({ type: 'system', session_id: 'sess-1' }),
      JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Working...' }] },
      }),
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: innerText,
        session_id: 'sess-1',
      }),
    ].join('\n');
    const out = adapter.parseFinalResult(lines);
    expect(out).not.toBeNull();
    expect(out?.summary).toBe('inside stream-json envelope');
    expect(out?.changedFiles).toEqual(['src/bar.ts']);
  });

  test('layer 2: stream-json with NO CODING_CLI_RESULT block returns null', () => {
    // Synthesis is the controller's job, not the adapter's. The adapter
    // returns null and lets the controller decide whether to synthesize.
    const adapter = new ClaudeCodeAdapter();
    const lines = [
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: 'I have completed the analysis. The flow looks correct.',
        session_id: 'sess-1',
      }),
    ].join('\n');
    expect(adapter.parseFinalResult(lines)).toBeNull();
  });

  test('rejects provider id mismatch (A6 — CLI cannot lie about its own id)', () => {
    const adapter = new ClaudeCodeAdapter();
    const stdout = block({
      status: 'completed',
      providerId: 'github-copilot', // wrong
      summary: 'lying about provider',
      changedFiles: [],
      commandsRun: [],
      testsRun: [],
      decisions: [],
      verification: { claimedPassed: true, details: '' },
      blockers: [],
      requiresHumanReview: false,
    });
    expect(adapter.parseFinalResult(stdout)).toBeNull();
  });

  test('layer 2: takes the LAST result line when multiple are emitted', () => {
    const adapter = new ClaudeCodeAdapter();
    const oldClaim = block({
      status: 'partial',
      providerId: 'claude-code',
      summary: 'draft',
      changedFiles: [],
      commandsRun: [],
      testsRun: [],
      decisions: [],
      verification: { claimedPassed: false, details: '' },
      blockers: [],
      requiresHumanReview: false,
    });
    const finalClaim = block({
      status: 'completed',
      providerId: 'claude-code',
      summary: 'final revision',
      changedFiles: [],
      commandsRun: [],
      testsRun: [],
      decisions: [],
      verification: { claimedPassed: true, details: '' },
      blockers: [],
      requiresHumanReview: false,
    });
    const lines = [
      JSON.stringify({ type: 'result', is_error: false, result: `early draft\n${oldClaim}` }),
      JSON.stringify({ type: 'result', is_error: false, result: `revised\n${finalClaim}` }),
    ].join('\n');
    const out = adapter.parseFinalResult(lines);
    expect(out?.summary).toBe('final revision');
  });
});
