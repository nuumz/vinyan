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
