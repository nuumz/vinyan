/**
 * AgentRouter tests — rule-first specialist selection.
 *
 * Verifies:
 *   - CLI override short-circuits ('override' reason)
 *   - .ts file routes to ts-coder via extensions rule ('rule-match')
 *   - .md file routes to writer
 *   - Ambiguous task (no file, reasoning) signals 'needs-llm'
 *   - Unknown agent id in override falls through rule path
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentRouter } from '../../src/orchestrator/agent-router.ts';
import { loadAgentRegistry } from '../../src/orchestrator/agents/registry.ts';
import type { TaskInput } from '../../src/orchestrator/types.ts';

function makeInput(overrides?: Partial<TaskInput>): TaskInput {
  return {
    id: 'task-router',
    source: 'cli',
    goal: 'test',
    taskType: 'code',
    budget: { maxTokens: 1000, maxDurationMs: 10_000, maxRetries: 1 },
    ...overrides,
  };
}

function setupRouter() {
  const workspace = mkdtempSync(join(tmpdir(), 'vinyan-router-'));
  const registry = loadAgentRegistry(workspace, undefined);
  const router = createAgentRouter({ registry });
  return { workspace, registry, router, cleanup: () => rmSync(workspace, { recursive: true, force: true }) };
}

describe('AgentRouter', () => {
  test('CLI override short-circuits with reason=override', () => {
    const { router, cleanup } = setupRouter();
    try {
      const decision = router.route(makeInput({ agentId: 'writer' }));
      expect(decision.agentId).toBe('writer');
      expect(decision.reason).toBe('override');
    } finally {
      cleanup();
    }
  });

  test('unknown agentId in override falls through to rule/default path', () => {
    const { router, cleanup } = setupRouter();
    try {
      const decision = router.route(makeInput({ agentId: 'nonexistent', targetFiles: ['a.ts'] }));
      // Should NOT return 'nonexistent' — registry.has returns false
      expect(decision.agentId).not.toBe('nonexistent');
      expect(decision.reason).not.toBe('override');
    } finally {
      cleanup();
    }
  });

  test('.ts file routes to ts-coder via rule-match', () => {
    const { router, cleanup } = setupRouter();
    try {
      const decision = router.route(
        makeInput({ taskType: 'code', targetFiles: ['src/foo.ts'] }),
      );
      expect(decision.agentId).toBe('ts-coder');
      expect(decision.reason).toBe('rule-match');
      expect(decision.score).toBeGreaterThan(0.4);
    } finally {
      cleanup();
    }
  });

  test('.md file routes to writer via rule-match', () => {
    const { router, cleanup } = setupRouter();
    try {
      const decision = router.route(
        makeInput({ taskType: 'code', targetFiles: ['README.md'] }),
      );
      expect(decision.agentId).toBe('writer');
      expect(decision.reason).toBe('rule-match');
    } finally {
      cleanup();
    }
  });

  test('ambiguous task (no file, reasoning) signals needs-llm', () => {
    const { router, cleanup } = setupRouter();
    try {
      const decision = router.route(
        makeInput({ taskType: 'reasoning', goal: 'what is the meaning of life?' }),
      );
      // No file → no extension signal; reasoning domain could match multiple
      expect(decision.reason).toBe('needs-llm');
    } finally {
      cleanup();
    }
  });

  test('runner-up metadata included for rule-match decisions', () => {
    const { router, cleanup } = setupRouter();
    try {
      const decision = router.route(
        makeInput({ taskType: 'code', targetFiles: ['src/foo.ts'] }),
      );
      // With 4 built-ins, runner-up should exist
      if (decision.reason === 'rule-match') {
        expect(decision.runnerUp).toBeDefined();
      }
    } finally {
      cleanup();
    }
  });
});
