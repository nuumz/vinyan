/**
 * Tests for UserInterestMiner — live aggregation from TraceStore + SessionStore.
 */
import { describe, expect, test } from 'bun:test';
import type { SessionStore } from '../../../src/db/session-store.ts';
import type { Turn } from '../../../src/orchestrator/types.ts';
import type { TraceStore } from '../../../src/db/trace-store.ts';
import type { ExecutionTrace } from '../../../src/orchestrator/types.ts';
import {
  formatUserContextForPrompt,
  UserInterestMiner,
} from '../../../src/orchestrator/user-context/user-interest-miner.ts';
import { EMPTY_SNAPSHOT, isEmpty } from '../../../src/orchestrator/user-context/types.ts';

// ---------------------------------------------------------------------------
// Stubs
// ---------------------------------------------------------------------------

function makeTrace(overrides: Partial<ExecutionTrace>): ExecutionTrace {
  return {
    id: overrides.id ?? crypto.randomUUID(),
    taskId: overrides.taskId ?? 'task-x',
    timestamp: overrides.timestamp ?? Date.now(),
    routingLevel: overrides.routingLevel ?? 1,
    approach: overrides.approach ?? 'test-approach',
    oracleVerdicts: overrides.oracleVerdicts ?? {},
    modelUsed: overrides.modelUsed ?? 'mock',
    tokensConsumed: overrides.tokensConsumed ?? 0,
    durationMs: overrides.durationMs ?? 0,
    outcome: overrides.outcome ?? 'success',
    affectedFiles: overrides.affectedFiles ?? [],
    taskTypeSignature: overrides.taskTypeSignature,
    ...overrides,
  } as ExecutionTrace;
}

function stubTraceStore(traces: ExecutionTrace[]): TraceStore {
  const sorted = [...traces].sort((a, b) => b.timestamp - a.timestamp);
  // Only a handful of methods are called by the miner; stub those.
  return {
    findRecent: (limit = 50) => sorted.slice(0, limit),
  } as unknown as TraceStore;
}

function msg(sessionId: string, role: 'user' | 'assistant', content: string, createdAt: number): Turn {
  return {
    id: `${sessionId}-${createdAt}-${Math.random().toString(36).slice(2, 6)}`,
    sessionId,
    seq: 0,
    role,
    blocks: [{ type: 'text', text: content }],
    tokenCount: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    createdAt,
  };
}

function stubSessionStore(turnsBySession: Record<string, Turn[]>): SessionStore {
  return {
    getRecentTurns: (sessionId: string, _n: number) => turnsBySession[sessionId] ?? [],
  } as unknown as SessionStore;
}

// ---------------------------------------------------------------------------
// Cold-start / empty
// ---------------------------------------------------------------------------

describe('UserInterestMiner (cold start)', () => {
  test('returns empty snapshot when no stores are provided', () => {
    const miner = new UserInterestMiner({});
    const snapshot = miner.mine();
    expect(isEmpty(snapshot)).toBe(true);
    expect(snapshot.totalTracesInWindow).toBe(0);
    expect(snapshot.lastActiveAt).toBeNull();
  });

  test('returns empty snapshot when TraceStore has no traces', () => {
    const miner = new UserInterestMiner({ traceStore: stubTraceStore([]) });
    const snapshot = miner.mine();
    expect(isEmpty(snapshot)).toBe(true);
  });

  test('isEmpty detects no signal across all fields', () => {
    expect(isEmpty(EMPTY_SNAPSHOT)).toBe(true);
    expect(
      isEmpty({
        frequentTaskTypes: [{ signature: 'fix::ts::small', count: 1 }],
        recentKeywords: [],
        recentDomains: [],
        totalTracesInWindow: 1,
        lastActiveAt: Date.now(),
      }),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Task-type aggregation
// ---------------------------------------------------------------------------

describe('UserInterestMiner (task-type aggregation)', () => {
  test('aggregates task-type signatures by frequency within lookback window', () => {
    const now = Date.now();
    const traces = [
      ...Array.from({ length: 6 }, () =>
        makeTrace({ taskTypeSignature: 'write::essay::medium', timestamp: now - 1000 }),
      ),
      ...Array.from({ length: 3 }, () =>
        makeTrace({ taskTypeSignature: 'fix::ts::small', timestamp: now - 2000 }),
      ),
      makeTrace({ taskTypeSignature: 'refactor::py::medium', timestamp: now - 5000 }),
    ];
    const miner = new UserInterestMiner({ traceStore: stubTraceStore(traces), now: () => now });
    const snapshot = miner.mine();

    expect(snapshot.frequentTaskTypes).toHaveLength(3);
    expect(snapshot.frequentTaskTypes[0]!.signature).toBe('write::essay::medium');
    expect(snapshot.frequentTaskTypes[0]!.count).toBe(6);
    expect(snapshot.frequentTaskTypes[1]!.signature).toBe('fix::ts::small');
    expect(snapshot.totalTracesInWindow).toBe(10);
    expect(snapshot.lastActiveAt).toBe(now - 1000);
  });

  test('respects maxTaskTypes limit', () => {
    const now = Date.now();
    const traces = Array.from({ length: 10 }, (_, i) =>
      makeTrace({ taskTypeSignature: `type-${i}`, timestamp: now - i * 1000 }),
    );
    const miner = new UserInterestMiner({ traceStore: stubTraceStore(traces), now: () => now });
    const snapshot = miner.mine({ maxTaskTypes: 3 });

    expect(snapshot.frequentTaskTypes).toHaveLength(3);
  });

  test('filters out traces older than the lookback window', () => {
    const now = Date.now();
    const thirtyOneDaysAgo = now - 31 * 86_400_000;
    const traces = [
      makeTrace({ taskTypeSignature: 'recent', timestamp: now - 1000 }),
      makeTrace({ taskTypeSignature: 'old', timestamp: thirtyOneDaysAgo }),
    ];
    const miner = new UserInterestMiner({ traceStore: stubTraceStore(traces), now: () => now });
    const snapshot = miner.mine({ lookbackDays: 30 });

    expect(snapshot.frequentTaskTypes.map((t) => t.signature)).toEqual(['recent']);
  });

  test('derives coarse domain labels from signatures', () => {
    const now = Date.now();
    const traces = [
      makeTrace({ taskTypeSignature: 'write::story::long', timestamp: now - 1000 }),
      makeTrace({ taskTypeSignature: 'fix::ts::small', timestamp: now - 2000 }),
      makeTrace({ taskTypeSignature: 'refactor::py::medium', timestamp: now - 3000 }),
    ];
    const miner = new UserInterestMiner({ traceStore: stubTraceStore(traces), now: () => now });
    const snapshot = miner.mine();

    expect(snapshot.recentDomains).toContain('creative-writing');
    expect(snapshot.recentDomains).toContain('code-mutation');
  });
});

// ---------------------------------------------------------------------------
// Session keyword extraction
// ---------------------------------------------------------------------------

describe('UserInterestMiner (session keywords)', () => {
  test('extracts frequent keywords from user messages and drops stop words', () => {
    const now = Date.now();
    const sessionId = 'sess-1';
    const messages = [
      msg(sessionId, 'user', 'I want to write a romance novel for webtoon', now - 5000),
      msg(sessionId, 'user', 'Continue the novel with a romance subplot', now - 2000),
      msg(sessionId, 'assistant', 'Here is an outline with characters', now - 1000),
    ];
    const miner = new UserInterestMiner({
      sessionStore: stubSessionStore({ [sessionId]: messages }),
      now: () => now,
    });
    const snapshot = miner.mine({ sessionId });

    const terms = snapshot.recentKeywords.map((k) => k.term);
    expect(terms).toContain('novel');
    expect(terms).toContain('romance');
    expect(terms).toContain('webtoon');
    // Stop words must be excluded.
    expect(terms).not.toContain('want');
    expect(terms).not.toContain('the');
    // Assistant messages must be ignored.
    expect(terms).not.toContain('outline');
  });

  test('returns no keywords when sessionId is missing', () => {
    const miner = new UserInterestMiner({
      sessionStore: stubSessionStore({}),
    });
    expect(miner.mine().recentKeywords).toEqual([]);
  });

  test('respects minKeywordLen', () => {
    const now = Date.now();
    const sessionId = 's';
    const messages = [
      msg(sessionId, 'user', 'ab webtoon cd novel', now - 1000),
    ];
    const miner = new UserInterestMiner({
      sessionStore: stubSessionStore({ [sessionId]: messages }),
      now: () => now,
    });
    const snapshot = miner.mine({ sessionId, minKeywordLen: 4 });

    const terms = snapshot.recentKeywords.map((k) => k.term);
    expect(terms).toContain('webtoon');
    expect(terms).toContain('novel');
    expect(terms).not.toContain('ab');
    expect(terms).not.toContain('cd');
  });
});

// ---------------------------------------------------------------------------
// Caching
// ---------------------------------------------------------------------------

describe('UserInterestMiner (cache)', () => {
  test('cached snapshots are returned within TTL', () => {
    const now = Date.now();
    let callCount = 0;
    const traceStore = {
      findRecent: () => {
        callCount++;
        return [];
      },
    } as unknown as TraceStore;
    let currentTime = now;
    const miner = new UserInterestMiner({ traceStore, now: () => currentTime });

    miner.mine({ sessionId: 'a' });
    miner.mine({ sessionId: 'a' });
    miner.mine({ sessionId: 'a' });
    const firstBatch = callCount;

    currentTime += 70_000; // advance beyond 60s TTL
    miner.mine({ sessionId: 'a' });

    expect(firstBatch).toBeGreaterThan(0);
    // Three cached calls should make at most `firstBatch` calls; a fourth
    // beyond TTL should increase it.
    expect(callCount).toBeGreaterThan(firstBatch);
  });

  test('invalidate() clears cache and forces recompute', () => {
    const now = Date.now();
    let callCount = 0;
    const traceStore = {
      findRecent: () => {
        callCount++;
        return [];
      },
    } as unknown as TraceStore;
    const miner = new UserInterestMiner({ traceStore, now: () => now });

    miner.mine({ sessionId: 'a' });
    const before = callCount;
    miner.invalidate('a');
    miner.mine({ sessionId: 'a' });
    expect(callCount).toBeGreaterThan(before);
  });
});

// ---------------------------------------------------------------------------
// formatUserContextForPrompt
// ---------------------------------------------------------------------------

describe('formatUserContextForPrompt', () => {
  test('returns empty string for cold-start snapshots', () => {
    expect(formatUserContextForPrompt(EMPTY_SNAPSHOT)).toBe('');
  });

  test('renders task types, domains, and keywords when present', () => {
    const rendered = formatUserContextForPrompt({
      frequentTaskTypes: [
        { signature: 'write::essay::medium', count: 6 },
        { signature: 'fix::ts::small', count: 3 },
      ],
      recentKeywords: [
        { term: 'novel', frequency: 4 },
        { term: 'romance', frequency: 2 },
      ],
      recentDomains: ['creative-writing', 'code-mutation'],
      totalTracesInWindow: 9,
      lastActiveAt: Date.now(),
    });

    expect(rendered).toContain('User context (learned from past activity)');
    expect(rendered).toContain('write::essay::medium (6)');
    expect(rendered).toContain('creative-writing');
    expect(rendered).toContain('novel');
  });
});
