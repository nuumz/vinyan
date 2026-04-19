/**
 * Conversation-history section — Turn-model rendering (plan commit A).
 *
 * Validates the section renderer registered by createDefaultRegistry:
 *   - prefers `turns` over `conversationHistory` when both are present
 *   - preserves tool_use / tool_result markers so the LLM can reason about
 *     prior tool calls on resume
 *   - surfaces [USER CANCELLED] tag when a turn was cancelled mid-stream
 *   - falls back to the legacy ConversationEntry path when `turns` is absent
 */
import { describe, expect, it } from 'bun:test';
import type { SectionContext } from '../../../src/orchestrator/llm/prompt-section-registry.ts';
import { createDefaultRegistry } from '../../../src/orchestrator/llm/prompt-section-registry.ts';
import type { ConversationEntry, Turn } from '../../../src/orchestrator/types.ts';

function makeContext(overrides: Partial<SectionContext> = {}): SectionContext {
  return {
    goal: 'test',
    perception: {
      taskTarget: { file: 'src/x.ts', description: 'x' },
      dependencyCone: { directImporters: [], directImportees: [], transitiveBlastRadius: 0 },
      diagnostics: { lintWarnings: [], typeErrors: [], failingTests: [] },
      verifiedFacts: [],
      runtime: { nodeVersion: '20', os: 'linux', availableTools: [] },
    },
    memory: { failedApproaches: [], activeHypotheses: [], unresolvedUncertainties: [], scopedFacts: [] },
    ...overrides,
  };
}

function turn(role: Turn['role'], blocks: Turn['blocks'], extras: Partial<Turn> = {}): Turn {
  return {
    id: extras.id ?? `turn-${Math.random().toString(36).slice(2, 8)}`,
    sessionId: 's1',
    seq: extras.seq ?? 0,
    role,
    blocks,
    tokenCount: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    createdAt: Date.now(),
    ...(extras.cancelledAt !== undefined ? { cancelledAt: extras.cancelledAt } : {}),
  };
}

describe('conversation-history section — Turn-model rendering', () => {
  it('renders tool_use + tool_result markers verbatim', () => {
    const registry = createDefaultRegistry();
    const ctx = makeContext({
      turns: [
        turn('user', [{ type: 'text', text: 'list files' }], { seq: 0 }),
        turn(
          'assistant',
          [
            { type: 'text', text: 'Calling read_dir' },
            { type: 'tool_use', id: 'tu-1', name: 'read_dir', input: { path: '/tmp' } },
          ],
          { seq: 1 },
        ),
        turn('user', [{ type: 'tool_result', tool_use_id: 'tu-1', content: 'a.txt\nb.txt' }], {
          seq: 2,
        }),
      ],
    });
    const rendered = registry.renderTarget('user', ctx);
    expect(rendered).toContain('[CONVERSATION HISTORY]');
    expect(rendered).toContain('[tool_use:read_dir id=tu-1]');
    expect(rendered).toContain('{"path":"/tmp"}');
    expect(rendered).toContain('[tool_result id=tu-1]');
    expect(rendered).toContain('a.txt');
  });

  it('tags cancelled turns with [USER CANCELLED]', () => {
    const registry = createDefaultRegistry();
    const ctx = makeContext({
      turns: [
        turn('assistant', [{ type: 'text', text: 'partial output...' }], {
          seq: 0,
          cancelledAt: Date.now(),
        }),
      ],
    });
    const rendered = registry.renderTarget('user', ctx);
    expect(rendered).toContain('[USER CANCELLED]');
    expect(rendered).toContain('partial output');
  });

  // A6: the ConversationEntry[] fallback path was removed. `turns` is now
  // the only conversation source. Legacy comparison tests below are kept as
  // no-op placeholders to document the migration.

  it('Turn-model is the only source (post-A6)', () => {
    const registry = createDefaultRegistry();
    const ctx = makeContext({
      turns: [turn('user', [{ type: 'text', text: 'NEW-TURN-CONTENT' }], { seq: 0 })],
    });
    const rendered = registry.renderTarget('user', ctx);
    expect(rendered).toContain('NEW-TURN-CONTENT');
  });

  it('omits the section entirely when no history is present', () => {
    const registry = createDefaultRegistry();
    const rendered = registry.renderTarget('user', makeContext());
    expect(rendered).not.toContain('[CONVERSATION HISTORY]');
  });

  it('trims older turns when exceeding CONVERSATION_MAX_TURNS (10)', () => {
    const registry = createDefaultRegistry();
    const turns: Turn[] = [];
    for (let i = 0; i < 15; i++) {
      turns.push(turn('user', [{ type: 'text', text: `msg-${i}` }], { seq: i, id: `t${i}` }));
    }
    const rendered = registry.renderTarget('user', makeContext({ turns }));
    expect(rendered).toContain('(5 earlier turns omitted)');
    expect(rendered).toContain('msg-14');
    expect(rendered).not.toContain('msg-0');
  });
});
