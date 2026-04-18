/**
 * TUI Chat view tests (PR #11) — read-only Agent Conversation viewer.
 *
 * Covers:
 *   - renderChat layout with empty state, sessions present, conversation
 *     present, and pending clarifications
 *   - wrapText word-wrapping (preserves \n, breaks on spaces, hard-wraps
 *     long words)
 *   - renderMessageBlock newest-at-bottom layout + scroll offset
 *   - 'chat' tab is registered in app.ts TABS metadata and ViewTab union
 */
import { describe, expect, test } from 'bun:test';
import {
  CHAT_PANEL_COUNT,
  renderChat,
  renderMessageBlock,
  renderStructuredClarifications,
  renderWorkflowPlan,
  wrapText,
} from '../../src/tui/views/chat.ts';
import { createInitialState } from '../../src/tui/state.ts';
import type { ChatMessageEntry, ChatSessionSummary, TUIState } from '../../src/tui/types.ts';

function makeState(overrides: Partial<TUIState> = {}): TUIState {
  const state = createInitialState('/tmp/test');
  state.termWidth = 120;
  state.termHeight = 40;
  state.activeTab = 'chat';
  return { ...state, ...overrides };
}

function makeSession(overrides: Partial<ChatSessionSummary> = {}): ChatSessionSummary {
  return {
    id: 'session-abcdefgh',
    source: 'cli',
    status: 'active',
    createdAt: Date.now(),
    messageCount: 0,
    ...overrides,
  };
}

function makeMessage(overrides: Partial<ChatMessageEntry> = {}): ChatMessageEntry {
  return {
    role: 'user',
    content: 'Hello, world!',
    timestamp: Date.now(),
    ...overrides,
  };
}

// ── Layout / structure ────────────────────────────────────────────

describe('renderChat — layout', () => {
  test('CHAT_PANEL_COUNT is 2 (sessions list + conversation)', () => {
    expect(CHAT_PANEL_COUNT).toBe(2);
  });

  test('empty state shows placeholder when no sessions exist', () => {
    const state = makeState();
    const out = renderChat(state);
    expect(out).toContain('no sessions');
    expect(out).toContain('vinyan chat');
  });

  test('renders the session list when sessions are present', () => {
    const sessions = [
      makeSession({ id: 'ses-aaa11111', messageCount: 5, status: 'active' }),
      makeSession({ id: 'ses-bbb22222', messageCount: 0, status: 'suspended' }),
    ];
    const state = makeState({
      chatSessions: sessions,
      chatActiveSessionId: 'ses-aaa11111',
    });
    const out = renderChat(state);
    // Both session short ids should appear
    expect(out).toContain('ses-aaa1');
    expect(out).toContain('ses-bbb2');
    // Status badges
    expect(out).toContain('active');
    expect(out).toContain('suspended');
    // Message count badge
    expect(out).toContain('5msg');
  });

  test('shows "Sessions (N)" count in the left panel title', () => {
    const sessions = [makeSession(), makeSession({ id: 'ses-xxx2' })];
    const state = makeState({ chatSessions: sessions });
    const out = renderChat(state);
    expect(out).toContain('Sessions (2)');
  });

  test('right pane shows "no active session" placeholder when chatActiveSessionId is null', () => {
    const state = makeState({ chatSessions: [] });
    const out = renderChat(state);
    expect(out).toContain('No active session');
  });

  test('right pane shows the conversation panel header with active session id (8-char prefix)', () => {
    const state = makeState({
      chatActiveSessionId: '12345678abcdef',
      chatConversation: [],
    });
    const out = renderChat(state);
    expect(out).toContain('Session: 12345678');
    expect(out).toContain('no messages yet');
  });

  test('renders user and assistant messages in the conversation pane', () => {
    const now = Date.now();
    const state = makeState({
      chatActiveSessionId: 'session-abcdefgh',
      chatConversation: [
        makeMessage({ role: 'user', content: 'rename the helper', timestamp: now - 60_000 }),
        makeMessage({
          role: 'assistant',
          content: 'I renamed src/helper.ts to src/util.ts',
          timestamp: now - 50_000,
        }),
      ],
    });
    const out = renderChat(state);
    expect(out).toContain('You');
    expect(out).toContain('Vinyan');
    expect(out).toContain('rename the helper');
    expect(out).toContain('renamed src/helper.ts to src/util.ts');
  });

  test('shows pending clarification banner when chatPendingClarifications is non-empty', () => {
    const state = makeState({
      chatActiveSessionId: 'session-pending',
      chatConversation: [],
      chatPendingClarifications: [
        'Which auth file should I edit — src/auth.ts or src/auth-v2.ts?',
        'Should the old name remain as an alias?',
      ],
    });
    const out = renderChat(state);
    expect(out).toContain('Waiting for clarification');
    expect(out).toContain('Which auth file');
    expect(out).toContain('old name remain as an alias');
  });

  test('Conversation header shows total message count', () => {
    const state = makeState({
      chatActiveSessionId: 'session-counts',
      chatConversation: [makeMessage(), makeMessage(), makeMessage()],
    });
    const out = renderChat(state);
    expect(out).toContain('Conversation (3)');
  });
});

// ── wrapText word-aware wrapping ──────────────────────────────────

describe('wrapText', () => {
  test('returns the input unchanged when shorter than width', () => {
    expect(wrapText('hello world', 50)).toEqual(['hello world']);
  });

  test('breaks on spaces when content exceeds width', () => {
    const out = wrapText('the quick brown fox jumps over the lazy dog', 15);
    expect(out.length).toBeGreaterThan(1);
    // Each line should be ≤ 15 chars
    for (const line of out) expect(line.length).toBeLessThanOrEqual(15);
    // All words should be present in the joined output
    expect(out.join(' ').replace(/\s+/g, ' ')).toContain('the quick brown fox');
  });

  test('preserves explicit \\n line breaks', () => {
    const out = wrapText('line one\nline two\n\nline four', 50);
    expect(out).toEqual(['line one', 'line two', '', 'line four']);
  });

  test('hard-breaks words longer than the wrap width', () => {
    const longWord = 'a'.repeat(40);
    const out = wrapText(longWord, 10);
    // 40 chars / 10 width = 4 chunks
    expect(out.length).toBe(4);
    expect(out.every((l) => l.length === 10)).toBe(true);
  });

  test('handles empty input', () => {
    expect(wrapText('', 10)).toEqual(['']);
  });
});

// ── renderMessageBlock layout ─────────────────────────────────────

describe('renderMessageBlock', () => {
  test('returns exactly maxRows lines, padded at the top when underflowed', () => {
    const messages: ChatMessageEntry[] = [
      makeMessage({ role: 'user', content: 'hi', timestamp: Date.now() }),
    ];
    const out = renderMessageBlock(messages, 60, 10, 0);
    expect(out).toHaveLength(10);
    // The last few lines should contain the message; the first lines
    // should be empty (top-padded so messages stick to the bottom).
    expect(out[0]).toBe('');
    expect(out.some((l) => l.includes('hi'))).toBe(true);
    expect(out.some((l) => l.includes('You'))).toBe(true);
  });

  test('shows newest messages by default (scroll=0)', () => {
    const messages: ChatMessageEntry[] = [];
    for (let i = 0; i < 5; i++) {
      messages.push(makeMessage({ role: 'user', content: `msg${i}`, timestamp: Date.now() - (5 - i) * 1000 }));
    }
    const out = renderMessageBlock(messages, 60, 30, 0);
    // The last user message should be visible
    expect(out.some((l) => l.includes('msg4'))).toBe(true);
  });

  test('returns empty array when maxRows is 0', () => {
    const messages: ChatMessageEntry[] = [makeMessage()];
    const out = renderMessageBlock(messages, 60, 0, 0);
    expect(out).toHaveLength(0);
  });
});

// ── State integration ─────────────────────────────────────────────

describe('chat state initialization', () => {
  test('createInitialState includes all chat fields', () => {
    const state = createInitialState('/tmp');
    expect(state.chatActiveSessionId).toBeNull();
    expect(state.chatConversation).toEqual([]);
    expect(state.chatPendingClarifications).toEqual([]);
    expect(state.chatStructuredClarifications).toEqual([]);
    expect(state.chatWorkflowPlan).toBeNull();
    expect(state.chatWorkflowStepStatus.size).toBe(0);
    expect(state.chatSessions).toEqual([]);
    expect(state.chatScroll).toBe(0);
  });
});

// ── Structured clarifications (Phase D) ─────────────────────────

describe('renderStructuredClarifications', () => {
  test('renders single-select options with numbered labels', () => {
    const out = renderStructuredClarifications(
      [
        {
          id: 'genre',
          prompt: 'อยากได้แนวเรื่องแบบไหน?',
          kind: 'single',
          options: [
            { id: 'a', label: 'โรแมนซ์' },
            { id: 'b', label: 'แอ็กชัน' },
          ],
          allowFreeText: true,
        },
      ],
      120,
    ).join('\n');
    expect(out).toContain('อยากได้แนวเรื่องแบบไหน');
    expect(out).toContain('(1)');
    expect(out).toContain('(2)');
    expect(out).toContain('โรแมนซ์');
  });

  test('renders multi-select options with checkbox brackets + cap hint', () => {
    const out = renderStructuredClarifications(
      [
        {
          id: 'tone',
          prompt: 'โทนเรื่อง?',
          kind: 'multi',
          options: [
            { id: 'x', label: 'ดราม่า' },
            { id: 'y', label: 'ตลก' },
          ],
          allowFreeText: true,
          maxSelections: 2,
        },
      ],
      120,
    ).join('\n');
    expect(out).toContain('[ ]');
    expect(out).toContain('ดราม่า');
    expect(out).toContain('เลือกได้สูงสุด 2');
  });

  test('free-text question renders a free-text hint only', () => {
    const out = renderStructuredClarifications(
      [
        {
          id: 'custom',
          prompt: 'รายละเอียดเพิ่มเติม?',
          kind: 'free',
          allowFreeText: true,
        },
      ],
      120,
    ).join('\n');
    expect(out).toContain('รายละเอียด');
    expect(out).toContain('free text');
    expect(out).not.toContain('(1)');
    expect(out).not.toContain('[ ]');
  });

  test('numbers the question blocks when multiple are present (Q1, Q2)', () => {
    const out = renderStructuredClarifications(
      [
        { id: 'a', prompt: 'first?', kind: 'free', allowFreeText: true },
        { id: 'b', prompt: 'second?', kind: 'free', allowFreeText: true },
      ],
      120,
    ).join('\n');
    expect(out).toContain('Q1');
    expect(out).toContain('Q2');
  });

  test('is surfaced by renderChat when chatStructuredClarifications is populated', () => {
    const state = makeState({
      chatActiveSessionId: 'session-abcdefgh',
      chatConversation: [],
      chatStructuredClarifications: [
        {
          id: 'audience',
          prompt: 'กลุ่มผู้อ่าน?',
          kind: 'single',
          options: [
            { id: 't', label: 'ทีน' },
            { id: 'a', label: 'ผู้ใหญ่' },
          ],
          allowFreeText: true,
        },
      ],
    });
    const out = renderChat(state);
    expect(out).toContain('Waiting for your input');
    expect(out).toContain('กลุ่มผู้อ่าน');
    expect(out).toContain('ทีน');
  });

  test('renderChat prefers structured questions over legacy strings', () => {
    const state = makeState({
      chatActiveSessionId: 'session-abcdefgh',
      chatPendingClarifications: ['LEGACY QUESTION'],
      chatStructuredClarifications: [
        { id: 'q', prompt: 'STRUCTURED QUESTION', kind: 'free', allowFreeText: true },
      ],
    });
    const out = renderChat(state);
    expect(out).toContain('STRUCTURED QUESTION');
    // Legacy banner not shown when structured is present.
    expect(out).toContain('Waiting for your input');
  });
});

// ── Workflow plan TODO checklist (Phase E) ─────────────────────

describe('renderWorkflowPlan', () => {
  const steps = [
    { id: 's1', description: 'Research trends', strategy: 'llm-reasoning', dependencies: [] },
    { id: 's2', description: 'Draft outline', strategy: 'llm-reasoning', dependencies: ['s1'] },
    { id: 's3', description: 'Write chapter 1', strategy: 'full-pipeline', dependencies: ['s2'] },
  ];

  test('renders a header with X/N done counter', () => {
    const status = new Map<string, 'pending' | 'in-progress' | 'completed' | 'failed'>([
      ['s1', 'completed'],
      ['s2', 'completed'],
      ['s3', 'pending'],
    ]);
    const out = renderWorkflowPlan(steps, status, 120).join('\n');
    expect(out).toContain('Workflow plan (2/3 done)');
    expect(out).toContain('Research trends');
    expect(out).toContain('[llm-reasoning]');
  });

  test('glyphs reflect per-step status (pending / in-progress / completed / failed)', () => {
    const status = new Map<string, 'pending' | 'in-progress' | 'completed' | 'failed'>([
      ['s1', 'completed'],
      ['s2', 'in-progress'],
      ['s3', 'failed'],
    ]);
    const out = renderWorkflowPlan(steps, status, 120).join('\n');
    expect(out).toContain('✓');
    expect(out).toContain('◉');
    expect(out).toContain('✗');
  });

  test('missing entries default to pending (○)', () => {
    const out = renderWorkflowPlan(steps, new Map(), 120).join('\n');
    expect(out).toContain('○');
    expect(out).toContain('0/3 done');
  });

  test('renderChat surfaces the plan below any clarification banner', () => {
    const state = makeState({
      chatActiveSessionId: 'session-abcdefgh',
      chatWorkflowPlan: {
        taskId: 'task-1',
        goal: 'Write a webtoon novel',
        steps,
      },
      chatWorkflowStepStatus: new Map([['s1', 'in-progress']]),
    });
    const out = renderChat(state);
    expect(out).toContain('Workflow plan');
    expect(out).toContain('Research trends');
  });
});
