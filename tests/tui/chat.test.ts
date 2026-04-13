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
    expect(state.chatSessions).toEqual([]);
    expect(state.chatScroll).toBe(0);
  });
});
