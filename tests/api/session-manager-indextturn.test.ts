/**
 * SessionManager — ContextRetriever indexTurn hook (plan commit E4).
 *
 * Verifies:
 *   - recordUserTurn fires retriever.indexTurn exactly once
 *   - recordAssistantTurn fires retriever.indexTurn exactly once
 *   - retriever is optional — SessionManager without one is regression-free
 *   - indexTurn failures are swallowed (conversation persistence is not lost)
 *   - the Turn handed to indexTurn matches the persisted Turn (same id, blocks)
 */
import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { SessionManager } from '../../src/api/session-manager.ts';
import { ALL_MIGRATIONS, MigrationRunner } from '../../src/db/migrations/index.ts';
import { SessionStore } from '../../src/db/session-store.ts';
import type { ContextRetriever } from '../../src/memory/retrieval.ts';
import type { TaskResult, Turn } from '../../src/orchestrator/types.ts';

/**
 * Minimal ContextRetriever stub — records every indexTurn call + lets each
 * test verify what SessionManager passed in.
 */
class StubRetriever {
  readonly indexedTurns: Turn[] = [];
  indexTurnMock: (turn: Turn) => Promise<void> = async (turn) => {
    this.indexedTurns.push(turn);
  };
  async indexTurn(turn: Turn): Promise<void> {
    return this.indexTurnMock(turn);
  }
  // Unused by E4 but required to match the interface.
  async retrieve(): Promise<never> {
    throw new Error('retrieve not exercised in E4 tests');
  }
}

let db: Database;
let store: SessionStore;
let stub: StubRetriever;
let manager: SessionManager;

beforeEach(() => {
  db = new Database(':memory:');
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  new MigrationRunner().migrate(db, ALL_MIGRATIONS);
  store = new SessionStore(db);
  stub = new StubRetriever();
  manager = new SessionManager(store, undefined, stub as unknown as ContextRetriever);
});

afterEach(() => {
  db.close();
});

function makeResult(id: string, answer: string): TaskResult {
  return {
    id,
    status: 'completed',
    mutations: [],
    trace: {
      id: `trace-${id}`,
      taskId: id,
      timestamp: Date.now(),
      routingLevel: 1,
      taskTypeSignature: 'test::ts',
      approach: 'direct',
      modelUsed: 'mock',
      tokensConsumed: 42,
      durationMs: 50,
      toolCallCount: 0,
      outcome: 'success',
    } as unknown as TaskResult['trace'],
    answer,
  };
}

async function tick(): Promise<void> {
  // Flush the microtask queue so fire-and-forget indexTurn lands.
  await Promise.resolve();
  await Promise.resolve();
}

describe('SessionManager — retriever.indexTurn hook (E4)', () => {
  it('invokes indexTurn once per recordUserTurn', async () => {
    const session = manager.create('cli');
    manager.recordUserTurn(session.id, 'hello world');
    await tick();
    expect(stub.indexedTurns).toHaveLength(1);
    expect(stub.indexedTurns[0]!.role).toBe('user');
    expect(stub.indexedTurns[0]!.blocks).toEqual([{ type: 'text', text: 'hello world' }]);
  });

  it('invokes indexTurn once per recordAssistantTurn', async () => {
    const session = manager.create('cli');
    manager.recordAssistantTurn(session.id, 'task-1', makeResult('task-1', 'done'));
    await tick();
    expect(stub.indexedTurns).toHaveLength(1);
    expect(stub.indexedTurns[0]!.role).toBe('assistant');
    expect(stub.indexedTurns[0]!.taskId).toBe('task-1');
  });

  it('indexed Turn matches the persisted Turn (same id, same blocks)', async () => {
    const session = manager.create('cli');
    manager.recordUserTurn(session.id, 'q');
    await tick();
    const persisted = store.getTurns(session.id);
    expect(persisted).toHaveLength(1);
    expect(stub.indexedTurns[0]!.id).toBe(persisted[0]!.id);
  });

  it('user + assistant turns in one session produce two indexTurn calls', async () => {
    const session = manager.create('cli');
    manager.recordUserTurn(session.id, 'q');
    manager.recordAssistantTurn(session.id, 't1', makeResult('t1', 'a'));
    await tick();
    expect(stub.indexedTurns).toHaveLength(2);
    expect(stub.indexedTurns.map((t) => t.role)).toEqual(['user', 'assistant']);
  });

  it('swallows indexTurn rejections so conversation persistence is not lost', async () => {
    stub.indexTurnMock = async () => {
      throw new Error('embedding provider down');
    };
    const session = manager.create('cli');
    // Must not throw — the retriever failure is best-effort.
    manager.recordUserTurn(session.id, 'q');
    await tick();
    // The turn was still persisted despite the index failure.
    expect(store.getTurns(session.id)).toHaveLength(1);
  });

  it('is a no-op when SessionManager has no retriever wired', async () => {
    const plainManager = new SessionManager(store);
    const session = plainManager.create('cli');
    plainManager.recordUserTurn(session.id, 'q');
    await tick();
    // Stub from beforeEach was bound to the other manager — it never saw this
    // call because no retriever was passed to plainManager.
    expect(stub.indexedTurns).toHaveLength(0);
  });

  it('getContextRetriever returns the wired retriever', () => {
    expect(manager.getContextRetriever()).toBe(stub as unknown as ContextRetriever);
  });

  it('getContextRetriever returns undefined when no retriever wired', () => {
    const plain = new SessionManager(store);
    expect(plain.getContextRetriever()).toBeUndefined();
  });
});
