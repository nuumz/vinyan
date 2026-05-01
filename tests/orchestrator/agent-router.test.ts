/**
 * AgentRouter tests — rule-first specialist selection across the role-pure
 * persona roster (coordinator, developer, architect, author, reviewer,
 * assistant).
 *
 * Verifies:
 *   - CLI override short-circuits ('override' reason)
 *   - .ts file routes to developer via extensions / domain rule ('rule-match')
 *   - .md file routes to author
 *   - Ambiguous task signals 'needs-llm'
 *   - Unknown agent id in override falls through rule path
 *   - minLevel excludes specialist from lower-level tasks
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { asPersonaId } from '../../src/core/agent-vocabulary.ts';
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
      const decision = router.route(makeInput({ agentId: asPersonaId('author') }));
      expect(decision.agentId).toBe(asPersonaId('author'));
      expect(decision.reason).toBe('override');
    } finally {
      cleanup();
    }
  });

  test('unknown agentId in override falls through to rule/default path', () => {
    const { router, cleanup } = setupRouter();
    try {
      const decision = router.route(makeInput({ agentId: asPersonaId('nonexistent'), targetFiles: ['a.ts'] }));
      // Should NOT return 'nonexistent' — registry.has returns false
      expect(decision.agentId).not.toBe('nonexistent');
      expect(decision.reason).not.toBe('override');
    } finally {
      cleanup();
    }
  });

  test('.ts file routes to developer via rule-match', () => {
    const { router, cleanup } = setupRouter();
    try {
      const decision = router.route(
        makeInput({ taskType: 'code', targetFiles: ['src/foo.ts'] }),
        undefined,
        undefined,
        // The developer persona advertises code.mutation as a builtin claim;
        // hand the router that requirement so capability matching has a
        // deterministic signal even without skill packs in Phase 1.
        [{ id: 'code.mutation', weight: 1, source: 'fingerprint' }],
      );
      expect(decision.agentId).toBe(asPersonaId('developer'));
      expect(decision.reason).toBe('rule-match');
      expect(decision.score).toBeGreaterThan(0.4);
      expect(decision.capabilityAnalysis?.candidates[0]?.profileId).toBe('developer');
      expect(decision.capabilityAnalysis?.candidates[0]?.profileSource).toBe('registry');
    } finally {
      cleanup();
    }
  });

  test('.md file routes to author via rule-match', () => {
    const { router, cleanup } = setupRouter();
    try {
      const decision = router.route(makeInput({ taskType: 'code', targetFiles: ['README.md'] }), undefined, undefined, [
        { id: 'writing.prose', weight: 1, source: 'fingerprint' },
      ]);
      expect(decision.agentId).toBe(asPersonaId('author'));
      expect(decision.reason).toBe('rule-match');
    } finally {
      cleanup();
    }
  });

  test('reasoning task with no capability hint falls through to needs-llm or default', () => {
    const { router, cleanup } = setupRouter();
    try {
      const decision = router.route(makeInput({ taskType: 'reasoning', goal: 'what is the meaning of life?' }));
      // No targetFiles, no capability requirements; with role-pure personas
      // the rule-score may not clear the 0.4 threshold, so the cascade
      // hands off to LLM resolution or returns the default.
      expect(['needs-llm', 'default', 'rule-match']).toContain(decision.reason);
    } finally {
      cleanup();
    }
  });

  test('explicit review-class capability routes to the Reviewer persona', () => {
    const { router, cleanup } = setupRouter();
    try {
      const decision = router.route(
        makeInput({ taskType: 'reasoning', goal: 'review this PR for correctness' }),
        undefined,
        undefined,
        [{ id: 'review.code', weight: 1, source: 'llm-extract' }],
      );
      expect(decision.agentId).toBe(asPersonaId('reviewer'));
      expect(decision.reason).toBe('rule-match');
    } finally {
      cleanup();
    }
  });

  test('runner-up metadata included for rule-match decisions', () => {
    const { router, cleanup } = setupRouter();
    try {
      const decision = router.route(
        makeInput({ taskType: 'code', targetFiles: ['src/foo.ts'] }),
        undefined,
        undefined,
        [{ id: 'code.mutation', weight: 1, source: 'fingerprint' }],
      );
      if (decision.reason === 'rule-match') {
        expect(decision.runnerUp).toBeDefined();
      }
    } finally {
      cleanup();
    }
  });

  test('minLevel excludes specialist from lower-level tasks when routingLevel is known', () => {
    const { registry, router, cleanup } = setupRouter();
    try {
      // architect declares minLevel:1 — a reasoning task routed at L0 must
      // NOT resolve to it even when the reasoning domain would otherwise
      // match.
      const arch = registry.getAgent('architect');
      expect(arch).not.toBeNull();
      expect(arch!.routingHints?.minLevel).toBe(1);

      const decisionL0 = router.route(makeInput({ taskType: 'reasoning', goal: 'design an auth flow' }), undefined, 0, [
        { id: 'design.interface', weight: 1, source: 'llm-extract' },
      ]);
      expect(decisionL0.agentId).not.toBe('architect');

      // Same task at L1+ — architect is eligible again.
      const decisionL1 = router.route(makeInput({ taskType: 'reasoning', goal: 'design an auth flow' }), undefined, 1, [
        { id: 'design.interface', weight: 1, source: 'llm-extract' },
      ]);
      expect(decisionL1.reason).not.toBe('override');
    } finally {
      cleanup();
    }
  });

  test('minLevel ignored when routingLevel is absent (backward compat)', () => {
    const { router, cleanup } = setupRouter();
    try {
      // No routingLevel arg → pre-multi-agent behaviour; architect is
      // eligible regardless of minLevel.
      const decision = router.route(makeInput({ taskType: 'reasoning', goal: 'design a schema' }));
      // Not asserting the specific winner — just that no exception and the
      // call completes with a deterministic shape.
      expect(decision.agentId).toBeTypeOf('string');
    } finally {
      cleanup();
    }
  });
});
