/**
 * registerSessionSearchTool — idempotent registry install.
 */
import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { migration001 } from '../../../src/db/migrations/001_initial_schema.ts';
import { MigrationRunner } from '../../../src/db/migrations/migration-runner.ts';
import { registerSessionSearchTool } from '../../../src/orchestrator/tools/register-session-search.ts';
import type { Tool } from '../../../src/orchestrator/tools/tool-interface.ts';

function freshDb(): Database {
  const db = new Database(':memory:');
  const runner = new MigrationRunner();
  runner.migrate(db, [migration001]);
  return db;
}

describe('registerSessionSearchTool', () => {
  test('installs session_search on a Map registry', () => {
    const registry = new Map<string, Tool>();
    registerSessionSearchTool({ toolRegistry: registry, deps: { db: freshDb() } });
    expect(registry.has('session_search')).toBe(true);
    const tool = registry.get('session_search');
    expect(tool?.name).toBe('session_search');
    expect(tool?.category).toBe('search');
  });

  test('second call overwrites the prior entry (idempotent)', () => {
    const registry = new Map<string, Tool>();
    const deps1 = { db: freshDb() };
    const deps2 = { db: freshDb() };
    registerSessionSearchTool({ toolRegistry: registry, deps: deps1 });
    const first = registry.get('session_search');
    registerSessionSearchTool({ toolRegistry: registry, deps: deps2 });
    const second = registry.get('session_search');
    expect(registry.size).toBe(1);
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    // Different factory invocations → different Tool objects.
    expect(first).not.toBe(second);
  });

  test('does not install any unrelated tool names', () => {
    const registry = new Map<string, Tool>();
    registerSessionSearchTool({ toolRegistry: registry, deps: { db: freshDb() } });
    // Only session_search should be mounted.
    expect([...registry.keys()]).toEqual(['session_search']);
  });
});
