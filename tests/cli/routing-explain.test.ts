/**
 * Tests for `vinyan routing-explain` CLI.
 *
 * Uses an injected trace provider so the tests don't touch the workspace
 * DB. Captures stdout/stderr via hooks to verify human vs JSON rendering.
 */

import { describe, expect, test } from 'bun:test';
import type { RoutingRecord, RoutingTraceProvider } from '../../src/api/routing-explain-endpoint.ts';
import { runRoutingExplainCommand } from '../../src/cli/routing-explain.ts';

interface Captured {
  stdout: string[];
  stderr: string[];
  exitCode?: number;
}

class ExitCalled extends Error {
  constructor(public readonly code: number) {
    super(`exit ${code}`);
  }
}

function makeCapture(): { cap: Captured; deps: ReturnType<typeof buildDeps> } {
  const cap: Captured = { stdout: [], stderr: [] };
  return {
    cap,
    deps: buildDeps(cap),
  };
}

function buildDeps(cap: Captured) {
  return {
    stdout: (c: string) => cap.stdout.push(c),
    stderr: (c: string) => cap.stderr.push(c),
    exit: ((code: number) => {
      cap.exitCode = code;
      throw new ExitCalled(code);
    }) as (code: number) => never,
  };
}

function makeRecord(taskId: string): RoutingRecord {
  return {
    taskId,
    decision: {
      level: 2,
      model: 'claude-sonnet',
      budgetTokens: 50_000,
      latencyBudgetMs: 90_000,
    },
    factors: {
      blastRadius: 20,
      dependencyDepth: 4,
      testCoverage: 0.6,
      fileVolatility: 8,
      irreversibility: 0.3,
      hasSecurityImplication: false,
      environmentType: 'development',
    },
  };
}

function makeProvider(records: Record<string, RoutingRecord>): RoutingTraceProvider {
  return {
    getRoutingRecord(id) {
      return records[id] ?? null;
    },
  };
}

describe('runRoutingExplainCommand', () => {
  test('human output contains the summary line', async () => {
    const { cap, deps } = makeCapture();
    const provider = makeProvider({ 'task-a': makeRecord('task-a') });
    try {
      await runRoutingExplainCommand(['task-a'], {
        deps: { ...deps, traceStore: provider },
      });
    } catch (e) {
      if (!(e instanceof ExitCalled)) throw e;
    }
    const out = cap.stdout.join('');
    expect(out).toContain('Task routed to L2');
    expect(out).toContain('factors (ranked)');
  });

  test('--json output is valid JSON parseable back to RoutingExplanation', async () => {
    const { cap, deps } = makeCapture();
    const provider = makeProvider({ 'task-b': makeRecord('task-b') });
    try {
      await runRoutingExplainCommand(['task-b', '--json'], {
        deps: { ...deps, traceStore: provider },
      });
    } catch (e) {
      if (!(e instanceof ExitCalled)) throw e;
    }
    const out = cap.stdout.join('').trim();
    const parsed = JSON.parse(out);
    expect(parsed.taskId).toBe('task-b');
    expect(parsed.level).toBe(2);
    expect(Array.isArray(parsed.factors)).toBe(true);
    expect(typeof parsed.summary).toBe('string');
  });

  test('missing task id → exit 2', async () => {
    const { cap, deps } = makeCapture();
    try {
      await runRoutingExplainCommand([], { deps });
    } catch (e) {
      if (!(e instanceof ExitCalled)) throw e;
    }
    expect(cap.exitCode).toBe(2);
    expect(cap.stderr.join('')).toMatch(/Usage:/);
  });

  test('not-found task → exit 1 with error message', async () => {
    const { cap, deps } = makeCapture();
    const provider = makeProvider({});
    try {
      await runRoutingExplainCommand(['task-missing'], {
        deps: { ...deps, traceStore: provider },
      });
    } catch (e) {
      if (!(e instanceof ExitCalled)) throw e;
    }
    expect(cap.exitCode).toBe(1);
    expect(cap.stderr.join('')).toContain('task-missing');
  });

  test('unknown flag → exit 2', async () => {
    const { cap, deps } = makeCapture();
    try {
      await runRoutingExplainCommand(['task-a', '--what'], { deps });
    } catch (e) {
      if (!(e instanceof ExitCalled)) throw e;
    }
    expect(cap.exitCode).toBe(2);
    expect(cap.stderr.join('')).toContain('Unknown flag');
  });
});
