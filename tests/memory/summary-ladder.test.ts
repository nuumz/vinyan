/**
 * Summary ladder — rule-based compaction for dropped turns (plan commit E).
 */
import { describe, expect, it } from 'bun:test';
import { summarizeTurns } from '../../src/memory/summary-ladder.ts';
import type { Turn } from '../../src/orchestrator/types.ts';

let seq = 0;
function turn(opts: Partial<Turn>): Turn {
  return {
    id: opts.id ?? `t-${seq++}`,
    sessionId: opts.sessionId ?? 's',
    seq: opts.seq ?? seq++,
    role: opts.role ?? 'user',
    blocks: opts.blocks ?? [{ type: 'text', text: 'default' }],
    tokenCount: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    createdAt: opts.createdAt ?? Date.now(),
  };
}

describe('summarizeTurns', () => {
  it('returns null for empty input', () => {
    expect(summarizeTurns([])).toBeNull();
  });

  it('counts summarized turns', () => {
    const summary = summarizeTurns([
      turn({ role: 'user', blocks: [{ type: 'text', text: 'question A' }] }),
      turn({ role: 'assistant', blocks: [{ type: 'text', text: 'answer A' }] }),
      turn({ role: 'user', blocks: [{ type: 'text', text: 'question B' }] }),
    ]);
    expect(summary?.summarizedTurns).toBe(3);
    expect(summary?.text).toContain('3 prior turns compacted');
  });

  it('extracts file references via path regex', () => {
    const summary = summarizeTurns([
      turn({ role: 'user', blocks: [{ type: 'text', text: 'fix src/auth.ts and lib/utils.ts' }] }),
      turn({ role: 'assistant', blocks: [{ type: 'text', text: 'also touch config.json' }] }),
    ]);
    expect(summary?.filesDiscussed).toContain('src/auth.ts');
    expect(summary?.filesDiscussed).toContain('lib/utils.ts');
    expect(summary?.filesDiscussed).toContain('config.json');
  });

  it('caps filesDiscussed at 10 entries', () => {
    const files = Array.from({ length: 15 }, (_, i) => `file${i}.ts`).join(' ');
    const summary = summarizeTurns([turn({ role: 'user', blocks: [{ type: 'text', text: files }] })]);
    expect(summary?.filesDiscussed.length).toBeLessThanOrEqual(10);
  });

  it('topics come from user turn first lines (max 5 in output)', () => {
    const turns: Turn[] = [];
    for (let i = 0; i < 8; i++) {
      turns.push(
        turn({
          role: 'user',
          blocks: [{ type: 'text', text: `topic ${i} about a thing\nmore detail` }],
        }),
      );
    }
    const summary = summarizeTurns(turns);
    expect(summary?.text).toContain('Topics:');
    // First-line of each topic
    expect(summary?.text.split('Topics:')[1]).toBeDefined();
  });

  it('resolves INPUT-REQUIRED pairs into resolvedClarifications', () => {
    const summary = summarizeTurns([
      turn({
        role: 'assistant',
        blocks: [
          {
            type: 'text',
            text: 'preamble\n[INPUT-REQUIRED]\n- Which language?\n- Target Node version?',
          },
        ],
      }),
      turn({ role: 'user', blocks: [{ type: 'text', text: 'TypeScript, Node 22' }] }),
    ]);
    expect(summary?.resolvedClarifications).toHaveLength(2);
    expect(summary?.resolvedClarifications[0]?.question).toBe('Which language?');
    expect(summary?.resolvedClarifications[0]?.answer).toContain('TypeScript');
    expect(summary?.openClarifications).toHaveLength(0);
  });

  it('captures unresolved INPUT-REQUIRED as openClarifications', () => {
    const summary = summarizeTurns([
      turn({
        role: 'assistant',
        blocks: [{ type: 'text', text: '[INPUT-REQUIRED]\n- Still pending question' }],
      }),
      // No follow-up user turn
    ]);
    expect(summary?.openClarifications).toEqual(['Still pending question']);
    expect(summary?.resolvedClarifications).toHaveLength(0);
  });

  it('includes tool_use and tool_result blocks in file-ref scan', () => {
    const summary = summarizeTurns([
      turn({
        role: 'assistant',
        blocks: [
          { type: 'tool_use', id: 'tu-1', name: 'read_file', input: { path: 'src/world.ts' } },
          { type: 'tool_result', tool_use_id: 'tu-1', content: 'file contents of src/world.ts...' },
        ],
      }),
    ]);
    expect(summary?.filesDiscussed).toContain('src/world.ts');
  });

  it('text output includes [SESSION CONTEXT] framing', () => {
    const summary = summarizeTurns([turn({ role: 'user' })]);
    expect(summary?.text).toMatch(/^\[SESSION CONTEXT: 1 prior turns compacted\]/);
  });
});

// ── Phase 1 port: KEY-DECISION inline rendering ──────────────────────

describe('summarizeTurns — KEY-DECISION inline rendering (Phase 1 port)', () => {
  it('emits empty decisionLines when no turns match decision/clarification', () => {
    const summary = summarizeTurns([
      turn({ role: 'user', blocks: [{ type: 'text', text: 'hello' }] }),
      turn({ role: 'assistant', blocks: [{ type: 'text', text: 'hi there' }] }),
    ]);
    expect(summary?.decisionLines).toEqual([]);
    expect(summary?.text).not.toContain('→ [Turn');
  });

  it('mixed decision + clarification turns emit both lines in turn order', () => {
    const summary = summarizeTurns([
      turn({ role: 'user', blocks: [{ type: 'text', text: 'start a project' }] }),
      // Turn 2: assistant plan preamble → decision
      turn({
        role: 'assistant',
        blocks: [{ type: 'text', text: "I'll scaffold the repo first" }],
      }),
      turn({ role: 'user', blocks: [{ type: 'text', text: 'ok' }] }),
      // Turn 4: assistant [INPUT-REQUIRED] → clarification
      turn({
        role: 'assistant',
        blocks: [{ type: 'text', text: '[INPUT-REQUIRED]\n- which framework?' }],
      }),
    ]);
    expect(summary?.decisionLines).toHaveLength(2);
    expect(summary?.decisionLines[0]).toBe(
      "→ [Turn 2, decision] assistant: I'll scaffold the repo first",
    );
    expect(summary?.decisionLines[1]).toBe(
      '→ [Turn 4, clarification] assistant: [INPUT-REQUIRED]',
    );
    // Rendered into `text` after other sections
    expect(summary?.text).toContain('→ [Turn 2, decision]');
    expect(summary?.text).toContain('→ [Turn 4, clarification]');
  });

  it('precededByInputRequired chains the hint to the next user turn', () => {
    // Turn 1: assistant IR block. Turn 2: user reply — classified as
    // decision via the zero-regex shortcut.
    const summary = summarizeTurns([
      turn({
        role: 'assistant',
        blocks: [{ type: 'text', text: '[INPUT-REQUIRED]\n- pick A or B' }],
      }),
      turn({ role: 'user', blocks: [{ type: 'text', text: 'B' }] }),
    ]);
    // IR turn → clarification line. User reply → decision via hint.
    expect(summary?.decisionLines).toEqual([
      '→ [Turn 1, clarification] assistant: [INPUT-REQUIRED]',
      '→ [Turn 2, decision] user: B',
    ]);
  });

  it('truncates long text to 200 chars with … suffix', () => {
    const long = 'decision ' + 'x'.repeat(400);
    const summary = summarizeTurns([
      turn({
        role: 'assistant',
        blocks: [{ type: 'text', text: "I'll " + long }],
      }),
    ]);
    expect(summary?.decisionLines).toHaveLength(1);
    expect(summary?.decisionLines[0]).toMatch(/…$/);
    // Prefix `→ [Turn 1, decision] assistant: ` then ≤200 content chars
    const line = summary!.decisionLines[0]!;
    const colonIdx = line.indexOf(': ');
    const contentPart = line.slice(colonIdx + 2);
    expect(contentPart.length).toBeLessThanOrEqual(201); // 200 + trailing ellipsis
  });

  it('excludes tool_use / tool_result turns from decisionLines', () => {
    // Tool-carrying turns are classified as 'tool_result' and therefore
    // NOT rendered into decisionLines (plan: summary.text stays scannable).
    const summary = summarizeTurns([
      turn({
        role: 'assistant',
        blocks: [
          { type: 'text', text: "I'll read the file now" },
          { type: 'tool_use', id: 'tu-1', name: 'read_file', input: { path: 'a.ts' } },
        ],
      }),
      turn({
        role: 'user',
        blocks: [{ type: 'tool_result', tool_use_id: 'tu-1', content: '...' }],
      }),
    ]);
    expect(summary?.decisionLines).toEqual([]);
  });

  it('preserves turn-index order across non-decision gaps', () => {
    // Decisions at turns 2, 5, 8 — must render in that order regardless of
    // interleaving chit-chat turns.
    const summary = summarizeTurns([
      turn({ role: 'user', blocks: [{ type: 'text', text: 'chat 1' }] }),
      turn({ role: 'assistant', blocks: [{ type: 'text', text: "Plan: extract helper" }] }),
      turn({ role: 'user', blocks: [{ type: 'text', text: 'chat 2' }] }),
      turn({ role: 'assistant', blocks: [{ type: 'text', text: 'chat 3' }] }),
      turn({ role: 'assistant', blocks: [{ type: 'text', text: "Let me push this now" }] }),
      turn({ role: 'user', blocks: [{ type: 'text', text: 'chat 4' }] }),
      turn({ role: 'assistant', blocks: [{ type: 'text', text: 'chat 5' }] }),
      turn({ role: 'assistant', blocks: [{ type: 'text', text: 'Going to merge' }] }),
    ]);
    expect(summary?.decisionLines).toHaveLength(3);
    expect(summary?.decisionLines[0]).toContain('Turn 2');
    expect(summary?.decisionLines[1]).toContain('Turn 5');
    expect(summary?.decisionLines[2]).toContain('Turn 8');
  });
});
