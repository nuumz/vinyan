/**
 * SessionManager — Turn dual-write (plan commit A5).
 *
 * Verifies that:
 *   - recordUserTurn writes to both session_messages AND session_turns
 *   - recordAssistantTurn mirrors mutations as tool_use blocks in session_turns
 *   - thinking is emitted as a distinct thinking block when present
 *   - getTurnsHistory returns newest-N turns in chronological order
 *   - pre-existing compaction path (getConversationHistoryCompacted) still
 *     reads from the legacy session_messages table without regression
 */
import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { SessionManager } from '../../src/api/session-manager.ts';
import { ALL_MIGRATIONS, MigrationRunner } from '../../src/db/migrations/index.ts';
import { SessionStore } from '../../src/db/session-store.ts';
import type { TaskResult } from '../../src/orchestrator/types.ts';

let db: Database;
let store: SessionStore;
let manager: SessionManager;

beforeEach(() => {
  db = new Database(':memory:');
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  new MigrationRunner().migrate(db, ALL_MIGRATIONS);
  store = new SessionStore(db);
  manager = new SessionManager(store);
});

afterEach(() => {
  db.close();
});

function result(opts: Partial<TaskResult> & { id: string; status: TaskResult['status'] }): TaskResult {
  return {
    id: opts.id,
    status: opts.status,
    mutations: opts.mutations ?? [],
    trace: opts.trace ?? {
      id: `trace-${opts.id}`,
      taskId: opts.id,
      timestamp: Date.now(),
      routingLevel: 1,
      taskTypeSignature: 'test::ts',
      approach: 'direct',
      modelUsed: 'mock',
      tokensConsumed: 100,
      durationMs: 50,
      toolCallCount: 0,
      outcome: 'success',
    } as unknown as TaskResult['trace'],
    answer: opts.answer,
    thinking: opts.thinking,
  };
}

describe('SessionManager — Turn dual-write (A5)', () => {
  it('recordUserTurn dual-writes to session_messages and session_turns', () => {
    const session = manager.create('cli');
    manager.recordUserTurn(session.id, 'hello from user');

    const legacy = store.getMessages(session.id);
    expect(legacy).toHaveLength(1);
    expect(legacy[0]!.role).toBe('user');
    expect(legacy[0]!.content).toBe('hello from user');

    const turns = store.getTurns(session.id);
    expect(turns).toHaveLength(1);
    expect(turns[0]!.role).toBe('user');
    expect(turns[0]!.blocks).toEqual([{ type: 'text', text: 'hello from user' }]);
  });

  it('recordAssistantTurn emits mutations as tool_use blocks in session_turns', () => {
    const session = manager.create('cli');
    manager.recordUserTurn(session.id, 'refactor auth');
    manager.recordAssistantTurn(
      session.id,
      'task-1',
      result({
        id: 'task-1',
        status: 'completed',
        answer: 'Done.',
        mutations: [
          { file: 'src/auth.ts', diff: '+a', oracleVerdicts: {} },
          { file: 'src/api.ts', diff: '+b', oracleVerdicts: {} },
        ],
      }),
    );

    const turns = store.getTurns(session.id);
    expect(turns).toHaveLength(2);
    const assistant = turns[1]!;
    expect(assistant.role).toBe('assistant');
    expect(assistant.taskId).toBe('task-1');

    const toolUses = assistant.blocks.filter((b) => b.type === 'tool_use');
    expect(toolUses).toHaveLength(2);
    expect(toolUses[0]).toMatchObject({
      type: 'tool_use',
      name: 'write_file',
      input: { path: 'src/auth.ts', diff: '+a' },
    });
    expect(toolUses[1]).toMatchObject({
      type: 'tool_use',
      name: 'write_file',
      input: { path: 'src/api.ts', diff: '+b' },
    });
  });

  it('emits a thinking block when result.thinking is present', () => {
    const session = manager.create('cli');
    manager.recordAssistantTurn(
      session.id,
      'task-2',
      result({
        id: 'task-2',
        status: 'completed',
        answer: 'The answer is 42.',
        thinking: 'Running the calculation step-by-step...',
      }),
    );

    const turns = store.getTurns(session.id);
    const thinking = turns[0]!.blocks.find((b) => b.type === 'thinking');
    expect(thinking).toEqual({
      type: 'thinking',
      thinking: 'Running the calculation step-by-step...',
    });

    // Thinking must precede text per Anthropic-native ordering
    const firstBlock = turns[0]!.blocks[0];
    expect(firstBlock?.type).toBe('thinking');
  });

  it('getTurnsHistory returns newest-N turns in chronological order', () => {
    const session = manager.create('cli');
    for (let i = 0; i < 5; i++) {
      manager.recordUserTurn(session.id, `msg ${i}`);
    }
    const recent = manager.getTurnsHistory(session.id, 3);
    expect(recent).toHaveLength(3);
    expect(recent.map((t) => {
      const first = t.blocks[0];
      return first && first.type === 'text' ? first.text : '';
    })).toEqual(['msg 2', 'msg 3', 'msg 4']);
  });

  it('legacy getConversationHistoryCompacted still works (no regression)', () => {
    const session = manager.create('cli');
    manager.recordUserTurn(session.id, 'user says hi');
    manager.recordAssistantTurn(
      session.id,
      'task-legacy',
      result({ id: 'task-legacy', status: 'completed', answer: 'assistant replies' }),
    );
    const legacy = manager.getConversationHistoryCompacted(session.id, 1000);
    expect(legacy).toHaveLength(2);
    expect(legacy[0]!.content).toBe('user says hi');
    expect(legacy[1]!.content).toBe('assistant replies');
  });
});
