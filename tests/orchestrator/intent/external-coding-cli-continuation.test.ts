/**
 * Coding-CLI continuation pre-classifier — behavior tests.
 *
 * Mirrors the failure case from the screenshot at 2026-04-30:
 *   1. user1: "สั่งงาน claude-code cli ช่วยรัน verify flow ..."  (CLI delegation)
 *   2. user2: "full-pipeline"                                    (bare routing directive)
 *
 * Without this classifier, user2 falls through to the LLM workflow
 * planner which produces 7 llm-reasoning steps that *describe* running
 * claude-code commands but never invoke the CLI. With this classifier,
 * user2 re-issues user1's delegation through the deterministic external-
 * coding-cli dispatch.
 */
import { describe, expect, it } from 'bun:test';
import { detectCodingCliContinuation } from '../../../src/orchestrator/intent/external-coding-cli-continuation.ts';
import type { Turn } from '../../../src/orchestrator/types.ts';

function userTurn(seq: number, text: string): Turn {
  return {
    id: `u${seq}`,
    sessionId: 's1',
    seq,
    role: 'user',
    blocks: [{ type: 'text', text }],
    tokenCount: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    createdAt: Date.now(),
  };
}

function assistantTurn(seq: number, text: string): Turn {
  return {
    id: `a${seq}`,
    sessionId: 's1',
    seq,
    role: 'assistant',
    blocks: [{ type: 'text', text }],
    tokenCount: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    createdAt: Date.now(),
  };
}

describe('detectCodingCliContinuation — positive matches', () => {
  it('matches the screenshot case: "full-pipeline" after Thai CLI delegation', () => {
    const turns: Turn[] = [
      userTurn(0, 'สั่งงาน claude-code cli ช่วยรัน verify flow เปิดบัญชีกองทุน `/Users/phumin.k/appl/Docs/s1_design_spec`'),
      assistantTurn(1, 'Task timed out after 280s.'),
    ];
    const out = detectCodingCliContinuation({ goal: 'full-pipeline', turns });
    expect(out.matched).toBe(true);
    expect(out.reconstructed?.providerId).toBe('claude-code');
    expect(out.reconstructed?.targetPaths).toContain(
      '/Users/phumin.k/appl/Docs/s1_design_spec',
    );
    expect(out.reconstructedFromTurnSeq).toBe(0);
  });

  it('matches "retry" after CLI delegation', () => {
    const turns: Turn[] = [
      userTurn(0, 'ask claude code cli to refactor src/foo.ts'),
      assistantTurn(1, 'Failed.'),
    ];
    const out = detectCodingCliContinuation({ goal: 'retry', turns });
    expect(out.matched).toBe(true);
    expect(out.reconstructed?.providerId).toBe('claude-code');
  });

  it('matches Thai "ลองใหม่" after CLI delegation', () => {
    const turns: Turn[] = [
      userTurn(0, 'ใช้ claude code cli ทำ unit test'),
      assistantTurn(1, 'ผิดพลาด'),
    ];
    const out = detectCodingCliContinuation({ goal: 'ลองใหม่', turns });
    expect(out.matched).toBe(true);
  });

  it('matches "agentic-workflow" alias', () => {
    const turns: Turn[] = [
      userTurn(0, 'ask claude code to help with this'),
      assistantTurn(1, 'failed'),
    ];
    const out = detectCodingCliContinuation({ goal: 'agentic-workflow', turns });
    expect(out.matched).toBe(true);
  });

  it('skips bare-directive user turns to find the original delegation', () => {
    // First the user delegated; then bounced through retries; the
    // continuation must reach back to the ORIGINAL delegation, not the
    // most recent retry directive.
    const turns: Turn[] = [
      userTurn(0, 'use claude code cli on /tmp/spec.md'),
      assistantTurn(1, 'failed'),
      userTurn(2, 'retry'),
      assistantTurn(3, 'failed'),
    ];
    const out = detectCodingCliContinuation({ goal: 'full-pipeline', turns });
    expect(out.matched).toBe(true);
    expect(out.reconstructedFromTurnSeq).toBe(0);
    expect(out.reconstructed?.targetPaths).toContain('/tmp/spec.md');
  });
});

describe('detectCodingCliContinuation — negative matches', () => {
  it('does NOT match without a prior CLI delegation in history', () => {
    const turns: Turn[] = [
      userTurn(0, 'write me a poem'),
      assistantTurn(1, 'roses are red...'),
    ];
    const out = detectCodingCliContinuation({ goal: 'retry', turns });
    expect(out.matched).toBe(false);
  });

  it('does NOT match when goal has additional context', () => {
    const turns: Turn[] = [
      userTurn(0, 'ask claude code to refactor src/foo.ts'),
      assistantTurn(1, 'failed'),
    ];
    // Rich text is left to the LLM tier — the continuation classifier is
    // tight by design.
    const out = detectCodingCliContinuation({
      goal: 'retry but use copilot instead',
      turns,
    });
    expect(out.matched).toBe(false);
  });

  it('does NOT match with empty turn history', () => {
    const out = detectCodingCliContinuation({ goal: 'full-pipeline', turns: [] });
    expect(out.matched).toBe(false);
  });

  it('does NOT match when prior user turn was not a delegation', () => {
    const turns: Turn[] = [
      userTurn(0, 'list files in /tmp'),
      assistantTurn(1, 'failed'),
    ];
    const out = detectCodingCliContinuation({ goal: 'retry', turns });
    expect(out.matched).toBe(false);
  });
});
